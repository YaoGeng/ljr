/**
 * F2 事件消费端（§6 消费 + R-W3-M 裁决 + 简报「事件消费面仅接 SessionFailed」）：
 *   ① SessionFailed（trade.session.failed，C1 真生产）：流标批量全员退款——付款人清单经
 *      RefundSource 注册表（'session' 键；T6 假源/T7 trade 真源同形），逐单独立事务受理
 *      GROUP_FAIL 全额退款（幂等键=refund/po-{id}/group-fail 防重），部分失败收集后整体抛错
 *      进 relay 重试轨道 → 重入只补未受理单（§10 可重入续跑）。
 *   ② PaymentCallbackInboxed（payment.callback.inboxed，F1 既有出口不改其契约）：
 *      event=REFUND_SUCCESS → 按订单幂等键（biz 键去事件后缀）收敛退款单 DONE+还原+F1 单
 *      REFUNDING→REFUNDED（守卫推进）→ inbox CONSUMED；PAY_SUCCESS noop（C3=T7 消费位，
 *      不动 inbox——消费权归 C3）。
 *   其余发起方事件（GroupBuyExpired/LawyerRejected/SessionCancelled...）=M2 生产方桩接线位。
 *
 * 事务形态（credit/firm-merchant 消费先例）：handler 不用 relay 认领事务的 uow——RefundService
 * 自持事务，崩溃窗口「已提交而 SENT 未标」→ 重投由幂等短路（at-least-once 语义内）。
 * inbox 标记：先读 status（CONSUMED/DEAD 跳过——重复标记会被 inbox 守卫拒成永久重试环），
 * RECEIVED 才 markInboxConsumed；竞态窗口输方靠重投跳过收敛。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  PAYMENT_CALLBACK_INBOXED_TOPIC,
  REFUND_SOURCE_REF_TYPE_SESSION,
  SESSION_FAILED_TOPIC,
  type RefundSourceOrder,
  type SessionFailedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { PaymentGatewayService } from './payment.gateway.service';
import { RefundService } from './refund.service';
import { RefundSourceRegistry } from './refund.source';

const REFUND_SUCCESS_SUFFIX = ':REFUND_SUCCESS';

/** relay 认领事务的 client（OutboxHandler 第二参同形别名；handler 内仅作 inbox 定位读） */
type RelayUow = Parameters<OutboxHandler>[1];

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function assertSourceOrder(raw: unknown, index: number): RefundSourceOrder {
  const row = (raw ?? {}) as Partial<RefundSourceOrder>;
  if (
    !isPositiveInt(row.payment_order_id) ||
    !isPositiveInt(row.user_id) ||
    typeof row.cash_amount !== 'string' ||
    !/^\d+\.\d{2}$/.test(row.cash_amount) ||
    !isNonNegativeInt(row.points_amount)
  ) {
    // 退款源载荷漂移显性化（不静默）：整批进重试轨道，由源实现方修复
    throw new AppError(
      ErrorCode.InvalidArgument,
      `退款源清单第 ${index} 行载荷非法（须 payment_order_id/user_id 正整数、cash_amount 两位小数、points 非负整数）`,
    );
  }
  return row as RefundSourceOrder;
}

