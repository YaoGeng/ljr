/**
 * H5 人审闭环服务（M2-W2 T7；§4 人审流程「队列 → 处置（三分支） → 审计」）：
 *   - 队列（§5 GET /admin/risk/queue）：ops.risk_records 的 reviewed_at IS NULL 面
 *     （ix_risk_records_open V8 既有），created_at 倒序分页 + dict_type/action 筛选；
 *   - 处置（§5 POST /admin/risk/records/{id}/review；幂等键=record）：verdict 三值回填
 *     verdict/reviewed_note/reviewed_by/reviewed_at（DB 钟）行内留痕 + ops.audit_logs 操作
 *     审计行同事务（**双面审计裁定**：risk_records 行内回填=事实源，audit_logs=操作审计面
 *     ——参照 ticket_actions 先例形态最小化）；已处置 409 DONE（不翻案、不再审计）。
 *
 * 守卫口径（控制者裁定，报告注明）：risk_records **不经状态机守卫（STL）**——V8 蓝图无状态
 * 机字段、H5 §3 模型无 status 列，「待审/已处置」由 reviewed_at IS NULL 表达；处置=幂等
 * 回填（一次性写 reviewed_* 四列）非状态迁移，行内 reviewed_at 短路即守卫，FOR UPDATE
 * 行锁串行化并发处置（两 admin 并发处置同一 record 恰一个成功、另一个 409 DONE）。
 *
 * 处置副作用（§4 三分支的 V1 最小面）：
 *   - CONFIRM_BLOCK（确认拦截误放）：风险记录置确认态（verdict 落值）+审计——**消息补拦截
 *     =V1 边界注记不发明**：REVIEW 行的消息已按放行语义广播，撤回/read 标记形态属 D5 撤回
 *     面（消息已发出不可撤回语义留给 D5），本批不改消息本体；
 *   - FALSE_POSITIVE（误拦）：I1 通知位直发桩（模板在册才发——RESCHEDULE_EXPIRED/C6 撤销
 *     话术同款决策位；V1 无 user 锚点，见 notifyFalsePositive 头注）；
 *   - MARK_ONLY：纯记录（零副作用）。
 *
 * ⚠W2-7 维持：异步模型复核仍后置 R3 裁决——word-dict.events.ts 头注留位不动（本服务零
 * 事件生产、零消费注册，H5 §6 生产面仅词库 W1 已落 DictionaryUpdated）。
 */
import { Logger } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { NotifyTemplateService } from '../notify/notify-template.service';
import { AuditLogService } from './audit-log.service';
import {
  REVIEW_NOTE_MAX,
  isReviewVerdict,
  type RiskQueueFilter,
  type RiskQueueItem,
  type RiskReviewInput,
  type RiskReviewResult,
} from './risk-review.types';
import { DICT_TYPES, WORD_ACTIONS } from './word-dict.types';

/** I1 模板中心 code（FALSE_POSITIVE 误拦通知位；seed 归 I1 域——RESCHEDULE_EXPIRED 同款决策位） */
export const RISK_FALSE_POSITIVE_TEMPLATE_CODE = 'RISK_FALSE_POSITIVE';

/** audit_logs action 词汇（H1 'lawyer.audit.*' 同款点分惯例；target_type='risk_record'） */
export const RISK_REVIEW_AUDIT_ACTION = 'risk.record.review';

/** 队列缺省/上限条数（ticket 列表同款防呆上界：读面无翻页契约，超出静默收顶） */
const QUEUE_LIMIT_DEFAULT = 50;
const QUEUE_LIMIT_MAX = 200;

/** 处置目标行（FOR UPDATE 锁读形态；verdict 列 V45 已建） */
interface RiskRecordRow {
  readonly id: string;
  readonly dict_type: string;
  readonly action: string;
  readonly reviewed_at: Date | null;
}

function assertPositiveInt(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 必须为正整数：${String(raw)}`);
  }
  return n;
}

function assertNonNegativeInt(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 必须为非负整数：${String(raw)}`);
  }
  return n;
}

@Injectable()
export class RiskReviewService {
  private readonly logger = new Logger(RiskReviewService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly auditLog: AuditLogService,
    private readonly templates: NotifyTemplateService,
  ) {}

  // ---------- 队列（§5 GET /admin/risk/queue：待处置记录，新在前） ----------

