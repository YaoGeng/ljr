/**
 * F1 支付网关服务（§4/§5/§7）——指令面 + 回调 Inbox 面 + 生命周期守卫推进。
 *
 * 形态（架构 §3.3-3「最薄协议适配」）：不拥有业务状态机语义（业务推进由 Core 指令/回调驱动），
 * 本服务承担：①通道无关统一指令（下单/退款/分账/扣减，§5 表）；②生命周期守卫推进入口
 * （markFrozen/markPaid/markRefunded/closeOrder——回调与 Core 业务模块经此推进，非法迁移被
 * 守卫拒并留痕）；③回调验签→Inbox 投递（R-02 双唯一）；④Inbox 消费面标记（CONSUMED/DEAD+告警）；
 * ⑤T+1 对账（PaymentReconcileService，独立文件）。
 *
 * 幂等口径（R-02/§7）：全部指令带业务幂等键，DB 唯一约束为真兜底——claim INSERT
 * ON CONFLICT DO NOTHING，冲突行读回比对载荷：同键同载荷=幂等重放（返回首访结果，恰一次），
 * 同键异载荷=409 E_DUP_KEY；失败尝试随事务回滚不烧键（demo 先例）。幂等键形态=shared 契约
 * domain/entity/event（F1 §3 例 'enroll-123' 为示意；本模块口径归一：payment_orders 幂等键
 * 经 shared isValidIdempotencyKey 校验，inbox.biz_idempotency_key={订单幂等键}:{事件类型}）。
 *
 * 金额纪律（架构 §1.3）：Money 字符串进出，整化在「分」上比对（payment.types）；
 * total 生成列读回 NUMERIC 字符串与本地整化值比对（assertAmountInvariant）——全接口断言
 * cash+points/100=total（§9 TDD 清单）。
 *
 * 资金红线（R-01）：资金不过平台账户——本服务只产指令流水（split_ledgers）与对账差异行，
 * 无任何资金账户表；分账指令只出现在 PAID→SPLIT 唯一解冻节点（守卫矩阵钉死）。
 *
 * 降级切换（§8）：指令经 ChannelRouter 主→备执行；degradedNow=true 时 ChannelDegraded 与
 * 业务写同事务出箱（恰首次翻动一条）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  CHANNEL_DEGRADED_TOPIC,
  PAYMENT_CALLBACK_INBOXED_TOPIC,
  isValidIdempotencyKey,
  type ChannelDegradedPayload,
  type Money,
  type PaymentCallbackInboxedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { ChannelFaultError, ChannelRouter, type PaymentChannelName } from './payment.channels';
import type { PaymentConfig } from './payment.config';
import { PAYMENT_CONFIG } from './payment.config';
import { PaymentAlertService } from './payment.alerts';
import {
  PAYMENT_ORDER_MACHINE,
  PAYMENT_INBOX_MACHINE,
  type PaymentOrderStatus,
} from './payment.machine';
import {
  BIZ_TYPES,
  DEDUCT_FROM,
  assertAmountInvariant,
  assertMoney,
  assertPoints,
  assertPositiveInt,
  centsToMoney,
  dbNumericToCents,
  moneyToCents,
  type CreateOrderInput,
  type CreateOrderResult,
  type DeductFrom,
  type DeductInput,
  type DeductResultView,
  type PaymentOrderView,
  type PayParamsView,
  type RefundInput,
  type RefundView,
  type SplitInput,
  type SplitItem,
  type SplitResultView,
} from './payment.types';

interface OrderRow {
  readonly id: string;
  readonly biz_type: string;
  readonly biz_id: string;
  readonly channel: string;
  readonly cash_amount: string;
  readonly points_amount: number;
  readonly total: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly channel_txn_no: string | null;
  readonly created_at: Date;
  readonly paid_at: Date | null;
}

interface LedgerRow {
  readonly id: string;
  readonly period: string;
  readonly channel: string;
  readonly direction: string;
  readonly amount: string;
  readonly status: string;
  readonly idempotency_key: string | null;
  readonly detail: LedgerDetail | null;
  readonly created_at: Date;
}

/** 指令流水 detail 载荷（⑩口径：order_id/lawyer_id/from/splits/channel_txn_no/reason/amount） */
interface LedgerDetail {
  readonly order_id?: number;
  readonly cash_refund?: Money;
  readonly points_refund?: number;
  readonly reason?: string;
  readonly splits?: readonly SplitItem[];
  readonly lawyer_id?: number;
  readonly from?: DeductFrom;
  /** deduct 专用：指令金额入 detail 参与幂等载荷比对 */
  readonly amount?: Money;
  readonly channel_txn_no?: string;
}

const ORDER_COLS = `id, biz_type, biz_id, channel, cash_amount::text AS cash_amount, points_amount,
  total::text AS total, status, idempotency_key, channel_txn_no, created_at, paid_at`;

const LEDGER_COLS = `id, period::text AS period, channel, direction, amount::text AS amount,
  status, idempotency_key, detail, created_at`;

const REASON_MAX = 200;

function assertIdempotencyKey(key: string): void {
  if (!isValidIdempotencyKey(key)) {
    throw new AppError(
      ErrorCode.IdempotencyKeyInvalid,
      `非法幂等键：${JSON.stringify(key)}（规范 domain/entity/event，如 payment/order-1/pay）`,
    );
  }
}

