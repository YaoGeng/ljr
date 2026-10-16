/**
 * F2 退款执行域服务（§4 关键流程/§5 ISSUE_REFUND + GET /refunds/mine/§7 R-01~R-04 + §9 TDD）。
 *
 * 形态：F1/A3b 同域平级文件（refund.*，payment schema owner；「可剥离纪律」导出面=本应用服务
 * + shared 事件契约 + HTTP 契约，机器件/类型/注册表为模块内部件）。
 *
 * 受理（R-04 幂等键=原因+实体）：幂等键 DB 唯一约束真兜底——claim INSERT ON CONFLICT DO
 * NOTHING，冲突行读回比对载荷：同键同载荷=幂等重放原单（恰一次），同键异载荷=409 E_DUP_KEY
 * （F1 replayOrder 同口径）；失败尝试随事务回滚不烧键。同键重入遇 REQUESTED 遗留单（受理后
 * 下发前崩溃窗口）→ 续发同一单（批量断点续跑语义地基，§10）。
 *
 * 金额守恒（§9 TDD 硬项，T2 评审交接条件）：同支付单累计退款（现金+积分折算，FAILED 不计——
 * 未发生资金移动）+ 本次 ≤ 支付额（total 生成列），超限 400。原支付拆分快照从 F1 payment_orders
 * 读（服务面 findOrderById，T5 导出面扩展先例）；F1 refund 内的 CONFIRMED 台账累计求和是并发
 * 硬闸，本面是入口 400 语义——双层（同 F1 total 生成列+应用断言的双层口径）。
 *
 * 下发与状态（经守卫+STL，entity_type='refund'）：REQUESTED→PROCESSING（首次下发启动，attempt_count
 * 同事务 +1）→ F1 refund 指令面调用（服务面真消费，REFUNDING 推进与台账归 F1）→ REFUND_SUCCESS
 * 回调经 F1 Inbox 事件（PaymentCallbackInboxed event=REFUND_SUCCESS，既有出口不改 F1 契约）驱动
 * convergeRefundSuccess → PROCESSING→DONE + RefundCompleted 出箱（消费位 C3=T7/I1/H4）。
 * 失败路径：指令面抛错 → bookFailure 记账（attempt_count 已含本次；未耗尽=退避 next_retry_at，
 * dispatchDue 驱动重入；耗尽 3 次 → PROCESSING→FAILED + RefundFailed 出箱，工单面=H3 M2）。
 *
 * R-03 积分还原：DONE 时经 F4 refundRestore 导出真消费（还原额=积分部分，不退现；ref=refund:{id}
 * 幂等，过期时钟重置语义由 F4 持有）——见 convergeRefundSuccess（收敛式消费：重投对已 DONE 单
 * 的还原调用由 F4 唯一约束短路，崩溃窗口收敛不丢失）。
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  REFUND_COMPLETED_TOPIC,
  REFUND_FAILED_TOPIC,
  isValidIdempotencyKey,
  type RefundCompletedPayload,
  type RefundFailedPayload,
} from '@ljr/shared';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { PointsService } from '../benefits/points.service';
import { PaymentGatewayService } from './payment.gateway.service';
import { assertMoney, dbNumericToCents, moneyToCents } from './payment.types';
import { REFUND_MACHINE, type RefundStatus } from './refund.machine';
import {
  MAX_DISPATCH_ATTEMPTS,
  REFUND_REASONS,
  RETRY_BACKOFF_SECONDS,
  assertPointsLike,
  type IssueRefundInput,
  type RefundMineItem,
  type RefundReason,
  type RefundView,
} from './refund.types';

interface RefundRow {
  readonly id: string;
  readonly payment_order_id: string;
  readonly user_id: string;
  readonly cash_amount: string;
  readonly points_amount: number;
  readonly reason: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly idempotency_key: string;
  readonly requested_at: Date;
  readonly done_at: Date | null;
}

const REFUND_COLS = `id, payment_order_id, user_id, cash_amount::text AS cash_amount, points_amount,
  reason, status, attempt_count, idempotency_key, requested_at, done_at`;

/** R-01 原路退回 1-3 工作日文案（⚠T6 裁决位：终态文案最小事实化，I1 模板化=M2 联调） */
const ETA_TEXT_PENDING = '退款已受理，将在 1-3 个工作日内原路退回';
const ETA_TEXT_DONE = '已原路退回';
const ETA_TEXT_FAILED = '退款失败，请联系客服处理';