/** 独立可测的 SessionFailed 批量退款 handler */
export function createSessionFailedHandler(
  refunds: RefundService,
  sources: RefundSourceRegistry,
): OutboxHandler {
  const logger = new Logger('RefundBatch');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== SESSION_FAILED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `批量退款消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<SessionFailedPayload>;
    if (!isPositiveInt(payload.id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `事件 ${event.topic} 载荷缺 id（进重试轨道，不静默丢弃）`,
      );
    }
    const source = sources.resolve(REFUND_SOURCE_REF_TYPE_SESSION);
    if (!source) {
      // R-W3-M：T6 期 trade 侧真实实现不存在——warn 跳过不炸（返回即 SENT，重投无意义，
      // 会话流标重放由 T7 接线后的新事件/重放承担）；显性 warn 留痕不静默。
      logger.warn(
        `SessionFailed 批量退款跳过：未注册 'session' 退款源（session=${payload.id}，event_id=${event.eventId}；T7 C3 接线位）`,
      );
      return;
    }
    const listed = await source.listPaidPaymentOrders(payload.id);
    const orders = listed.map((raw, i) => assertSourceOrder(raw, i));

    const failures: { payment_order_id: number; message: string }[] = [];
    for (const order of orders) {
      try {
        // 逐单独立事务（受理自持）：断点续跑语义——重入时已落单的走幂等重放短路
        await refunds.accept({
          order_id: order.payment_order_id,
          user_id: order.user_id,
          cash: order.cash_amount,
          points: order.points_amount,
          reason: 'GROUP_FAIL',
          idempotency_key: `refund/po-${order.payment_order_id}/group-fail`,
        });
      } catch (e) {
        failures.push({
          payment_order_id: order.payment_order_id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (failures.length > 0) {
      // 整体抛错进 relay 重试轨道：重入只补未受理单（已 DONE/PROCESSING 幂等短路）
      throw new AppError(
        ErrorCode.OutboxHandlerFailed,
        `SessionFailed 批量退款部分失败（session=${payload.id}）：${failures
          .map((f) => `po-${f.payment_order_id}: ${f.message}`)
          .join('；')}`,
      );
    }
    logger.log(`SessionFailed 批量退款受理完成：session=${payload.id} 单数=${orders.length}`);
  };
}

/**
 * 已知回调事件允许清单（评审 Minor-4）：REFUND_SUCCESS=本域收敛；PAY_SUCCESS=C3=T7 消费位。
 * 清单外值=通道/上游漂移信号 → warn 显性化（不抛防毒丸；M2 扩展事件时同步本清单）。
 */
const KNOWN_CALLBACK_EVENTS: ReadonlySet<string> = new Set(['PAY_SUCCESS', 'REFUND_SUCCESS']);

/** 独立可测的 REFUND_SUCCESS 回调 handler（F1 Inbox 既有出口） */
export function createRefundCallbackHandler(
  refunds: RefundService,
  payment: PaymentGatewayService,
): OutboxHandler {
  const logger = new Logger('RefundCallback');
  return async (event: RelayEvent, uow: RelayUow): Promise<void> => {
    if (event.topic !== PAYMENT_CALLBACK_INBOXED_TOPIC) {
      throw new AppError(ErrorCode.InvalidArgument, `回调消费器收到未注册 topic：${event.topic}`);
    }
    const payload = (event.payload ?? {}) as { biz_idempotency_key?: string; event?: string };
    if (payload.event !== 'REFUND_SUCCESS') {
      const eventName = payload.event ?? '<unknown>';
      if (!KNOWN_CALLBACK_EVENTS.has(eventName)) {
        // 清单外未知事件：warn 显性化可观测（不抛——防毒消息重投循环）；事件将按 SENT 归档
        logger.warn(
          `未知回调事件 ${JSON.stringify(eventName)}（允许清单外：${[...KNOWN_CALLBACK_EVENTS].join('|')}；不抛防毒丸，biz=${payload.biz_idempotency_key ?? '<none>'}）`,
        );
      } else {
        // PAY_SUCCESS：C3=T7 消费位（noop 不动 inbox——消费权归 C3）
        logger.log(`回调事件 ${eventName} 非退款链，跳过（C3=T7 消费位）`);
      }
      return;
    }
    const bizKey = payload.biz_idempotency_key;
    if (typeof bizKey !== 'string' || !bizKey.endsWith(REFUND_SUCCESS_SUFFIX)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `REFUND_SUCCESS 事件载荷 biz_idempotency_key 缺失或无事件后缀（进重试轨道，不静默丢弃）`,
      );
    }
    const orderKey = bizKey.slice(0, -REFUND_SUCCESS_SUFFIX.length);

    // 退款单收敛（DONE+RefundCompleted 出箱+R-03 还原，自持事务）
    await refunds.convergeRefundSuccess(orderKey);

    // F1 单生命周期推进（守卫在 REFUNDING 才发——多次部分退款错序回调防环）+ inbox 消费标记
    const order = await payment.findOrderByIdempotencyKey(orderKey);
    if (order && order.status === 'REFUNDING') {
      await payment.markRefunded(order.id, null);
    }
    const inbox = await uow.query<{ id: string; status: string }>(
      `SELECT id, status FROM payment.inbox WHERE biz_idempotency_key = $1`,
      [bizKey],
    );
    const row = inbox.rows[0];
    if (row && row.status === 'RECEIVED') {
      await payment.markInboxConsumed(Number(row.id));
    }
    logger.log(`REFUND_SUCCESS 收敛完成：order=${orderKey}`);
  };
}

@Injectable()
export class RefundConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly refunds: RefundService,
    private readonly sources: RefundSourceRegistry,
    private readonly payment: PaymentGatewayService,
  ) {}

  onModuleInit(): void {
    // 同 topic 双 handler 扇出由 relay 承接；SessionFailed 独占 topic
    this.relay.registerHandler(
      SESSION_FAILED_TOPIC,
      createSessionFailedHandler(this.refunds, this.sources),
    );
    this.relay.registerHandler(
      PAYMENT_CALLBACK_INBOXED_TOPIC,
      createRefundCallbackHandler(this.refunds, this.payment),
    );
  }
}
