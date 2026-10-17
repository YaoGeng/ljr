/**
 * ops.audit_logs 审计写入件（H1 §3「audit_logs 记操作」/ §8「审核操作全审计」；H9 正式审计
 * 存储=M4（G-E），本表为 ops 域最小落地——H1 的四类操作（audit/suspend/resume 与后续扩展）
 * 都经本件落审计，actor=claims userId（⚠W3-8 admin 鉴权接线的绑定产物）。
 *
 * 边界（schema 纪律）：只写 ops.audit_logs（owner=ops）；调用方传 uow——审计行与业务状态
 * 迁移同事务提交/回滚（操作事实与业务原子同命运；「拒绝路径不随回滚丢失」是另一类事实，
 * B2 recordAbuse 独立连接语义，两者不混用）。查询面 listByTarget=§10「全部操作在 H9 审计
 * 可查」的最小读侧（H9 落位时扩面不换表）。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';

/** 审计写入入参（action 词汇由调用方定义：H1=lawyer.audit.<claim|approve|reject|suspend|resume>） */
export interface AuditLogInput {
  readonly actorUserId: number;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** 审计行视图（snake_case 出站口径；detail 原样 jsonb 往返） */
export interface AuditLogView {
  readonly id: number;
  readonly actor_user_id: number;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: number;
  readonly detail: Record<string, unknown> | null;
  readonly created_at: string;
}

interface AuditLogRow {
  readonly id: string;
  readonly actor_user_id: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly detail: Record<string, unknown> | null;
  readonly created_at: Date;
}

/** 形态防呆上限（DB varchar 列宽同源：action 64 / target_type 32） */
const ACTION_MAX = 64;
const TARGET_TYPE_MAX = 32;

function assertAuditText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 必须为 1-${max} 位非空字符串`);
  }
  return raw;
}

function assertActor(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, 'actor_user_id 必须为正整数');
  }
  return raw;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly pool: PgPoolService) {}

  /** 同事务写入（uow 必传）：调用方在业务事务内调用，审计行随事务提交/回滚 */
  async record(uow: SqlExecutor, input: AuditLogInput): Promise<void> {
    const actorUserId = assertActor(input.actorUserId);
    const action = assertAuditText(input.action, 'action', ACTION_MAX);
    const targetType = assertAuditText(input.targetType, 'target_type', TARGET_TYPE_MAX);
    const targetId = assertActor(input.targetId);
    if (input.detail !== undefined && typeof input.detail !== 'object') {
      throw new AppError(ErrorCode.InvalidArgument, 'detail 必须为 JSON 对象');
    }
    await uow.query(
      `INSERT INTO ops.audit_logs (actor_user_id, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorUserId, action, targetType, targetId, input.detail === undefined
        ? null
        : JSON.stringify(input.detail),
      ],
    );
  }

  /** 按 target 查询（新在前）：§10「全部操作在 H9 审计可查」的最小读侧 */
  async listByTarget(
    targetType: string,
    targetId: number,
    limit = 100,
  ): Promise<AuditLogView[]> {
    const found = await this.pool.query<AuditLogRow>(
      `SELECT id, actor_user_id, action, target_type, target_id, detail, created_at
         FROM ops.audit_logs
        WHERE target_type = $1 AND target_id = $2
        ORDER BY id DESC
        LIMIT $3`,
      [assertAuditText(targetType, 'target_type', TARGET_TYPE_MAX), assertActor(targetId), limit],
    );
    return found.rows.map((r) => ({
      id: Number(r.id),
      actor_user_id: Number(r.actor_user_id),
      action: r.action,
      target_type: r.target_type,
      target_id: Number(r.target_id),
      detail: r.detail,
      created_at: new Date(r.created_at).toISOString(),
    }));
  }
}
