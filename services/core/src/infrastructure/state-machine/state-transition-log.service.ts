/**
 * state_transition_log 留痕服务（M0-4）：架构 §4.1「所有状态迁移经守卫与 state_transition_log 落库，
 * 供审计、对账与指标计算」。列契约对齐 docs/modules/C-交易/C3 §3 具名清单
 * （entity_type/entity_id/from_status/to_status/reason/job_id/created_at）+ 裁量列 allowed（放行/拒绝）。
 */
import { Injectable, Optional } from '@nestjs/common';
import type { SqlExecutor } from '../sql';
import { PgPoolService } from '../sql';

export interface TransitionLogEntry {
  readonly entityType: string;
  readonly entityId: number;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly allowed: boolean;
  readonly reason?: string;
  readonly jobId?: string;
}

/** 放行留痕读过滤（listAllowedTransitions 入参；全部条件 AND，均可选除 entityType） */
export interface TransitionLogFilter {
  readonly entityType: string;
  /** 目标态精确匹配（如 'CONFIRMED'）；缺省=该实体全部放行迁移 */
  readonly toStatus?: string;
  /** 实体 id 清单（bigint[] 收窄）；缺省=不按实体过滤 */
  readonly entityIds?: readonly number[];
  /** created_at 下界（含） */
  readonly from?: Date;
  /** created_at 上界（不含） */
  readonly to?: Date;
  /** 行数上限（修复环 I-2：宽窗读护栏；缺省=无界——调用方自担，业务面一律显式传） */
  readonly limit?: number;
}

/** 放行留痕读出行（created_at ISO 化；reason/job_id 可空） */
export interface TransitionLogReadRow {
  readonly entityId: number;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

@Injectable()
export class StateTransitionLogService {
  /** @Optional：纯 write() 单测可无池装配（M0 起既有 spec 形态）；listAllowedTransitions
   *  （M2-W2 T4 加法）是唯一用池读面——无池调用显性化 500，不静默 */
  constructor(@Optional() private readonly pool?: PgPoolService) {}

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

  /**
   * 放行留痕只读查询面（M2-W2 T4 纯加法，C4 response-stats 的 STL 聚合源）：按实体类型/
   * 目标态/实体清单/时间窗查 allowed=true 行。架构 §4.1「供审计、对账与指标计算」的读侧
   * 承载——业务模块经本基座服务读 STL（platform 表经基座访问属设计内合法跨域，直连由
   * DB role 授权兜底——check-schema-refs 白名单注记口径）。序=entity_id, created_at, id
   * （同刻多行的稳定序）。
   */
  async listAllowedTransitions(
    filter: TransitionLogFilter,
  ): Promise<readonly TransitionLogReadRow[]> {
    if (!this.pool) {
      throw new Error('StateTransitionLogService 未装配连接池（listAllowedTransitions 不可用）');
    }
    const clauses: string[] = ['entity_type = $1', 'allowed = true'];
    const params: unknown[] = [filter.entityType];
    if (filter.toStatus !== undefined) {
      params.push(filter.toStatus);
      clauses.push(`to_status = $${params.length}`);
    }
    if (filter.entityIds !== undefined) {
      params.push(filter.entityIds);
      clauses.push(`entity_id = ANY($${params.length}::bigint[])`);
    }
    if (filter.from !== undefined) {
      params.push(filter.from);
      clauses.push(`created_at >= $${params.length}`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      clauses.push(`created_at < $${params.length}`);
    }
    const limitClause =
      filter.limit !== undefined && Number.isSafeInteger(filter.limit) && filter.limit > 0
        ? ` LIMIT ${filter.limit}`
        : '';
    const res = await this.pool.query<{
      entity_id: string;
      from_status: string | null;
      to_status: string;
      reason: string | null;
      created_at: Date;
    }>(
      `SELECT entity_id, from_status, to_status, reason, created_at
         FROM platform.state_transition_log
        WHERE ${clauses.join(' AND ')}
        ORDER BY entity_id, created_at, id${limitClause}`,
      params,
    );
    return res.rows.map((r) => ({
      entityId: Number(r.entity_id),
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