function assertReason(reason: unknown): string {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > REASON_MAX) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `reason 须为 1-${REASON_MAX} 字符：${JSON.stringify(reason)}`,
    );
  }
  return reason;
}

function assertBizType(v: string): void {
  if (!BIZ_TYPES.includes(v as (typeof BIZ_TYPES)[number])) {
    throw new AppError(ErrorCode.InvalidArgument, `biz_type 越域（${BIZ_TYPES.join('|')}）：${v}`);
  }
}

function toOrderView(row: OrderRow): PaymentOrderView {
  return {
    id: Number(row.id),
    biz_type: row.biz_type,
    biz_id: Number(row.biz_id),
    channel: row.channel,
    cash_amount: row.cash_amount,
    points_amount: row.points_amount,
    total: row.total,
    status: row.status as PaymentOrderStatus,
    idempotency_key: row.idempotency_key,
    channel_txn_no: row.channel_txn_no,
    created_at: new Date(row.created_at).toISOString(),
    paid_at: row.paid_at === null ? null : new Date(row.paid_at).toISOString(),
  };
}

@Injectable()
export class PaymentGatewayService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly router: ChannelRouter,
    private readonly alerts: PaymentAlertService,
    // Symbol token（纯 interface 无运行时类型）：module useFactory 装配，测试构造直传
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {}

  // ===========================================================================
  // 下单（§5 POST /pay/orders：{payment_order, pay_params}；409 DUP_KEY）
  // ===========================================================================

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    this.assertCreateOrderInput(input);
    // 幂等快路径：在册键直接按载荷比对（重放/409），不开事务
    const existing = await this.findOrderByKey(input.idempotency_key);
    if (existing) return this.replayOrder(existing, input);

    const row = await this.pool.withTransaction((uow) => this.claimOrderRow(uow, input));
    if (row.replayed) return this.replayOrder(row.row, input);
    return this.buildOrderResult(row.row);
  }

  /**
   * 同事务下单（§5 同口径的调用方事务形态）：C2 发布事务消费位——B2 lockSlot(payment_order_id
   * 绑定)+INSERT group_buys+支付单创建同事务（架构 §4.2），调用方在自己的业务事务内以 uow 调用，
   * 失败随调用方回滚不烧幂等键。校验/claim/通道预下单/重放比对与 createOrder 全同口径。
   */
  async createOrderInTx(uow: SqlExecutor, input: CreateOrderInput): Promise<CreateOrderResult> {
    this.assertCreateOrderInput(input);
    const row = await this.claimOrderRow(uow, input);
    if (row.replayed) return this.replayOrder(row.row, input);
    return this.buildOrderResult(row.row);
  }

  /** 幂等键定位支付单（导出只读面：C2 发布幂等重放回带原支付单；C3/T7 消费位）。不存在=null */
  async findOrderByIdempotencyKey(key: string): Promise<PaymentOrderView | null> {
    const row = await this.findOrderByKey(key);
    return row ? toOrderView(row) : null;
  }

  /**
   * id 定位支付单（导出只读面，M1-W3 T6 扩展——沿 T5 createOrderInTx 导出面扩展先例，加法不改
   * 既有契约）：F2 受理面金额守恒（R-04 累计退款 ≤ 支付额）需原支付拆分快照（简报「从 F1
   * payment_orders 读（服务面）」）。不存在=null（调用方自行语义化 404）。
   */
  async findOrderById(orderId: number): Promise<PaymentOrderView | null> {
    assertPositiveInt(orderId, 'order_id');
    const res = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE id = $1`,
      [orderId],
    );
    const row = res.rows[0];
    return row ? toOrderView(row) : null;
  }

  /** 入参校验收口（createOrder/createOrderInTx 共用） */
  private assertCreateOrderInput(input: CreateOrderInput): void {
    assertBizType(input.biz_type);
    assertPositiveInt(input.biz_id, 'biz_id');
    moneyToCents(assertMoney(input.cash_amount)); // 形态/越界校验（Money 字符串禁 float）
    assertPoints(input.points_amount);
    assertIdempotencyKey(input.idempotency_key);
  }

  /**
   * claim：唯一约束真兜底（并发同键第二笔在此败退转重放）；冲突分支读回原单返回 replayed=true
   * （统一走 replayOrder 载荷比对——同键同载荷=重放原单，异载荷=409 E_DUP_KEY）。
   */
  private async claimOrderRow(
    uow: SqlExecutor,
    input: CreateOrderInput,
  ): Promise<{ row: OrderRow; replayed: boolean }> {
    const claim = await uow.query<OrderRow>(
      `INSERT INTO payment.payment_orders
         (biz_type, biz_id, channel, cash_amount, points_amount, status, idempotency_key)
       VALUES ($1, $2, $3, $4::numeric, $5, 'CREATED', $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${ORDER_COLS}`,
      [
        input.biz_type,
        input.biz_id,
        this.config.primary.channel,
        input.cash_amount,
        input.points_amount,
        input.idempotency_key,
      ],
    );
    if (claim.rows.length === 0) {
      // 冲突分支（并发同键）：读回原单后必须走 replayOrder 载荷比对——
      // 同键同载荷=重放原单；异载荷=409 E_DUP_KEY（幂等铁律对并发路径与串行快路径同口径）
      const prev = await this.findOrderByKeyInTx(uow, input.idempotency_key);
      if (!prev) throw new AppError(ErrorCode.InternalError, '幂等键冲突但原单不可读（不应触达）');
      return { row: prev, replayed: true };
    }
    const inserted = claim.rows[0]!;

    // 通道预下单/冻结（§4）：经路由主→备；失败随事务回滚（claim 不烧键）。
    // 账单 PAY 行金额=支付总额（cash+points/100）——对账按 total 核对的口径锚点
    const out = await this.router.execute((a) =>
      a.preorder({
        orderId: Number(inserted.id),
        bizType: input.biz_type,
        bizId: input.biz_id,
        amount: centsToMoney(moneyToCents(input.cash_amount) + input.points_amount),
        pointsAmount: input.points_amount,
        idempotencyKey: input.idempotency_key,
      }),
    );
    await uow.query(
      `UPDATE payment.payment_orders SET channel = $2, channel_txn_no = $3 WHERE id = $1`,
      [inserted.id, out.adapter.channel, out.result.channelTxnNo],
    );
    if (out.degradedNow && out.degradedChannel !== null) {
      await this.recordDegraded(uow, out.degradedChannel);
    }
    const finalRow = await this.findOrderByIdInTx(uow, Number(inserted.id));
    return { row: finalRow, replayed: false };
  }

  /** 金额不变量断言（§9：生成列读回 vs 本地整化）+ 视图/支付参数构建（两下单入口共用） */
  private buildOrderResult(row: OrderRow): CreateOrderResult {
    assertAmountInvariant(row.cash_amount, row.points_amount, row.total);
    const view = toOrderView(row);
    const payParams: PayParamsView = {
      ...this.router.payParamsFor(row.channel as PaymentChannelName, view.id, row.biz_type),
      channel: row.channel,
    };
    return { payment_order: view, pay_params: payParams };
  }

  /** 下单重放判定：同键同载荷=返回原单+原 pay_params（确定性重建）；异载荷=409 E_DUP_KEY */
  private replayOrder(row: OrderRow, input: CreateOrderInput): CreateOrderResult {
    const same =
      row.biz_type === input.biz_type &&
      Number(row.biz_id) === input.biz_id &&
      row.cash_amount === input.cash_amount &&
      row.points_amount === input.points_amount;
    if (!same) {
      throw new AppError(
        ErrorCode.PaymentDuplicateKey,
        `幂等键 ${input.idempotency_key} 已绑定其他载荷（同键须同载荷重放）`,
      );
    }
    assertAmountInvariant(row.cash_amount, row.points_amount, row.total);
    const view = toOrderView(row);
    const payParams: PayParamsView = {
      ...this.router.payParamsFor(row.channel as PaymentChannelName, view.id, row.biz_type),
      channel: row.channel,
    };
    return { payment_order: view, pay_params: payParams };
  }

  // ===========================================================================
  // 生命周期推进（守卫 + STL；回调/Core 指令共用入口，HTTP 面不扩面）
  // ===========================================================================

  /** CREATED→FROZEN：支付成功（PAY_SUCCESS 回调推进），落 paid_at 与通道流水号 */
  async markFrozen(orderId: number, channelTxnNo: string | null): Promise<PaymentOrderView> {
    assertPositiveInt(orderId, 'order_id');
    return this.transition(orderId, 'FROZEN', 'pay_success', channelTxnNo, true);
  }

  /** FROZEN→PAID：业务确认支付（成团/接单确认，Core 指令） */
  async markPaid(orderId: number): Promise<PaymentOrderView> {
    assertPositiveInt(orderId, 'order_id');
    return this.transition(orderId, 'PAID', 'business_confirm', null, false);
  }

  /** REFUNDING→REFUNDED：退款完成（REFUND_SUCCESS 回调推进） */
  async markRefunded(orderId: number, channelTxnNo: string | null): Promise<PaymentOrderView> {
    assertPositiveInt(orderId, 'order_id');
    return this.transition(orderId, 'REFUNDED', 'refund_success', channelTxnNo, false);
  }

  /** →CLOSED（合法源：CREATED 未支付关单 / REFUNDED 退款关单 / SPLIT 归档；矩阵钉死其余拒绝） */
  async closeOrder(orderId: number, reason: string): Promise<PaymentOrderView> {
    assertPositiveInt(orderId, 'order_id');
    assertReason(reason);
    return this.transition(orderId, 'CLOSED', reason, null, false);
  }

  private async transition(
    orderId: number,
    to: PaymentOrderStatus,
    reason: string,
    channelTxnNo: string | null,
    touchesPaidAt: boolean,
  ): Promise<PaymentOrderView> {
    return this.pool.withTransaction(async (uow) => {
      const current = await uow.query<OrderRow>(
        `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const row = current.rows[0];
      if (!row) throw new AppError(ErrorCode.NotFound, `支付单 ${orderId} 不存在`);

      await this.guard.assertTransition(PAYMENT_ORDER_MACHINE, {
        entityId: orderId,
        from: row.status as PaymentOrderStatus,
        to,
        reason,
        uow,
      });

      const setClause =
        channelTxnNo !== null
          ? `status = $3, channel_txn_no = COALESCE($4, channel_txn_no)` +
            (touchesPaidAt ? ', paid_at = now()' : '')
          : `status = $3` + (touchesPaidAt ? ', paid_at = now()' : '');
      const params =
        channelTxnNo !== null ? [orderId, row.status, to, channelTxnNo] : [orderId, row.status, to];
      const updated = await uow.query<OrderRow>(
        `UPDATE payment.payment_orders SET ${setClause}
          WHERE id = $1 AND status = $2 RETURNING ${ORDER_COLS}`,
        params,
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `支付单 ${orderId} 已被并发迁移`);
      }
      return toOrderView(updated.rows[0]!);
    });
  }

  // ===========================================================================
  // 退款（§5 POST /pay/refund：指令下发 → REFUNDING；409 DUP 同口径；R-03）
  // ===========================================================================

  async refund(input: RefundInput): Promise<RefundView> {
    assertPositiveInt(input.order_id, 'order_id');
    moneyToCents(assertMoney(input.cash_refund));
    const points = assertPoints(input.points_refund);
    const reason = assertReason(input.reason);
    assertIdempotencyKey(input.idempotency_key);

    const refundTotalCents = moneyToCents(input.cash_refund) + points;
    const detail: LedgerDetail = {
      order_id: input.order_id,
      cash_refund: input.cash_refund,
      points_refund: points,
      reason,
    };

    return this.pool.withTransaction(async (uow) => {
      // claim（同下单：冲突行读回比对——同键同载荷重放 / 异载荷 409）
      const claim = await uow.query<LedgerRow>(
        `INSERT INTO payment.split_ledgers
           (period, channel, direction, amount, status, idempotency_key, detail)
         VALUES ((now() AT TIME ZONE 'Asia/Shanghai')::date, $1, 'REFUND',
                 $2::numeric, 'ISSUED', $3, $4::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${LEDGER_COLS}`,
        [
          this.config.primary.channel,
          centsToMoney(refundTotalCents),
          input.idempotency_key,
          JSON.stringify(detail),
        ],
      );
      if (claim.rows.length === 0) {
        const prev = await this.replayLedgerInTx(uow, input.idempotency_key, detail, 'REFUND');
        return this.refundReplayView(uow, prev, detail);
      }
      const ledger = claim.rows[0]!;

      const orderRes = await uow.query<OrderRow>(
        `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE id = $1 FOR UPDATE`,
        [input.order_id],
      );
      const order = orderRes.rows[0];
      if (!order) throw new AppError(ErrorCode.NotFound, `支付单 ${input.order_id} 不存在`);
      const from = order.status as PaymentOrderStatus;

      // 守卫：FROZEN/PAID/REFUNDED→REFUNDING（矩阵钉死；非法拒绝独立留痕）。
      // REFUNDING 在途再发部分退款：不重复走守卫（多笔部分退款并行在途是通道侧事实，
      // 由累计退款边界兜住总额；无状态变更即无迁移可留痕，markRefunded 回调仍按矩阵推进）。
      if (from !== 'REFUNDING') {
        await this.guard.assertTransition(PAYMENT_ORDER_MACHINE, {
          entityId: input.order_id,
          from,
          to: 'REFUNDING',
          reason: `refund:${reason}`,
          uow,
        });
      }

      // R-03 退款还原边界：单笔不超 cash/points 各自额度；累计退款（本行除外）+ 本次 ≤ total
      if (
        moneyToCents(input.cash_refund) > moneyToCents(order.cash_amount) ||
        points > order.points_amount
      ) {
        throw new AppError(ErrorCode.InvalidArgument, '退款额超过支付单对应币种额度');
      }
      const priorSum = await uow.query<{ s: string }>(
        `SELECT COALESCE(sum(amount), 0)::text AS s FROM payment.split_ledgers
          WHERE direction = 'REFUND' AND status = 'CONFIRMED'
            AND (detail ->> 'order_id')::bigint = $1 AND id <> $2`,
        [input.order_id, ledger.id],
      );
      const priorCents = dbNumericToCents(priorSum.rows[0]!.s || '0');
      if (priorCents + refundTotalCents > moneyToCents(order.total)) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `累计退款超支付单总额：已退 ${centsToMoney(priorCents)} + 本次 ${centsToMoney(refundTotalCents)} > ${order.total}`,
        );
      }

      // 通道指令：全额走 refund、部分走 partialRefund（R-03 原路退）
      const isFull = input.cash_refund === order.cash_amount && points === order.points_amount;
      const req = {
        orderId: input.order_id,
        amount: centsToMoney(refundTotalCents),
        idempotencyKey: input.idempotency_key,
      };
      const out = await this.router.execute((a) => (isFull ? a.refund(req) : a.partialRefund(req)));

      const updated = await uow.query<OrderRow>(
        `UPDATE payment.payment_orders SET status = 'REFUNDING'
          WHERE id = $1 AND status = $2 RETURNING ${ORDER_COLS}`,
        [input.order_id, from],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `支付单 ${input.order_id} 已被并发迁移`);
      }
      const ledgerView = await this.confirmLedger(uow, Number(ledger.id), out);
      if (out.degradedNow && out.degradedChannel !== null) {
        await this.recordDegraded(uow, out.degradedChannel);
      }

      return {
        ledger_id: ledgerView.id,
        order_id: input.order_id,
        direction: 'REFUND',
        amount: ledgerView.amount,
        status: ledgerView.status,
        channel: ledgerView.channel,
        channel_txn_no: ledgerView.channel_txn_no,
        idempotency_key: input.idempotency_key,
        cash_refund: input.cash_refund,
        points_refund: points,
        reason,
        order_status: 'REFUNDING',
        created_at: ledgerView.created_at,
      };
    });
  }

  // ===========================================================================
  // 分账（§5 POST /pay/split：splits 求和 ≤ 可分金额；PAID→SPLIT 唯一解冻节点）
  // ===========================================================================

  async split(input: SplitInput): Promise<SplitResultView> {
    assertPositiveInt(input.order_id, 'order_id');
    assertIdempotencyKey(input.idempotency_key);
    if (!Array.isArray(input.splits) || input.splits.length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, 'splits 须为非空数组');
    }
    let sumCents = 0;
    for (const item of input.splits) {
      if (
        typeof item.payee_type !== 'string' ||
        item.payee_type.length === 0 ||
        item.payee_type.length > 32
      ) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `payee_type 须为 1-32 字符：${JSON.stringify(item.payee_type)}`,
        );
      }
      // payee_id：实体接收方须正整数；platform（平台服务费，无业务实体位）恒 0 哨兵
      if (item.payee_type === 'platform') {
        if (item.payee_id !== 0) {
          throw new AppError(
            ErrorCode.InvalidArgument,
            `payee_type=platform 时 payee_id 须为 0：${JSON.stringify(item.payee_id)}`,
          );
        }
      } else {
        assertPositiveInt(item.payee_id, 'payee_id');
      }
      sumCents += moneyToCents(assertMoney(item.amount));
    }
    const detail: LedgerDetail = { order_id: input.order_id, splits: input.splits };

    return this.pool.withTransaction(async (uow) => {
      const claim = await uow.query<LedgerRow>(
        `INSERT INTO payment.split_ledgers
           (period, channel, direction, amount, status, idempotency_key, detail)
         VALUES ((now() AT TIME ZONE 'Asia/Shanghai')::date, $1, 'SPLIT',
                 $2::numeric, 'ISSUED', $3, $4::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${LEDGER_COLS}`,
        [
          this.config.primary.channel,
          centsToMoney(sumCents),
          input.idempotency_key,
          JSON.stringify(detail),
        ],
      );
      if (claim.rows.length === 0) {
        const prev = await this.replayLedgerInTx(uow, input.idempotency_key, detail, 'SPLIT');
        return this.splitReplayView(uow, prev, detail);
      }
      const ledger = claim.rows[0]!;

      const orderRes = await uow.query<OrderRow>(
        `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE id = $1 FOR UPDATE`,
        [input.order_id],
      );
      const order = orderRes.rows[0];
      if (!order) throw new AppError(ErrorCode.NotFound, `支付单 ${input.order_id} 不存在`);
      const from = order.status as PaymentOrderStatus;

      // splits 求和 ≤ 可分金额（可分上限=total；超 → 400）
      if (sumCents > moneyToCents(order.total)) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `splits 求和 ${centsToMoney(sumCents)} 超过可分金额 ${order.total}`,
        );
      }

      await this.guard.assertTransition(PAYMENT_ORDER_MACHINE, {
        entityId: input.order_id,
        from,
        to: 'SPLIT',
        reason: 'unfreeze_split',
        uow,
      });

      const out = await this.router.execute((a) =>
        a.unfreezeSplit({
          orderId: input.order_id,
          amount: centsToMoney(sumCents),
          idempotencyKey: input.idempotency_key,
        }),
      );

      const updated = await uow.query<OrderRow>(
        `UPDATE payment.payment_orders SET status = 'SPLIT', split_detail = $3::jsonb
          WHERE id = $1 AND status = $2 RETURNING ${ORDER_COLS}`,
        [input.order_id, from, JSON.stringify({ order_id: input.order_id, splits: input.splits })],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `支付单 ${input.order_id} 已被并发迁移`);
      }
      const ledgerView = await this.confirmLedger(uow, Number(ledger.id), out);
      if (out.degradedNow && out.degradedChannel !== null) {
        await this.recordDegraded(uow, out.degradedChannel);
      }

      return {
        ledger_id: ledgerView.id,
        order_id: input.order_id,
        direction: 'SPLIT',
        amount: ledgerView.amount,
        status: ledgerView.status,
        channel: ledgerView.channel,
        channel_txn_no: ledgerView.channel_txn_no,
        idempotency_key: input.idempotency_key,
        order_status: 'SPLIT',
        created_at: ledgerView.created_at,
      };
    });
  }

  // ===========================================================================
  // 违约扣减（§5 POST /pay/deduct：指令面+通道应答转发；余额事实源在业务模块台账）
  // ===========================================================================

  async deduct(input: DeductInput): Promise<DeductResultView> {
    assertPositiveInt(input.lawyer_id, 'lawyer_id');
    moneyToCents(assertMoney(input.amount));
    if (!DEDUCT_FROM.includes(input.from as DeductFrom)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `from 越域（settlement|deposit）：${String(input.from)}`,
      );
    }
    assertIdempotencyKey(input.idempotency_key);
    const detail: LedgerDetail = {
      lawyer_id: input.lawyer_id,
      from: input.from,
      amount: input.amount,
    };

    return this.pool.withTransaction(async (uow) => {
      const claim = await uow.query<LedgerRow>(
        `INSERT INTO payment.split_ledgers
           (period, channel, direction, amount, status, idempotency_key, detail)
         VALUES ((now() AT TIME ZONE 'Asia/Shanghai')::date, $1, 'DEDUCT',
                 $2::numeric, 'ISSUED', $3, $4::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${LEDGER_COLS}`,
        [this.config.primary.channel, input.amount, input.idempotency_key, JSON.stringify(detail)],
      );
      if (claim.rows.length === 0) {
        const prev = await this.replayLedgerInTx(uow, input.idempotency_key, detail, 'DEDUCT');
        return this.deductReplayView(prev, detail);
      }
      const ledger = claim.rows[0]!;

      let out;
      try {
        out = await this.router.execute((a) =>
          a.deduct({
            orderId: null,
            lawyerId: input.lawyer_id,
            amount: input.amount,
            from: input.from as 'settlement' | 'deposit',
            idempotencyKey: input.idempotency_key,
          }),
        );
      } catch (e) {
        if (e instanceof ChannelFaultError && e.kind === 'INSUFFICIENT') {
          // §5：400 INSUFFICIENT——通道业务应答透传（余额预检事实源在 F3/A3b 台账）
          throw new AppError(
            ErrorCode.InsufficientFunds,
            `违约扣减余额不足（${input.from}）：lawyer=${input.lawyer_id} amount=${input.amount}`,
          );
        }
        throw e;
      }

      const ledgerView = await this.confirmLedger(uow, Number(ledger.id), out);
      if (out.degradedNow && out.degradedChannel !== null) {
        await this.recordDegraded(uow, out.degradedChannel);
      }

      return {
        ledger_id: ledgerView.id,
        direction: 'DEDUCT',
        amount: ledgerView.amount,
        status: ledgerView.status,
        channel: ledgerView.channel,
        channel_txn_no: ledgerView.channel_txn_no,
        idempotency_key: input.idempotency_key,
        lawyer_id: input.lawyer_id,
        from: input.from as DeductFrom,
        created_at: ledgerView.created_at,
      };
    });
  }

  // ===========================================================================
  // 回调验签 → Inbox（§4/§5 POST /callbacks/{channel}；R-02 双唯一；403 SIGN_FAIL）
  // ===========================================================================

  /**
   * 回调入站：验签（HMAC-SHA256 over 原始报文字节，通道密钥）→ Inbox 插入（双唯一 ON CONFLICT
   * DO NOTHING 去重）→ 同事务出箱 PaymentCallbackInboxed → 返回 inboxed（HTTP 面 200；重复
   * 回调 inboxed=false 仍 200——通道侧重试语义「已受理」）。验签失败 403 E_SIGN_FAIL（不落任何痕）。
   *
   * biz_idempotency_key 构成（§3 口径归一）：{订单幂等键}:{channel_event_type}——同单不同事件
   * 互不误杀、同类型重复去重；订单幂等键经 shared 契约校验（§3 例 'enroll-123' 为示意形态）。
   * 本模块无事件消费（§6）：消费推进与 DEAD 标记由下游（Core/C3）经 markInbox* 调用。
   */
  async ingestCallback(
    channel: string,
    rawBody: Buffer | string,
    signature: string | null,
  ): Promise<{ inboxed: boolean; inbox_id: number | null }> {
    const secret =
      channel === this.config.primary.channel
        ? this.config.primary.secret
        : channel === this.config.backup.channel
          ? this.config.backup.secret
          : null;
    if (secret === null) {
      throw new AppError(ErrorCode.NotFound, `未知支付通道：${channel}`);
    }
    // 验签：原始字节级（rawBody 原文，非重序列化）；长度与十六进制形态先验，再常数时间比对
    const raw = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const provided = (signature ?? '').toLowerCase();
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const signatureOk =
      /^[0-9a-f]{64}$/.test(provided) &&
      timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
    if (!signatureOk) {
      throw new AppError(ErrorCode.SignVerificationFailed, `回调验签失败：channel=${channel}`);
    }

    // 报文形态（验签通过后才解析）：{order_id, event_type, channel_txn_no, ...通道原文}
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      body = parsed as Record<string, unknown>;
    } catch {
      throw new AppError(ErrorCode.InvalidArgument, '回调报文须为 JSON 对象');
    }
    const orderId = assertPositiveInt(body['order_id'], '回调 order_id');
    const eventType = body['event_type'];
    const channelTxnNo = body['channel_txn_no'];
    if (typeof eventType !== 'string' || eventType.length === 0 || eventType.length > 32) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `回调 event_type 须为 1-32 字符：${JSON.stringify(eventType)}`,
      );
    }
    if (typeof channelTxnNo !== 'string' || channelTxnNo.length === 0 || channelTxnNo.length > 64) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `回调 channel_txn_no 须为 1-64 字符：${JSON.stringify(channelTxnNo)}`,
      );
    }

    const order = await this.requireOrderById(orderId); // 无事务读：幂等键只读定位
    const bizIdempotencyKey = `${order.idempotency_key}:${eventType}`;

    return this.pool.withTransaction(async (uow) => {
      const claim = await uow.query<{ id: string }>(
        // 无目标 ON CONFLICT DO NOTHING 覆盖双唯一两方向（PG 每语句仅一个 ON CONFLICT 子句）。
        // M-3 载荷口径：落库=增补 channel 的 JSON（§3 inbox 无 channel 列，随 payload 携带），
        // 原始报文以验签瞬态存在（rawBody 字节仅参与 HMAC 比对后即弃），不另设原文列——
        // 回调重放/取证的原文事实源=通道侧重发。
        `INSERT INTO payment.inbox (channel_txn_no, biz_idempotency_key, payload, status)
         VALUES ($1, $2, $3::jsonb, 'RECEIVED')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [channelTxnNo, bizIdempotencyKey, JSON.stringify({ ...body, channel })],
      );
      if (claim.rows.length === 0) {
        // R-02 去重：重复回调不重复出箱（消费幂等由唯一约束承担）
        return { inboxed: false, inbox_id: null };
      }
      const inboxId = Number(claim.rows[0]!.id);
      await this.outbox.recordOutbox(uow, {
        type: PAYMENT_CALLBACK_INBOXED_TOPIC,
        payload: {
          biz_idempotency_key: bizIdempotencyKey,
          event: eventType,
        } satisfies PaymentCallbackInboxedPayload,
      });
      return { inboxed: true, inbox_id: inboxId };
    });
  }

  /** Inbox 消费成功标记（RECEIVED→CONSUMED，落 consumed_at；下游消费推进完成后调用） */
  async markInboxConsumed(inboxId: number): Promise<void> {
    assertPositiveInt(inboxId, 'inbox_id');
    await this.markInbox(inboxId, 'CONSUMED', 'consumed');
  }

  /**
   * Inbox 死信标记（RECEIVED→DEAD，死信语义）+ 告警位：乱序/毒消息——业务推进被守卫拒后由
   * 消费侧调用；告警经 mock sink（M2+ 换装真实通道，工单位=H3）。
   */
  async markInboxDead(inboxId: number, reason: string): Promise<void> {
    assertPositiveInt(inboxId, 'inbox_id');
    assertReason(reason);
    const row = await this.markInbox(inboxId, 'DEAD', `dead:${reason}`);
    await this.alerts.alertCallbackDead({
      kind: 'CALLBACK_DEAD',
      inboxId,
      channel: row.channel,
      bizIdempotencyKey: row.biz_idempotency_key,
      reason,
    });
  }

  private async markInbox(
    inboxId: number,
    to: 'CONSUMED' | 'DEAD',
    reason: string,
  ): Promise<{ channel: string; biz_idempotency_key: string }> {
    return this.pool.withTransaction(async (uow) => {
      const res = await uow.query<{
        id: string;
        status: string;
        channel: string;
        biz_idempotency_key: string;
      }>(
        `SELECT id, status, payload ->> 'channel' AS channel, biz_idempotency_key
           FROM payment.inbox WHERE id = $1 FOR UPDATE`,
        [inboxId],
      );
      const row = res.rows[0];
      if (!row) throw new AppError(ErrorCode.NotFound, `Inbox 行 ${inboxId} 不存在`);

      await this.guard.assertTransition(PAYMENT_INBOX_MACHINE, {
        entityId: inboxId,
        from: row.status as 'RECEIVED' | 'CONSUMED' | 'DEAD',
        to,
        reason,
        uow,
      });

      const updated = await uow.query<{ id: string }>(
        `UPDATE payment.inbox SET status = $3::varchar,
           consumed_at = CASE WHEN $3::varchar = 'CONSUMED' THEN now() ELSE consumed_at END
         WHERE id = $1 AND status = $2 RETURNING id`,
        [inboxId, row.status, to],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `Inbox 行 ${inboxId} 已被并发迁移`);
      }
      return { channel: row.channel, biz_idempotency_key: row.biz_idempotency_key };
    });
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  private async findOrderByKey(key: string): Promise<OrderRow | null> {
    const res = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE idempotency_key = $1`,
      [key],
    );
    return res.rows[0] ?? null;
  }

  private async findOrderByKeyInTx(uow: SqlExecutor, key: string): Promise<OrderRow | null> {
    const res = await uow.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE idempotency_key = $1`,
      [key],
    );
    return res.rows[0] ?? null;
  }

  /** id 定位支付单（不存在即 404——回调 Ingest 的强依赖定位）；只读变体见 findOrderById */
  private async requireOrderById(id: number): Promise<OrderRow> {
    const res = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.NotFound, `支付单 ${id} 不存在`);
    return row;
  }

  private async findOrderByIdInTx(uow: SqlExecutor, id: number): Promise<OrderRow> {
    const res = await uow.query<OrderRow>(
      `SELECT ${ORDER_COLS} FROM payment.payment_orders WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.InternalError, `支付单 ${id} 插入后不可读（不应触达）`);
    return row;
  }

  /**
   * 指令流水重放判定（refund/split/deduct 共用）：同键同载荷=返回首访流水行；
   * 方向/载荷不一致=409 E_DUP_KEY。
   */
  private async replayLedgerInTx(
    uow: SqlExecutor,
    key: string,
    detail: LedgerDetail,
    expect: 'REFUND' | 'SPLIT' | 'DEDUCT',
  ): Promise<LedgerRow> {
    const res = await uow.query<LedgerRow>(
      `SELECT ${LEDGER_COLS} FROM payment.split_ledgers WHERE idempotency_key = $1`,
      [key],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.InternalError, '幂等流水不可读（不应触达）');
    if (row.direction !== expect) {
      throw new AppError(
        ErrorCode.PaymentDuplicateKey,
        `幂等键 ${key} 已绑定 ${row.direction} 指令（不能复用于 ${expect}）`,
      );
    }
    if (!this.sameLedgerDetail(row.detail, detail)) {
      throw new AppError(
        ErrorCode.PaymentDuplicateKey,
        `幂等键 ${key} 已绑定其他载荷（同键须同载荷重放）`,
      );
    }
    return row;
  }

  /**
   * splits 结构等值（jsonb 复读会重排对象键——禁 JSON 文本比对；逐项字段比对，
   * payee_id 走 Number 归一（jsonb number 与入参 number 恒等））。
   */
  private static sameSplits(a?: readonly SplitItem[], b?: readonly SplitItem[]): boolean {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((it, i) => {
      const other = b[i]!;
      return (
        it.payee_type === other.payee_type &&
        Number(it.payee_id) === Number(other.payee_id) &&
        it.amount === other.amount
      );
    });
  }

  private sameLedgerDetail(stored: LedgerDetail | null, detail: LedgerDetail): boolean {
    if (!stored) return false;
    if (stored.cash_refund !== undefined || detail.cash_refund !== undefined) {
      return (
        stored.order_id === detail.order_id &&
        stored.cash_refund === detail.cash_refund &&
        stored.points_refund === detail.points_refund &&
        stored.reason === detail.reason
      );
    }
    if (stored.splits !== undefined || detail.splits !== undefined) {
      return (
        stored.order_id === detail.order_id &&
        PaymentGatewayService.sameSplits(stored.splits, detail.splits)
      );
    }
    return (
      stored.lawyer_id === detail.lawyer_id &&
      stored.from === detail.from &&
      (stored.amount ?? null) === (detail.amount ?? null)
    );
  }

  private async orderStatusInTx(uow: SqlExecutor, orderId: number): Promise<PaymentOrderStatus> {
    const res = await uow.query<{ status: PaymentOrderStatus }>(
      `SELECT status FROM payment.payment_orders WHERE id = $1`,
      [orderId],
    );
    return res.rows[0]?.status ?? 'CREATED';
  }

  private refundReplayView(
    uow: SqlExecutor,
    row: LedgerRow,
    detail: LedgerDetail,
  ): Promise<RefundView> {
    const orderId = detail.order_id ?? 0;
    return this.orderStatusInTx(uow, orderId).then((order_status) => ({
      ledger_id: Number(row.id),
      order_id: orderId,
      direction: 'REFUND' as const,
      amount: row.amount,
      status: row.status as 'ISSUED' | 'CONFIRMED',
      channel: row.channel,
      channel_txn_no: row.detail?.channel_txn_no ?? null,
      idempotency_key: row.idempotency_key ?? '',
      cash_refund: detail.cash_refund ?? '0.00',
      points_refund: detail.points_refund ?? 0,
      reason: detail.reason ?? '',
      order_status,
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  private splitReplayView(
    uow: SqlExecutor,
    row: LedgerRow,
    detail: LedgerDetail,
  ): Promise<SplitResultView> {
    const orderId = detail.order_id ?? 0;
    return this.orderStatusInTx(uow, orderId).then((order_status) => ({
      ledger_id: Number(row.id),
      order_id: orderId,
      direction: 'SPLIT' as const,
      amount: row.amount,
      status: row.status as 'ISSUED' | 'CONFIRMED',
      channel: row.channel,
      channel_txn_no: row.detail?.channel_txn_no ?? null,
      idempotency_key: row.idempotency_key ?? '',
      order_status,
      created_at: new Date(row.created_at).toISOString(),
    }));
  }

  private deductReplayView(row: LedgerRow, detail: LedgerDetail): DeductResultView {
    return {
      ledger_id: Number(row.id),
      direction: 'DEDUCT',
      amount: row.amount,
      status: row.status as 'ISSUED' | 'CONFIRMED',
      channel: row.channel,
      channel_txn_no: row.detail?.channel_txn_no ?? null,
      idempotency_key: row.idempotency_key ?? '',
      lawyer_id: detail.lawyer_id ?? 0,
      from: (detail.from ?? 'settlement') as DeductFrom,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  /** 指令落定：流水转 CONFIRMED 并回填通道应答（channel_txn_no 入 detail——对账核对锚点） */
  private async confirmLedger(
    uow: SqlExecutor,
    ledgerId: number,
    out: {
      readonly adapter: { readonly channel: string };
      readonly result: { readonly channelTxnNo: string };
      readonly degradedNow: boolean;
    },
  ): Promise<{
    id: number;
    amount: Money;
    status: 'ISSUED' | 'CONFIRMED';
    channel: string;
    channel_txn_no: string | null;
    created_at: string;
  }> {
    const updated = await uow.query<LedgerRow>(
      // §3 模型 split_ledgers 无 channel_txn_no 列——通道流水号入 detail（对账核对锚点）
      `UPDATE payment.split_ledgers
         SET channel = $2, status = 'CONFIRMED',
             detail = jsonb_set(COALESCE(detail, '{}'::jsonb), '{channel_txn_no}', to_jsonb($3::text))
       WHERE id = $1 RETURNING ${LEDGER_COLS}`,
      [ledgerId, out.adapter.channel, out.result.channelTxnNo],
    );
    if (updated.rows.length === 0) {
      throw new AppError(ErrorCode.InternalError, `指令流水 ${ledgerId} 不可读（不应触达）`);
    }
    const row = updated.rows[0]!;
    return {
      id: Number(row.id),
      amount: row.amount,
      status: row.status as 'ISSUED' | 'CONFIRMED',
      channel: row.channel,
      channel_txn_no: out.result.channelTxnNo,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  private async recordDegraded(uow: SqlExecutor, channel: string): Promise<void> {
    await this.outbox.recordOutbox(uow, {
      type: CHANNEL_DEGRADED_TOPIC,
      payload: { channel } satisfies ChannelDegradedPayload,
    });
  }
}