  /**
   * 人审队列：reviewed_at IS NULL（§4「队列」逐字；处置后自动跌出）+ dict_type/action 筛选
   * + created_at 倒序分页（limit 缺省 50 封顶 200 / offset 缺省 0——id DESC 为 created_at
   * 同刻的确定性次序锚）。筛选值走既有词汇校验（dict_type 两库/action 三级，非法 400）。
   */
  async listQueue(filter: RiskQueueFilter = {}): Promise<RiskQueueItem[]> {
    const clauses = ['reviewed_at IS NULL'];
    const params: unknown[] = [];
    if (filter.dictType !== undefined) {
      if (!(DICT_TYPES as readonly string[]).includes(filter.dictType)) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `dict_type 必须为 ${DICT_TYPES.join('|')} 之一：${filter.dictType}`,
        );
      }
      params.push(filter.dictType);
      clauses.push(`dict_type = $${params.length}`);
    }
    if (filter.action !== undefined) {
      if (!(WORD_ACTIONS as readonly string[]).includes(filter.action)) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `action 必须为 ${WORD_ACTIONS.join('|')} 之一：${filter.action}`,
        );
      }
      params.push(filter.action);
      clauses.push(`action = $${params.length}`);
    }
    const limit =
      filter.limit === undefined
        ? QUEUE_LIMIT_DEFAULT
        : Math.min(assertPositiveInt(filter.limit, 'limit'), QUEUE_LIMIT_MAX);
    params.push(limit);
    // offset 0-based 非负（缺省 0=首页）；limit/offset 形态=轻量翻页面（无 total 计数契约）
    const offset = filter.offset === undefined ? 0 : assertNonNegativeInt(filter.offset, 'offset');
    params.push(offset);
    const res = await this.pool.query<{
      id: string;
      message_id: string | null;
      conversation_id: string | null;
      dict_type: string;
      word_hits: Record<string, unknown>[];
      action: string;
      created_at: Date;
    }>(
      `SELECT id, message_id, conversation_id, dict_type, word_hits, action, created_at
         FROM ops.risk_records
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      message_id: r.message_id === null ? null : Number(r.message_id),
      conversation_id: r.conversation_id === null ? null : Number(r.conversation_id),
      dict_type: r.dict_type as RiskQueueItem['dict_type'],
      word_hits: r.word_hits,
      action: r.action as RiskQueueItem['action'],
      created_at: new Date(r.created_at).toISOString(),
    }));
  }

  // ---------- 处置（§5 POST /admin/risk/records/{id}/review {verdict, note?}） ----------

  /**
   * 人审处置（幂等键=record）：
   *   1. FOR UPDATE 锁行——缺行 404；**reviewed_at 非空 ⇒ 409 DONE**（§5 逐字；不翻案：
   *     首次 verdict 保留、不再审计——恰一次的守卫半边，H3 resolve 终态 409 CLOSED 同构）；
   *   2. verdict 三值 ck（V45 值域同源）+note 1..500 校验（不静默截断——审计留痕完整性）；
   *   3. 行内回填 verdict/reviewed_note/reviewed_by/reviewed_at（now()=DB 钟，条件更新
   *     reviewed_at IS NULL 双保险，0 行=并发已处置→409 DONE）；
   *   4. audit_logs 操作审计行同事务（双面审计的 audit 面：actor=operator、detail={verdict}
   *     ——note 已在 record 行内，不重复存）；
   *   5. 分支副作用：FALSE_POSITIVE→通知位直发桩；CONFIRM_BLOCK/MARK_ONLY→纯行内+审计。
   */
  async reviewRecord(input: RiskReviewInput): Promise<RiskReviewResult> {
    const recordId = assertPositiveInt(input.recordId, 'record_id');
    const operatorId = assertPositiveInt(input.operatorId, 'operator_id');
    if (!isReviewVerdict(input.verdict)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `verdict 必须为 CONFIRM_BLOCK|FALSE_POSITIVE|MARK_ONLY 之一：${String(input.verdict)}`,
      );
    }
    if (input.note !== undefined) {
      if (typeof input.note !== 'string' || input.note.trim() === '') {
        throw new AppError(ErrorCode.InvalidArgument, 'note 必须为非空字符串（缺省=不留备注）');
      }
      if (input.note.length > REVIEW_NOTE_MAX) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `note 长度 ${input.note.length} 超上限 ${REVIEW_NOTE_MAX}（不静默截断）`,
        );
      }
    }

    return this.pool.withTransaction(async (uow) => {
      const locked = await uow.query<RiskRecordRow>(
        `SELECT id, dict_type, action, reviewed_at FROM ops.risk_records WHERE id = $1 FOR UPDATE`,
        [recordId],
      );
      const row = locked.rows[0];
      if (!row) throw new AppError(ErrorCode.NotFound, `风险记录不存在：${recordId}`);
      if (row.reviewed_at !== null) {
        // §5 幂等键=record：已处置 409 DONE（不翻案、不再审计）
        throw new AppError(
          ErrorCode.Conflict,
          `风险记录已处置（DONE）：${recordId} 于 ${row.reviewed_at.toISOString()} 处置完毕，不可再处置`,
        );
      }

      const updated = await uow.query<{ reviewed_at: Date }>(
        `UPDATE ops.risk_records
            SET verdict = $2, reviewed_note = $3, reviewed_by = $4, reviewed_at = now()
          WHERE id = $1 AND reviewed_at IS NULL
          RETURNING reviewed_at`,
        [recordId, input.verdict, input.note ?? null, operatorId],
      );
      if (updated.rows.length === 0) {
        // FOR UPDATE 下不可达的防御半边（并发已处置→409 DONE 同语义）
        throw new AppError(
          ErrorCode.Conflict,
          `风险记录已处置（DONE）：${recordId}（并发处置收敛）`,
        );
      }

      // 双面审计的 audit 面：操作事实（谁/何时/何结论）随业务同事务（audit-log.service 契约）
      await this.auditLog.record(uow, {
        actorUserId: operatorId,
        action: RISK_REVIEW_AUDIT_ACTION,
        targetType: 'risk_record',
        targetId: recordId,
        detail: { verdict: input.verdict },
      });

      if (input.verdict === 'FALSE_POSITIVE') {
        await this.notifyFalsePositive(uow, recordId);
      }
      return {
        record_id: recordId,
        verdict: input.verdict,
        reviewed_by: operatorId,
        reviewed_at: new Date(updated.rows[0]!.reviewed_at).toISOString(),
      };
    });
  }

  // ---------- 内部件 ----------

  /**
   * FALSE_POSITIVE 误拦通知位（**V1 直发桩**，任务简报裁定形态）：
   *   - 模板在册才发（RISK_FALSE_POSITIVE seed 归 I1 域新迁移；缺失跳过+告警日志不阻断处置
   *     ——RESCHEDULE_EXPIRED/C6 撤销话术同款决策位）；
   *   - V1 无 user 锚点：risk_records 无 user_id 列（V45 裁定列集固定 verdict/reviewed_note，
   *     不扩列）、message_id 关联=D5 消息链路接入后置位（W1 checkRisk 先于消息落库，行内
   *     message_id 恒 NULL）、ops 禁跨 schema 直读 D5 会话/消息表定 sender（边界纪律，
   *     措辞规避点分词形扫描）——registerForEvent 的必填 userId 无解析面，模板在册亦告警跳过；
   *   - 接线位=本方法：D5 补 message_id 关联（或 conversation 参与者导出面）后，在此经
   *     idempotencyKey `risk/review/r{id}/false_positive` 登记真发。
   */
  private async notifyFalsePositive(uow: SqlExecutor, recordId: number): Promise<void> {
    if (!(await this.templateExists(uow, RISK_FALSE_POSITIVE_TEMPLATE_CODE))) {
      this.logger.warn(
        `人审 FALSE_POSITIVE 处置 ${recordId}：模板 ${RISK_FALSE_POSITIVE_TEMPLATE_CODE} 未 seed（I1 域待落）——本次跳过通知（⚠决策位，报告注明）`,
      );
      return;
    }
    this.logger.warn(
      `人审 FALSE_POSITIVE 处置 ${recordId}：模板在册但 user 锚点缺失（V1 无 user_id 列，message_id 关联=D5 后置）——跳过通知，D5 补关联后启用真发（V1 边界，报告注明）`,
    );
  }

  /** 模板在册判定（price-change/reschedule templateExists 同款——在册才扇出） */
  private async templateExists(uow: SqlExecutor, code: string): Promise<boolean> {
    try {
      await this.templates.findByCode(uow, code);
      return true;
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.NotFound) return false;
      throw e;
    }
  }
}
