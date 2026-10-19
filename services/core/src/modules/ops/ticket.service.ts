/**
 * H3 纠纷工单服务（机制核心）：建单（事件消费共用核 + 人工 API，幂等键=category+ref ⚠W2-9）+
 * 查询面（列表/详情含审计行/SLA 统计）+ 处置面（resolve：状态机迁移 + 回调发起方 + 事件出箱）。
 * 施工规格：docs/modules/H-运营后台/H3-纠纷工单与退款审核.md；只写 ops.* 表（边界纪律）。
 *
 * 状态纪律（§3/§9）：OPEN→PROCESSING→RESOLVED/REJECTED 全经守卫+STL（entity_type='ticket'），
 * 建单 INSERT status='OPEN' 非迁移无需守卫（demo/notify/rule-center 同口径）；每次迁移同事务
 * INSERT ticket_actions 审计行（action/operator_id/payload）。
 *
 * SLA（§2/R-03）：锚=created_at（DB 钟）——建单语句内 now() 同快照推导 sla_due（消除双钟
 * 漂移，settlement enterSettlement 的 M-1 口径同款）；reconciliation=24h 硬 / 其余=48h 软
 * （配置化，ticket.config）。
 *
 * 事件（§6）：建单同事务出箱 ops.ticket.created（H4/I1 消费位）；处置终态且 ref 指向结算实体
 * （session/one_on_one）时出箱 TICKET_RESOLVED 既有 topic（F3 HOLD 释放消费 M1 已在位——
 * shared TicketResolvedPayload 载荷逐字，不改既有契约；其他 ref 类型无 F3 语义不出箱）。
 *
 * R-04 联调位：未结 dispute 工单 → 该场结算 HOLD，由 F3 侧既有 OpenTicketGate 查询缝承载
 * （settlement.gate registerSource 换装位，M1-W3 预留）；生产装配=TicketGateRegistration
 * （文末，修复环 I-1：SettlementModule 导出闸 + TicketModule onModuleInit 注册——闸值只认
 * 未结 dispute 类目，H3 §7 R-04 文义「未结纠纷」逐字，语义锁定用例在 spec）。
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  TICKET_CATEGORIES,
  TICKET_CREATED_TOPIC,
  TICKET_RESOLVED_TOPIC,
  type TicketCategory,
  type TicketCreatedPayload,
  type TicketResolvedPayload,
} from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { OpenTicketGate, type OpenTicketSource } from '../settlement/settlement.gate';
import type { SettlementRefType } from '../settlement/settlement.types';
import { TicketResolveCallbackRegistry } from './ticket.callbacks';
import { TICKET_CONFIG, slaMsForCategory, type TicketConfig } from './ticket.config';
import { TICKET_MACHINE } from './ticket.machine';
import type {
  CreateTicketInput,
  TicketActionView,
  TicketDetailView,
  TicketSlaStats,
  TicketStatus,
  TicketView,
  ResolveTicketInput,
} from './ticket.types';
import { isTicketTerminal } from './ticket.types';

const TICKET_COLUMNS = `id, category, ref_type, ref_id, title, detail, status, priority,
  sla_due, assignee_id, created_at, resolved_at,
  (status IN ('OPEN', 'PROCESSING') AND sla_due < now()) AS sla_overdue`;

interface TicketRow {
  readonly id: string;
  readonly category: string;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly priority: number;
  readonly sla_due: Date;
  readonly assignee_id: string | null;
  readonly created_at: Date;
  readonly resolved_at: Date | null;
  readonly sla_overdue: boolean;
}

interface ActionRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly action: string;
  readonly operator_id: string;
  readonly payload: Record<string, unknown>;
  readonly created_at: Date;
}

/** TICKET_RESOLVED 载荷 ref_type 值域（shared 契约逐字：F3 结算实体词汇） */
const SETTLEMENT_REFS: readonly string[] = ['session', 'one_on_one'];

function toTicketView(row: TicketRow): TicketView {
  return {
    id: Number(row.id),
    category: row.category as TicketCategory,
    ref_type: row.ref_type,
    ref_id: row.ref_id === null ? null : Number(row.ref_id),
    title: row.title,
    detail: row.detail,
    status: row.status as TicketStatus,
    priority: row.priority,
    sla_due: new Date(row.sla_due).toISOString(),
    sla_overdue: row.sla_overdue === true,
    assignee_id: row.assignee_id === null ? null : Number(row.assignee_id),
    created_at: new Date(row.created_at).toISOString(),
    resolved_at: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
  };
}

