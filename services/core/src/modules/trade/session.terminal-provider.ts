/**
 * C1 终态判定 provider（B2 reaper 的关联实体终态判定通道，W1 前置⑤落位）：
 * ref_type='session' → 本 provider，onModuleInit 注册到 TerminalStateRegistry（重复注册抛错）。
 *
 * **批量形态 isTerminalBatch（本批优先实现）**：reaper 每轮对每 ref_type 至多一次批量调用
 * （防逐行 N+1——量级触发线：活跃锁上万且走逐行回退即成 N+1，B2 §10 契约）；reaper 按
 * `provider.isTerminalBatch` 存在性选择批量路径，本 provider 恒定义该方法=不走逐行回退。
 *
 * 终态集=FAILED/CANCELLED/FINISHED/SETTLED（「该 session 不再需要占用锁」口径——FULL..HOLD
 * 仍需占用段位，FINISHED 起履约结束释放；since=status_since 列，V23 头注③）。
 * 韧性（TerminalStateProvider 契约）：单实体异常/缺行吞为 null（宁漏不误杀）；批量整体失败
 * 可抛——reaper 按 ref_type 隔离跳过并计 skipped_errored（毒 provider 不炸整轮）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PgPoolService } from '../../infrastructure/sql';
import { TerminalStateRegistry } from '../schedule/slot-lock.terminal-registry';
import type { EntityTerminalInfo, TerminalStateProvider } from '../schedule/slot-lock.types';
import { SESSION_TERMINAL_STATUSES } from './session.machine';

@Injectable()
export class SessionTerminalProvider implements TerminalStateProvider, OnModuleInit {
  constructor(
    private readonly pool: PgPoolService,
    private readonly registry: TerminalStateRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('session', this);
  }

  /** 单实体形态（契约必选）：批量实现代理；异常吞为 null（宁漏不误杀） */
  async isTerminal(refId: number): Promise<EntityTerminalInfo | null> {
    try {
      return (await this.isTerminalBatch([refId])).get(refId) ?? null;
    } catch {
      return null;
    }
  }

  /** 批量形态（本批优先实现）：一次 ANY 查询替代逐行 N+1；缺实体不进 Map（reaper 视同 null 跳过） */
  async isTerminalBatch(refIds: number[]): Promise<Map<number, EntityTerminalInfo | null>> {
    const infos = new Map<number, EntityTerminalInfo | null>();
    const ids = [...new Set(refIds)].filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return infos;
    const res = await this.pool.query<{ id: string; status: string; status_since: Date }>(
      `SELECT id::text AS id, status, status_since FROM trade.sessions WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    for (const row of res.rows) {
      const terminal = (SESSION_TERMINAL_STATUSES as readonly string[]).includes(row.status);
      infos.set(Number(row.id), {
        terminal,
        since: terminal ? new Date(row.status_since) : null,
      });
    }
    return infos;
  }
}
