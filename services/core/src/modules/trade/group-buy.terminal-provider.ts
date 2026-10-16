/**
 * C2 终态判定 provider（B2 reaper 的关联实体终态判定通道）：ref_type='groupbuy' → 本 provider，
 * onModuleInit 注册到 TerminalStateRegistry（重复注册抛错；session.terminal-provider 同形态）。
 *
 * **批量形态 isTerminalBatch**：reaper 每轮对每 ref_type 至多一次批量调用（防逐行 N+1，B2 §10
 * 契约）；reaper 按 provider.isTerminalBatch 存在性选择批量路径，本 provider 恒定义该方法。
 *
 * 终态集=EXPIRED/REJECTED/REFUNDED/CONVERTED（「该 group_buy 不再需要占用锁」口径——
 * PUBLISHED/REACHED/PENDING_LAWYER/CONFIRMED 仍需占用段位；EXPIRED/REJECTED 的锁在业务终态
 * 迁移同事务释放，REFUNDED/CONVERTED 为机终态；since=status_since 列，V24 头注③）。
 * 韧性（TerminalStateProvider 契约）：单实体异常/缺行吞为 null（宁漏不误杀）；批量整体失败
 * 可抛——reaper 按 ref_type 隔离跳过并计 skipped_errored。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PgPoolService } from '../../infrastructure/sql';
import { TerminalStateRegistry } from '../schedule/slot-lock.terminal-registry';
import type { EntityTerminalInfo, TerminalStateProvider } from '../schedule/slot-lock.types';
import { GROUP_BUY_TERMINAL_STATUSES } from './group-buy.machine';

@Injectable()
export class GroupBuyTerminalProvider implements TerminalStateProvider, OnModuleInit {
  constructor(
    private readonly pool: PgPoolService,
    private readonly registry: TerminalStateRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('groupbuy', this);
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
      `SELECT id::text AS id, status, status_since FROM trade.group_buys WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    for (const row of res.rows) {
      const terminal = (GROUP_BUY_TERMINAL_STATUSES as readonly string[]).includes(row.status);
      infos.set(Number(row.id), {
        terminal,
        since: terminal ? new Date(row.status_since) : null,
      });
    }
    return infos;
  }
}