function toActionView(row: ActionRow): TicketActionView {
  return {
    id: Number(row.id),
    ticket_id: Number(row.ticket_id),
    action: row.action,
    operator_id: Number(row.operator_id),
    payload: row.payload,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** category 校验（七值词汇，shared TICKET_CATEGORIES 契约锚） */
function assertCategory(raw: string): TicketCategory {
  if (!(TICKET_CATEGORIES as readonly string[]).includes(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `category 必须为 ${TICKET_CATEGORIES.join('|')} 之一：${raw}`,
    );
  }
  return raw as TicketCategory;
}

function assertText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 必须为 1-${max} 位非空字符串`);
  }
  return raw;
}

function assertPositiveInt(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 必须为正整数`);
  }
  return raw;
}

/**
 * detail 长度上限（人工 HTTP 面校验口径；事件消费路径由 ticket.consumer 的截断留档保证
 * 不超限——修复环 C-1：对账差异日多行载荷超 4000 时截断而非拒单，防 relay DEAD 致工单
 * 永不创建（恰落在 R-03 硬 SLA 场景））。
 */
export const TICKET_DETAIL_MAX = 4000;

/** 建单入参校验（事件/人工共用）：ref both-or-neither（幂等键成对成立才有效） */
function assertCreateInput(input: CreateTicketInput): {
  category: TicketCategory;
  refType: string | null;
  refId: number | null;
  title: string;
  detail: string;
  priority: number;
  assigneeId: number | null;
} {
  const category = assertCategory(input.category);
  const title = assertText(input.title, 'title', 128);
  const detail = assertText(input.detail, 'detail', TICKET_DETAIL_MAX);
  let refType: string | null = null;
  let refId: number | null = null;
  if (input.refType !== undefined || input.refId !== undefined) {
    // both-or-neither：部分携带=幂等键残缺，拒绝而非静默取半
    if (input.refType === undefined || input.refId === undefined) {
      throw new AppError(ErrorCode.InvalidArgument, 'ref_type/ref_id 必须成对出现（或都缺省）');
    }
    refType = assertText(input.refType, 'ref_type', 16);
    refId = assertPositiveInt(input.refId, 'ref_id');
  }
  let priority = 3;
  if (input.priority !== undefined) {
    if (
      typeof input.priority !== 'number' ||
      !Number.isInteger(input.priority) ||
      input.priority < 1 ||
      input.priority > 5
    ) {
      throw new AppError(ErrorCode.InvalidArgument, 'priority 必须为 1-5 整数（缺省 3）');
    }
    priority = input.priority;
  }
  let assigneeId: number | null = null;
  if (input.assigneeId !== undefined) {
    assigneeId = assertPositiveInt(input.assigneeId, 'assignee_id');
  }
  return { category, refType, refId, title, detail, priority, assigneeId };
}