function assertIdempotencyKey(key: string): void {
  if (!isValidIdempotencyKey(key)) {
    throw new AppError(
      ErrorCode.IdempotencyKeyInvalid,
      `非法幂等键：${JSON.stringify(key)}（规范 domain/entity/event，如 refund/po-1/group-fail）`,
    );
  }
}

function toView(row: RefundRow): RefundView {
  return {
    refund_id: Number(row.id),
    order_id: Number(row.payment_order_id),
    user_id: Number(row.user_id),
    cash_amount: row.cash_amount,
    points_amount: row.points_amount,
    reason: row.reason as RefundReason,
    status: row.status as RefundStatus,
    idempotency_key: row.idempotency_key,
    requested_at: new Date(row.requested_at).toISOString(),
    done_at: row.done_at === null ? null : new Date(row.done_at).toISOString(),
  };
}

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly payment: PaymentGatewayService,
    // F4 导出应用服务（R-03 还原真消费）；@Optional 仅为纯受理面单测可独立装配——还原路径必依赖
    @Optional() private readonly points?: PointsService,
  ) {}

  // ===========================================================================
  // 受理（§5 ISSUE_REFUND：{refund}；409 DUP；R-04 幂等/金额守恒）
  // ===========================================================================

  async accept(input: IssueRefundInput): Promise<{ refund: RefundView }> {
    this.assertInput(input);

    // 原支付拆分快照（F1 服务面读）+ 金额守恒入口预检（F1 CONFIRMED 台账累计=并发硬闸，双层）
    const order = await this.payment.findOrderById(input.order_id);
    if (!order) {
      throw new AppError(ErrorCode.NotFound, `支付单 ${input.order_id} 不存在`);
    }
    const existing = await this.findByKey(input.idempotency_key);
    await this.assertConservation(
      input.order_id,
      order.total,
      moneyToCents(input.cash) + input.points,
      existing?.refund_id ?? null,
    );

    let refundId: number;
    if (existing) {
      const view = this.replayOr409(existing, input);
      if (existing.status !== 'REQUESTED') return { refund: view }; // 在途/终态：重放原单
      refundId = existing.refund_id; // REQUESTED 遗留单：断点续发（不另开新单）
    } else {
      const claim = await this.pool.withTransaction((uow) =>
        uow.query<RefundRow>(
          `INSERT INTO payment.refunds
             (payment_order_id, user_id, cash_amount, points_amount, reason, status, idempotency_key)
           VALUES ($1, $2, $3::numeric, $4, $5, 'REQUESTED', $6)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING ${REFUND_COLS}`,
          [
            input.order_id,
            input.user_id,
            input.cash,
            input.points,
            input.reason,
            input.idempotency_key,
          ],
        ),
      );
      if (claim.rows.length === 0) {
        // 并发同键冲突：读回走同一载荷比对（串行快路径与并发路径同口径，F1 claimOrderRow 先例）
        const raced = await this.findByKey(input.idempotency_key);
        if (!raced) throw new AppError(ErrorCode.InternalError, '幂等键冲突但原单不可读（不应触达）');
        const view = this.replayOr409(raced, input);
        if (raced.status !== 'REQUESTED') return { refund: view };
        refundId = raced.refund_id;
      } else {
        refundId = Number(claim.rows[0]!.id);
      }
    }

    await this.dispatch(refundId, input);
    return { refund: await this.getView(refundId) };
  }

  /** 入参校验收口（服务面对直调方防御；HTTP 无受理面——ISSUE_REFUND 是内部契约） */
  private assertInput(input: IssueRefundInput): void {
    assertPositiveInt(input.order_id, 'order_id');
    assertPositiveInt(input.user_id, 'user_id');
    moneyToCents(assertMoney(input.cash));
    assertPointsLike(input.points);
    if (!REFUND_REASONS.includes(input.reason)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `reason 越域（${REFUND_REASONS.join('|')}）：${String(input.reason)}`,
      );
    }
    assertIdempotencyKey(input.idempotency_key);
  }

  /** R-04 幂等重放判定：同键同载荷=原单；异载荷=409 E_DUP_KEY（F1 replayOrder 同口径） */
  private replayOr409(row: RefundView, input: IssueRefundInput): RefundView {
    const same =
      row.order_id === input.order_id &&
      row.user_id === input.user_id &&
      row.cash_amount === input.cash &&
      row.points_amount === input.points &&
      row.reason === input.reason;
    if (!same) {
      throw new AppError(
        ErrorCode.PaymentDuplicateKey,
        `幂等键 ${input.idempotency_key} 已绑定其他载荷（同键须同载荷重放）`,
      );
    }
    return row;
  }

  /**
   * 金额守恒（§9 硬项）：Σ在册退款（FAILED 不计）+ 本次 ≤ 支付额。整化全在「分」（积分=分）。
   * excludeId：同键重入续发时剔除本单自身（避免自累加误判超限）。
   */
  private async assertConservation(
    orderId: number,
    total: string,
    thisCents: number,
    excludeId: number | null,
  ): Promise<void> {
    const sums = await this.pool.query<{ cash: string; points: string }>(
      `SELECT COALESCE(SUM(cash_amount), 0)::text AS cash,
              COALESCE(SUM(points_amount), 0)::text AS points
         FROM payment.refunds
        WHERE payment_order_id = $1 AND status <> 'FAILED'
          AND ($2::bigint IS NULL OR id <> $2)`,
      [orderId, excludeId],
    );
    const priorCents = dbNumericToCents(sums.rows[0]!.cash) + Number(sums.rows[0]!.points);
    if (priorCents + thisCents > moneyToCents(total)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `金额守恒超限：同单累计退款 ${centsText(priorCents)} + 本次 ${centsText(thisCents)} > 支付额 ${total}`,
      );
    }
  }

  // ===========================================================================
  // 下发（REQUESTED→PROCESSING → F1 refund 指令面；失败记账/退避/耗尽 FAILED）
  // ===========================================================================

  /** 首发与重入续发共用：启动下发轨道（attempt_count 同事务 +1）→ 指令面调用 → 失败记账 */
  private async dispatch(refundId: number, task: IssueRefundInput): Promise<void> {
    await this.pool.withTransaction(async (uow) => {
      const cur = await uow.query<{ status: string }>(
        `SELECT status FROM payment.refunds WHERE id = $1 FOR UPDATE`,
        [refundId],
      );
      const from = cur.rows[0]?.status;
      if (from === undefined) {
        throw new AppError(ErrorCode.InternalError, `退款单 ${refundId} 不可读（不应触达）`);
      }
      if (from !== 'REQUESTED') return; // 并发已入轨/终局：无操作（重投幂等）
      await this.guard.assertTransition(REFUND_MACHINE, {
        entityId: refundId,
        from: 'REQUESTED',
        to: 'PROCESSING',
        reason: `dispatch:${task.reason}`,
        uow,
      });
      await uow.query(
        `UPDATE payment.refunds SET status = 'PROCESSING', attempt_count = attempt_count + 1
          WHERE id = $1 AND status = 'REQUESTED'`,
        [refundId],
      );
    });

    try {
      await this.payment.refund({
        order_id: task.order_id,
        cash_refund: task.cash,
        points_refund: task.points,
        reason: task.reason,
        idempotency_key: task.idempotency_key,
      });
    } catch (e) {
      await this.bookFailure(refundId, task.order_id, task.reason, e);
      throw e; // 受理调用方显性感知失败（批量面逐单收集）
    }
    await this.pool.query(`UPDATE payment.refunds SET next_retry_at = NULL WHERE id = $1`, [
      refundId,
    ]);
  }

  /**
   * 失败记账：attempt_count 已含本次；未耗尽=退避时点（dispatchDue 驱动重入）；
   * 耗尽（≥3）→ PROCESSING→FAILED + RefundFailed 出箱（工单面=H3 M2，本批出箱即止）。
   */
  private async bookFailure(
    refundId: number,
    orderId: number,
    reason: string,
    error: unknown,
  ): Promise<void> {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
      0,
      500,
    );
    await this.pool.withTransaction(async (uow) => {
      const cur = await uow.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM payment.refunds WHERE id = $1 FOR UPDATE`,
        [refundId],
      );
      const row = cur.rows[0];
      if (!row) throw new AppError(ErrorCode.InternalError, `退款单 ${refundId} 不可读（不应触达）`);
      if (row.status !== 'PROCESSING') return; // 并发已终局（重投幂等）
      if (row.attempt_count >= MAX_DISPATCH_ATTEMPTS) {
        await this.guard.assertTransition(REFUND_MACHINE, {
          entityId: refundId,
          from: 'PROCESSING',
          to: 'FAILED',
          reason: `dispatch_exhausted:${reason}`,
          uow,
        });
        await uow.query(
          `UPDATE payment.refunds SET status = 'FAILED', next_retry_at = NULL, last_error = $3
            WHERE id = $1 AND status = $2`,
          [refundId, row.status, message],
        );
        const payload: RefundFailedPayload = {
          refund_id: refundId,
          order_id: orderId,
          reason,
          attempts: row.attempt_count,
          last_error: message,
        };
        await this.outbox.recordOutbox(uow, { type: REFUND_FAILED_TOPIC, payload });
        this.logger.warn(`退款下发耗尽 FAILED：refund=${refundId} order=${orderId} ${message}`);
      } else {
        const delay =
          RETRY_BACKOFF_SECONDS[Math.min(row.attempt_count, RETRY_BACKOFF_SECONDS.length) - 1] ?? 8;
        await uow.query(
          `UPDATE payment.refunds
              SET next_retry_at = now() + make_interval(secs => $3), last_error = $4
            WHERE id = $1 AND status = $2`,
          [refundId, row.status, delay, message],
        );
      }
    });
  }

  /**
   * 重试驱动（测试/后台手动 tick，语义同 relay.tick/dispatch worker）：拾取到期在途单重发
   * 指令面（同幂等键——通道侧重放短路）；成功清退避位等回调，失败再记账。DB 列
   * （status/next_retry_at/attempt_count）为到期事实源（platform.outbox 同形）。
   */
  async dispatchDue(limit = 100): Promise<{ attempted: number; failed: number }> {
    const due = await this.pool.query<{
      id: string;
      payment_order_id: string;
      cash_amount: string;
      points_amount: number;
      reason: string;
      idempotency_key: string;
      user_id: string;
    }>(
      `SELECT ${REFUND_COLS} FROM payment.refunds
        WHERE status = 'PROCESSING' AND next_retry_at IS NOT NULL
          AND next_retry_at <= now() AND attempt_count < $2
        ORDER BY id LIMIT $1`,
      [limit, MAX_DISPATCH_ATTEMPTS],
    );
    let attempted = 0;
    let failed = 0;
    for (const row of due.rows) {
      const refundId = Number(row.id);
      const task: IssueRefundInput = {
        order_id: Number(row.payment_order_id),
        user_id: Number(row.user_id),
        cash: row.cash_amount,
        points: row.points_amount,
        reason: row.reason as RefundReason,
        idempotency_key: row.idempotency_key,
      };
      // 尝试计数先行（首发路径在 dispatch 事务内 +1，重试路径在此 +1——两路同口径）
      await this.pool.query(
        `UPDATE payment.refunds SET attempt_count = attempt_count + 1
          WHERE id = $1 AND status = 'PROCESSING'`,
        [refundId],
      );
      try {
        await this.payment.refund({
          order_id: task.order_id,
          cash_refund: task.cash,
          points_refund: task.points,
          reason: task.reason,
          idempotency_key: task.idempotency_key,
        });
        await this.pool.query(`UPDATE payment.refunds SET next_retry_at = NULL WHERE id = $1`, [
          refundId,
        ]);
        attempted += 1;
      } catch (e) {
        await this.bookFailure(refundId, task.order_id, task.reason, e);
        failed += 1;
      }
    }
    return { attempted, failed };
  }

  // ===========================================================================
  // 回调收敛（REFUND_SUCCESS 经 F1 Inbox 事件驱动：PROCESSING→DONE + RefundCompleted + R-03）
  // ===========================================================================

  /**
   * REFUND_SUCCESS 收敛（F1 已有出口，不改其契约）：按订单幂等键（Inbox biz 键前缀）定位支付单，
   * 将该单全部 PROCESSING 退款单推进 DONE（同事务 RefundCompleted 出箱），再对全部 DONE 单做
   * R-03 积分还原（F4 唯一约束幂等短路——收敛式：重投/崩溃窗口重放不丢还原、不重复入账）。
   * 支付单不存在=载荷漂移显性化（抛错进 relay 重试轨道，不静默）。
   */
  async convergeRefundSuccess(orderIdempotencyKey: string): Promise<{ completed: number[] }> {
    const order = await this.payment.findOrderByIdempotencyKey(orderIdempotencyKey);
    if (!order) {
      throw new AppError(
        ErrorCode.NotFound,
        `REFUND_SUCCESS 回调定位不到支付单：幂等键 ${JSON.stringify(orderIdempotencyKey)}`,
      );
    }
    const completed: number[] = [];
    await this.pool.withTransaction(async (uow) => {
      const rows = await uow.query<RefundRow>(
        `SELECT ${REFUND_COLS} FROM payment.refunds
          WHERE payment_order_id = $1 AND status = 'PROCESSING' ORDER BY id FOR UPDATE`,
        [order.id],
      );
      for (const row of rows.rows) {
        const refundId = Number(row.id);
        await this.guard.assertTransition(REFUND_MACHINE, {
          entityId: refundId,
          from: 'PROCESSING',
          to: 'DONE',
          reason: 'refund_success_callback',
          uow,
        });
        await uow.query(
          `UPDATE payment.refunds SET status = 'DONE', done_at = now()
            WHERE id = $1 AND status = 'PROCESSING'`,
          [refundId],
        );
        const payload: RefundCompletedPayload = {
          refund_id: refundId,
          order_id: order.id,
          amounts: { cash: row.cash_amount, points: row.points_amount },
        };
        await this.outbox.recordOutbox(uow, { type: REFUND_COMPLETED_TOPIC, payload });
        completed.push(refundId);
      }
    });

    // R-03 积分还原（DONE 后；ref=refund:{id} 幂等——F4 唯一约束短路重放；F4 不可用抛错进重试，
    // 重投时上方 DONE 迁移已收敛为空、还原重放短路，恰一次入账）
    if (this.points) {
      await this.restorePoints(order.id);
    }
    return { completed };
  }

  /** R-03 还原：该单全部 DONE 退款的积分部分（ref=refund:{id}；F4 幂等短路保证恰一次） */
  private async restorePoints(orderId: number): Promise<void> {
    const done = await this.pool.query<{ id: string; user_id: string; points_amount: number }>(
      `SELECT id, user_id, points_amount FROM payment.refunds
        WHERE payment_order_id = $1 AND status = 'DONE' AND points_amount > 0 ORDER BY id`,
      [orderId],
    );
    for (const row of done.rows) {
      const out = await this.points!.refundRestore({
        user_id: Number(row.user_id),
        points: row.points_amount,
        ref: `refund:${Number(row.id)}`,
      });
      if (!out.deduplicated) {
        this.logger.log(
          `R-03 积分还原：refund=${row.id} user=${row.user_id} points=${row.points_amount}`,
        );
      }
    }
  }

  // ===========================================================================
  // 查询（§5 GET /refunds/mine 本人状态列表；R-01 文案字段）
  // ===========================================================================

  async listMine(userId: number): Promise<readonly RefundMineItem[]> {
    assertPositiveInt(userId, 'user_id');
    const rows = await this.pool.query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM payment.refunds WHERE user_id = $1 ORDER BY id DESC`,
      [userId],
    );
    return rows.rows.map((row) => ({
      refund_id: Number(row.id),
      order_id: Number(row.payment_order_id),
      cash_amount: row.cash_amount,
      points_amount: row.points_amount,
      reason: row.reason as RefundReason,
      status: row.status as RefundStatus,
      eta_text: etaText(row.status as RefundStatus),
      requested_at: new Date(row.requested_at).toISOString(),
      done_at: row.done_at === null ? null : new Date(row.done_at).toISOString(),
    }));
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  private async findByKey(key: string): Promise<RefundView | null> {
    const res = await this.pool.query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM payment.refunds WHERE idempotency_key = $1`,
      [key],
    );
    const row = res.rows[0];
    return row ? toView(row) : null;
  }

  private async getView(refundId: number): Promise<RefundView> {
    const res = await this.pool.query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM payment.refunds WHERE id = $1`,
      [refundId],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.InternalError, `退款单 ${refundId} 不可读（不应触达）`);
    return toView(row);
  }
}

/** 整数分 → 人读金额文本（守恒报错文案用；不出 float） */
function centsText(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function assertPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

function etaText(status: RefundStatus): string {
  if (status === 'DONE') return ETA_TEXT_DONE;
  if (status === 'FAILED') return ETA_TEXT_FAILED;
  return ETA_TEXT_PENDING;
}
