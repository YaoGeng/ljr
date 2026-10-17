/**
 * B2 锁域资损巡检检测件（H4 巡检第②类；M1-W4 Task 1）。owner=schedule（slot-locks 同 owner
 * schema）；实体终态核对经 TerminalStateRegistry 注册表（session/groupbuy isTerminalBatch
 * provider，B2 reaper 消费同款）——禁跨 schema join。
 *
 * 架构 §7.2 ②：活跃锁 >24h 或锁与实体状态不一致。三谓词（⚠裁决，报告注明——「活跃锁 >24h」
 * 字面若锚 created_at 会对未来场次段位的合法 LOCKED 锁假阳，故锚段位时刻）：
 *   a) SLOT_PAST        活跃锁且 slot_start < now()-窗（段位开始已过窗仍未释放——履约资源泄漏）；
 *   b) TTL_PAST         PENDING_PAYMENT 锁且 ttl_at < now()-窗（TTL job+reaper 双防线失效残留）；
 *   c) ENTITY_TERMINAL  关联实体已终态且终态迁移超窗仍活跃（reaper 失效——同窗避免与 reaper
 *      正常工作集（staleMs=15min）竞态误报；24h 窗内属 reaper 修复面，巡检不重复告警）。
 * 时钟锚=DB 钟（取 now() 一次作基准，谓词全在其上计算；A3b R-03 双钟教训）。c) 的 since 为
 * DB 存值（V23/V24 status_since），与 DB 取时比较=同源时钟。
 * 缺 provider 的 ref_type（如 reschedule，C5=M2）跳过计数不误报（宁漏不误杀，reaper 同口径）。
 */
import { Injectable } from '@nestjs/common';
import { PgPoolService } from '../../infrastructure/sql';
import { TerminalStateRegistry } from './slot-lock.terminal-registry';
import type { EntityTerminalInfo, TerminalStateProvider } from './slot-lock.types';
import { SLOT_LOCK_REF_TYPES } from './slot-lock.types';

/** 无批量形态 provider 的逐行回退（reaper resolveTerminalInfos 同款契约） */
async function resolvePerRow(
  provider: TerminalStateProvider,
  refIds: number[],
): Promise<Map<number, EntityTerminalInfo | null>> {
  const map = new Map<number, EntityTerminalInfo | null>();
  for (const refId of refIds) map.set(refId, await provider.isTerminal(refId));
  return map;
}

/** ②违例行（一把锁至多一条 finding，reasons 为命中谓词集合） */
export interface StaleLockViolation {
  readonly lockId: number;
  readonly lawyerId: number;
  readonly status: string;
  readonly refType: string;
  readonly refId: number;
  readonly slotStart: string;
  readonly createdAt: string;
  readonly reasons: readonly ('SLOT_PAST' | 'TTL_PAST' | 'ENTITY_TERMINAL')[];
}

export interface StaleLockScanResult {
  /** 活跃锁扫描行数（观测位） */
  readonly checked: number;
  /** 缺 provider 注册被跳过的行数（漏放方向暴露，不静默） */
  readonly skippedNoProvider: number;
  readonly violations: readonly StaleLockViolation[];
}

interface ActiveLockRow {
  readonly id: string;
  readonly lawyer_id: string;
  readonly slot_start: Date;
  readonly ttl_at: Date | null;
  readonly status: string;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly created_at: Date;
}

@Injectable()
export class SlotLockPatrolService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly terminals: TerminalStateRegistry,
  ) {}

  /** 活跃锁全量扫描（V1 活跃锁 ≤万级预算；量级增长后补 created_at 部分索引，reaper 同注记） */
  async findStaleLocks(options: {
    readonly windowMs: number;
    readonly limit?: number;
  }): Promise<StaleLockScanResult> {
    const limit = options.limit ?? 1000;
    const clock = await this.pool.query<{ at: Date }>(`SELECT now() AS at`);
    const dbNow = new Date(clock.rows[0]!.at).getTime();
    const cutoff = dbNow - options.windowMs;
    const active = await this.pool.query<ActiveLockRow>(
      `SELECT id, lawyer_id, slot_start, ttl_at, status, ref_type, ref_id, created_at
         FROM schedule.slot_locks
        WHERE status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED')
        ORDER BY id
        LIMIT $1`,
      [limit],
    );

    // c) 实体终态批量判定（每 ref_type 至多一次批量调用，防逐行 N+1；无批量形态回退逐行
    //    isTerminal——reaper resolveTerminalInfos 同款契约；毒 provider 跳过计数不炸轮）
    const terminalSinceByLock = new Map<number, Date>();
    let skippedNoProvider = 0;
    const byRefType = new Map<string, ActiveLockRow[]>();
    for (const row of active.rows) {
      const list = byRefType.get(row.ref_type) ?? [];
      list.push(row);
      byRefType.set(row.ref_type, list);
    }
    for (const refType of SLOT_LOCK_REF_TYPES) {
      const rows = byRefType.get(refType);
      if (rows === undefined || rows.length === 0) continue;
      const provider = this.terminals.get(refType);
      if (!provider) {
        skippedNoProvider += rows.length;
        continue;
      }
      const refIds = rows.map((r) => Number(r.ref_id));
      let infos: Map<number, EntityTerminalInfo | null>;
      try {
        infos = provider.isTerminalBatch
          ? await provider.isTerminalBatch(refIds)
          : await resolvePerRow(provider, refIds);
      } catch {
        skippedNoProvider += rows.length; // 毒 provider：跳过计数不炸轮（宁漏不误杀）
        continue;
      }
      for (const row of rows) {
        const info = infos.get(Number(row.ref_id));
        if (info?.terminal && info.since !== null) {
          terminalSinceByLock.set(Number(row.id), new Date(info.since));
        }
      }
    }

    const violations: StaleLockViolation[] = [];
    for (const row of active.rows) {
      const lockId = Number(row.id);
      const reasons: StaleLockViolation['reasons'][number][] = [];
      if (new Date(row.slot_start).getTime() < cutoff) reasons.push('SLOT_PAST');
      if (
        row.status === 'PENDING_PAYMENT' &&
        row.ttl_at !== null &&
        new Date(row.ttl_at).getTime() < cutoff
      ) {
        reasons.push('TTL_PAST');
      }
      const since = terminalSinceByLock.get(lockId);
      if (since !== undefined && since.getTime() < cutoff) reasons.push('ENTITY_TERMINAL');
      if (reasons.length > 0) {
        violations.push({
          lockId,
          lawyerId: Number(row.lawyer_id),
          status: row.status,
          refType: row.ref_type,
          refId: Number(row.ref_id),
          slotStart: new Date(row.slot_start).toISOString(),
          createdAt: new Date(row.created_at).toISOString(),
          reasons,
        });
      }
    }
    return { checked: active.rows.length, skippedNoProvider, violations };
  }
}