@Injectable()
export class TicketService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly callbacks: TicketResolveCallbackRegistry,
    @Inject(TICKET_CONFIG) private readonly config: TicketConfig,
  ) {}

  // ===========================================================================
  // 建单（§4 创建：事件消费共用核；幂等键=category+ref ⚠W2-9）
  // ===========================================================================

  /**
   * 建单（INSERT status='OPEN' 非迁移无需守卫）：sla_due=now()+SLA(同语句同快照——锚=
   * created_at DB 钟)；幂等键冲突（category+ref 部分唯一索引兜底）⇒ ON CONFLICT DO NOTHING
   * 无错路径回读首访行返回 created:false（23505 会打入 aborted，registerJob/createDraft 先例）。
   * created=true 同事务出箱 ops.ticket.created（§6）。
   */
  async createTicket(input: CreateTicketInput): Promise<{ created: boolean; ticket: TicketView }> {
    const v = assertCreateInput(input);
    const slaMs = slaMsForCategory(this.config, v.category);
    return this.pool.withTransaction(async (uow) => {
      const inserted = await uow.query<TicketRow>(
        `INSERT INTO ops.tickets
           (category, ref_type, ref_id, title, detail, status, priority, sla_due, assignee_id)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', $6,
                 now() + ($7::bigint * interval '1 millisecond'), $8)
         ON CONFLICT (category, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING
         RETURNING ${TICKET_COLUMNS}`,
        [v.category, v.refType, v.refId, v.title, v.detail, v.priority, slaMs, v.assigneeId],
      );
      const row =
        inserted.rows[0] ??
        (await this.readByRef(uow, v.category, v.refType, v.refId)) ??
        (() => {
          throw new AppError(ErrorCode.InternalError, '工单幂等冲突但不可读（不应触达）');
        })();
      const created = inserted.rows.length > 0;
      if (created) {
        // §6：建单事件同事务（业务回滚则事件不出）；人工工单 ref 空不携带（⚠W2-9）
        const payload: TicketCreatedPayload = {
          ticket_id: Number(row.id),
          category: v.category,
          ...(v.refType !== null && v.refId !== null
            ? { ref_type: v.refType, ref_id: v.refId }
            : {}),
          sla_due: new Date(row.sla_due).toISOString(),
          priority: row.priority,
        };
        await this.outbox.recordOutbox(uow, { type: TICKET_CREATED_TOPIC, payload });
      }
      return { created, ticket: toTicketView(row) };
    });
  }

  // ===========================================================================
  // 查询面（§5 GET /admin/tickets[/{id}]：筛选/详情含 actions 审计行；SLA 统计面）
  // ===========================================================================

  /** 列表（category/status 筛选，新单在前）：行内携带 sla_overdue 布尔（未结且已过 SLA） */
  async listTickets(
    filter: {
      readonly category?: TicketCategory;
      readonly status?: TicketStatus;
      readonly limit?: number;
    } = {},
  ): Promise<readonly TicketView[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.category !== undefined) {
      params.push(assertCategory(filter.category));
      clauses.push(`category = $${params.length}`);
    }
    if (filter.status !== undefined) {
      const s = filter.status;
      if (!['OPEN', 'PROCESSING', 'RESOLVED', 'REJECTED'].includes(s)) {
        throw new AppError(ErrorCode.InvalidArgument, `status 非法：${s}`);
      }
      params.push(s);
      clauses.push(`status = $${params.length}`);
    }
    // 修复环 M-2：limit 封顶 200（防呆上界，超出静默收顶——列表为读面无翻页契约）
    const limit =
      filter.limit === undefined ? 100 : Math.min(assertPositiveInt(filter.limit, 'limit'), 200);
    params.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.pool.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM ops.tickets ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(toTicketView);
  }

  /** 详情：主行 + actions 审计行（§5；建单未处置=0 行——建单非流转不落审计） */
  async getTicketDetail(ticketId: number): Promise<TicketDetailView> {
    const id = assertPositiveInt(ticketId, 'ticket_id');
    const ticket = await this.pool.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM ops.tickets WHERE id = $1`,
      [id],
    );
    if (ticket.rows.length === 0) {
      throw new AppError(ErrorCode.NotFound, `工单不存在：${id}`);
    }
    const actions = await this.pool.query<ActionRow>(
      `SELECT id, ticket_id, action, operator_id, payload, created_at
         FROM ops.ticket_actions WHERE ticket_id = $1 ORDER BY id`,
      [id],
    );
    return { ticket: toTicketView(ticket.rows[0]!), actions: actions.rows.map(toActionView) };
  }

  /**
   * SLA 统计面（本批=计数查询；超时率口径留 H4）：未结总数 / 未结超时数 / 分类计数。
   * overdue 判定=DB 钟（sla_due < now() 且未结——已决工单超时不再计入告警面）；分类计数
   * 只列尚有未结工单的类目（已决净空类目不计，告警面零噪音）。
   */
  async slaStats(): Promise<TicketSlaStats> {
    const res = await this.pool.query<{
      category: string;
      open: string;
      overdue: string;
    }>(
      `SELECT category,
              count(*) FILTER (WHERE status IN ('OPEN', 'PROCESSING')) AS open,
              count(*) FILTER (WHERE status IN ('OPEN', 'PROCESSING') AND sla_due < now()) AS overdue
         FROM ops.tickets
        GROUP BY category
       HAVING count(*) FILTER (WHERE status IN ('OPEN', 'PROCESSING')) > 0`,
    );
    const byCategory: Record<string, { open: number; overdue: number }> = {};
    let openTotal = 0;
    let overdueTotal = 0;
    for (const r of res.rows) {
      const open = Number(r.open);
      const overdue = Number(r.overdue);
      byCategory[r.category] = { open, overdue };
      openTotal += open;
      overdueTotal += overdue;
    }
    return { open_total: openTotal, overdue_total: overdueTotal, by_category: byCategory };
  }

  // ===========================================================================
  // R-04 查询缝（F3 OpenTicketGate 的工单源实现；结算释放闸消费）
  // ===========================================================================

  /**
   * 未结纠纷存在性（按结算实体 ref）：F3 releaseDueHold/resumeForFirm 的 HOLD 判定数据源。
   * 只认 category='dispute'（修复环 I-2：H3 §7 R-04 文义「未结**纠纷**」逐字——其余类目
   * 挂同 ref 不挂起结算，语义锁定用例在 spec；F3 hold_reason='OPEN_TICKETS' 的当前唯一
   * 生产者=dispute，后续类目要入闸走文档变更）。
   */
  async hasOpenTicketByRef(refType: SettlementRefType, refId: number): Promise<boolean> {
    const res = await this.pool.query<{ id: string }>(
      `SELECT id FROM ops.tickets
        WHERE ref_type = $1 AND ref_id = $2 AND category = 'dispute'
          AND status IN ('OPEN', 'PROCESSING') LIMIT 1`,
      [refType, assertPositiveInt(refId, 'ref_id')],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ===========================================================================
  // 处置面（§5 POST /admin/tickets/{id}/resolve {action_payload, approved}；幂等键=ticket）
  // ===========================================================================

  /**
   * 处置（approved=true→RESOLVED / false→REJECTED）：
   *   1. FOR UPDATE 锁行——终态 ⇒ 409 CLOSED（幂等键=ticket，§5 逐字；**先于 target 校验**
   *      （修复环 M-1）：已决工单重放（含未注册 target）恒 409 不翻案、不再回调）；
   *      OPEN ⇒ 先认领 OPEN→PROCESSING（assignee 空回填 operator，复合处置的认领半步）；
   *   2. action_payload 带 target ⇒ 回调发起方（效果先行：目标侧幂等收敛崩溃窗口——
   *      回调落地而工单事务回滚 → 重试 resolve 回调 no-op + 工单再迁移，效果恰一次；
   *      未注册 target 显式 400 不静默，d4=W2 T3 接线位）；
   *   3. 终态迁移 + resolved_at + ticket_actions 审计行（每次迁移一行）；
   *   4. ref 指向结算实体（session/one_on_one）⇒ TICKET_RESOLVED 既有 topic 同事务出箱
   *      （F3 HOLD 释放消费 M1 在位；载荷 shared 逐字，不改既有契约）。
   */
  async resolveTicket(input: ResolveTicketInput): Promise<{ status: TicketStatus }> {
    const ticketId = assertPositiveInt(input.ticketId, 'ticket_id');
    const operatorId = assertPositiveInt(input.operatorId, 'operator_id');
    if (typeof input.approved !== 'boolean') {
      throw new AppError(ErrorCode.InvalidArgument, 'approved 必须为布尔');
    }
    const actionPayload = input.actionPayload === undefined ? {} : input.actionPayload;

    const status = await this.pool.withTransaction(async (uow) => {
      const locked = await uow.query<TicketRow>(
        `SELECT ${TICKET_COLUMNS} FROM ops.tickets WHERE id = $1 FOR UPDATE`,
        [ticketId],
      );
      const row = locked.rows[0];
      if (!row) throw new AppError(ErrorCode.NotFound, `工单不存在：${ticketId}`);
      if (isTicketTerminal(row.status as TicketStatus)) {
        // §5 幂等键=ticket：终态 409 CLOSED（不翻案、不再回调——恰一次的守卫半边）
        throw new AppError(
          ErrorCode.Conflict,
          `工单已关闭（CLOSED）：${ticketId} 当前状态 ${row.status}，终态不可再处置`,
        );
      }

      // I-3（M2-W2 T3 修复环）：回调承载类工单（cancel_lt24h——审批通过即驱动 D4 取消流）
      // 处置必须携带 action_payload.target——缺省将造成「工单 RESOLVED 而取消流未生效」的
      // 静默漂移（D4 建单重放自愈为二道防线）；其余类目（dispute 等）纯记录处置不受限
      if (row.category === 'cancel_lt24h' && actionPayload['target'] === undefined) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `category=cancel_lt24h 为回调承载类工单：处置须携带 action_payload.target（{target:'d4', cancellation_id:<场次 id>}）——缺省将造成审批通过而取消流未生效`,
        );
      }

      // 回调目标路由（锁行+终态判定之后——修复环 M-1）：target + 发起方实体 id
      const target = actionPayload['target'];
      if (target !== undefined) {
        if (typeof target !== 'string' || target === '') {
          throw new AppError(ErrorCode.InvalidArgument, 'action_payload.target 必须为非空字符串');
        }
        const cb = this.callbacks.find(target);
        if (!cb) {
          throw new AppError(
            ErrorCode.InvalidArgument,
            `target=${target} 回调未接线（d4 cancellations approve=W2 T3 接线位；先注册回调器再处置）`,
          );
        }
        const refId = assertPositiveInt(actionPayload[cb.idField], `action_payload.${cb.idField}`);
        // 回调发起方（效果先行；目标侧幂等——pricing approve 重放零副作用）
        await cb.invoke({ ticketId, refId, approved: input.approved });
      }

      let current = row.status as TicketStatus;
      if (current === 'OPEN') {
        // 认领（复合处置前半）：assignee 空回填 operator
        await this.transition(uow, ticketId, 'OPEN', 'PROCESSING', 'start_processing');
        const claimed = await uow.query<{ id: string }>(
          `UPDATE ops.tickets SET status = 'PROCESSING', assignee_id = COALESCE(assignee_id, $2)
            WHERE id = $1 AND status = 'OPEN' RETURNING id`,
          [ticketId, operatorId],
        );
        if (claimed.rows.length === 0) {
          throw new AppError(ErrorCode.StateStaleEntity, `工单 ${ticketId} 已被并发迁移`);
        }
        await this.insertAction(uow, ticketId, 'start_processing', operatorId, {
          claimed_by_resolve: true,
        });
        current = 'PROCESSING';
      }

      const to: TicketStatus = input.approved ? 'RESOLVED' : 'REJECTED';
      await this.transition(uow, ticketId, current, to, input.approved ? 'resolve' : 'reject');
      const updated = await uow.query<{ id: string }>(
        `UPDATE ops.tickets SET status = $2, resolved_at = now()
          WHERE id = $1 AND status = $3 RETURNING id`,
        [ticketId, to, current],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `工单 ${ticketId} 已被并发迁移`);
      }
      await this.insertAction(uow, ticketId, input.approved ? 'resolve' : 'reject', operatorId, {
        approved: input.approved,
        action_payload: actionPayload,
      });

      // F3 HOLD 释放事件：仅结算实体 ref（shared TicketResolvedPayload 值域；R-04 后半链）
      if (row.ref_type !== null && SETTLEMENT_REFS.includes(row.ref_type) && row.ref_id !== null) {
        await this.outbox.recordOutbox(uow, {
          type: TICKET_RESOLVED_TOPIC,
          payload: {
            ticket_id: ticketId,
            ref_type: row.ref_type as 'session' | 'one_on_one',
            ref_id: Number(row.ref_id),
          } satisfies TicketResolvedPayload,
        });
      }
      return to;
    });
    return { status };
  }

  // ---------- 内部件 ----------

  private async readByRef(
    uow: SqlExecutor,
    category: string,
    refType: string | null,
    refId: number | null,
  ): Promise<TicketRow | null> {
    const res = await uow.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM ops.tickets
        WHERE category = $1 AND ref_type = $2 AND ref_id = $3`,
      [category, refType, refId],
    );
    return res.rows[0] ?? null;
  }

  /** 守卫状态迁移（状态禁裸写）+ 条件更新兜底乐观并发（rule-center transition 同款） */
  private async transition(
    uow: SqlExecutor,
    ticketId: number,
    from: TicketStatus,
    to: TicketStatus,
    reason: string,
  ): Promise<void> {
    await this.guard.assertTransition(TICKET_MACHINE, {
      entityId: ticketId,
      from,
      to,
      reason,
      uow,
    });
  }

  /** ticket_actions 审计行（每次迁移同事务 INSERT） */
  private async insertAction(
    uow: SqlExecutor,
    ticketId: number,
    action: string,
    operatorId: number,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await uow.query(
      `INSERT INTO ops.ticket_actions (ticket_id, action, operator_id, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [ticketId, action, operatorId, JSON.stringify(payload)],
    );
  }
}

/**
 * R-04 工单源适配器（F3 OpenTicketGate 的 H3 换装实现——settlement.gate 注释逐字预留位）。
 * 闸值语义=未结 dispute（见 TicketService.hasOpenTicketByRef 注释，I-2）。
 */
@Injectable()
export class TicketOpenTicketSource implements OpenTicketSource {
  constructor(private readonly tickets: TicketService) {}

  async hasOpenTicket(refType: SettlementRefType, refId: number): Promise<boolean> {
    return this.tickets.hasOpenTicketByRef(refType, refId);
  }
}

/**
 * R-04 生产装配（修复环 I-1，评审裁决）：TicketModule onModuleInit 把工单源注册进 F3 闸——
 * settlement 侧唯一改动=SettlementModule exports 增 OpenTicketGate（一行加法，闸本体零改动）。
 * registerSource 幂等覆盖（gate 语义），多实例/重复 init 安全。
 */
@Injectable()
export class TicketGateRegistration implements OnModuleInit {
  constructor(
    private readonly gate: OpenTicketGate,
    private readonly source: TicketOpenTicketSource,
  ) {}

  onModuleInit(): void {
    this.gate.registerSource(this.source);
  }
}
