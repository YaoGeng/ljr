/**
 * state_transition_log 留痕服务（M0-4）：架构 §4.1「所有状态迁移经守卫与 state_transition_log 落库，
 * 供审计、对账与指标计算」。列契约对齐 docs/modules/C-交易/C3 §3 具名清单
 * （entity_type/entity_id/from_status/to_status/reason/job_id/created_at）+ 裁量列 allowed（放行/拒绝）。
 */
import { Injectable } from '@nestjs/common';
import type { SqlExecutor } from '../sql';

export interface TransitionLogEntry {
  readonly entityType: string;
  readonly entityId: number;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly allowed: boolean;
  readonly reason?: string;
  readonly jobId?: string;
}

@Injectable()
export class StateTransitionLogService {
  /**
   * 写一行留痕。uow 语义由调用方决定：
   * 放行留痕传业务事务 client（随业务提交/回滚）；拒绝留痕传独立连接（业务回滚不吞审计）。
   */
  async write(uow: SqlExecutor, entry: TransitionLogEntry): Promise<void> {
    await uow.query(
      `INSERT INTO platform.state_transition_log
         (entity_type, entity_id, from_status, to_status, allowed, reason, job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.entityType,
        entry.entityId,
        entry.fromStatus,
        entry.toStatus,
        entry.allowed,
        entry.reason ?? null,
        entry.jobId ?? null,
      ],
    );
  }
}
