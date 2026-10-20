/**
 * D6 事件消费端（M2-W3 T2；§6 消费面）：
 *   ① PaymentCallbackInboxed（payment.callback.inboxed，F1 既有出口）：event=PAY_SUCCESS →
 *      按订单幂等键定位（ooo/o{id}/pay=预付 / ooo/o{id}/diff=补差——非 ooo 形态键跳过，
 *      消费权归 C3/C2 等）→ F1 冻结推进（R-01 支付即冻结，enrollment.consumer 同款）→
 *      预付=onPaySuccess（PAID+accept_deadline+OneOnOnePaid 出箱+OOO_ACCEPT_TIMEOUT 预写）/
 *      补差=onDiffPaySuccess（DIFF_PENDING→SETTLED+OneOnOneSettled）→ inbox CONSUMED。
 *   ② RefundCompleted（payment.refund.completed，F2 真生产；与 C3 收敛消费器/G1-H4 同 topic
 *      扇出并存）：按退款单定位支付单 → ooo/o{id}/pay 形态 → advanceRefundCompleted
 *      （LAWYER_TIMEOUT→REFUNDED / CANCELLED→REFUNDED|PARTIAL_REFUNDED——取消受理崩溃窗口
 *      兜底；已终态幂等短路）。
 *   ③ MessageSent（fulfillment.conversation.message_sent，D5 生产不变——与 E1=W3 T4 新消费
 *      扇出并存）：one_on_one 会话消息 → onMessageSent（text 锚=W3-8：accept 后首条用户消息
 *      触发 IN_SERVICE；轮次=消息表确定性重算——用户问+律师答=1 轮，consumed_units 增量维护）。
 *
 * 事务形态（enrollment.consumer 先例）：守卫自持事务（服务面 pool.withTransaction——效果与
 * inbox/SENT 标记不同事务）；崩溃窗口「业务已提交而标记未落」→ 重投由状态幂等短路收敛
 * （PAY_SUCCESS 重放不双推进）。inbox 标记先读 status（RECEIVED 才动——重复标记会被 inbox
 * 守卫拒成永久重试环）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  MESSAGE_SENT_TOPIC,
  PAYMENT_CALLBACK_INBOXED_TOPIC,
  REFUND_COMPLETED_TOPIC,
  type RefundCompletedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { OneOnOneService } from './one-on-one.service';
import { parseOooOrderKey } from './one-on-one.types';
import { moneyToCents } from './room.types';

const PAY_SUCCESS_SUFFIX = ':PAY_SUCCESS';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * PAY_SUCCESS 回调 handler（F1 Inbox 既有出口）：键形态过滤（非 ooo 键跳过——各归其位）→
 * F1 冻结推进（幂等/StateStale 容忍）→ 预付/补差收敛 → inbox 消费标记（读-判-标）。
 * 订单不可读/载荷漂移 → 抛错进 relay 重试轨道（不静默丢弃）。
 */
export function createOooPayCallbackHandler(
  orders: OneOnOneService,
  payment: PaymentGatewayService,
): OutboxHandler {
  const logger = new Logger('OooPayGuard');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== PAYMENT_CALLBACK_INBOXED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `1对1 回调消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as { biz_idempotency_key?: string; event?: string };
    if (payload.event !== 'PAY_SUCCESS') return; // REFUND_SUCCESS=F2 域；未知事件归 F2 消费器
    const bizKey = payload.biz_idempotency_key;
    if (typeof bizKey !== 'string' || !bizKey.endsWith(PAY_SUCCESS_SUFFIX)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `PAY_SUCCESS 事件载荷 biz_idempotency_key 缺失或无事件后缀（进重试轨道，不静默丢弃）`,
      );
    }
    const orderKey = bizKey.slice(0, -PAY_SUCCESS_SUFFIX.length);
    const ref = parseOooOrderKey(orderKey);
    if (ref === null) {
      // 非 1对1 形态键（C3 报名 enroll/e{id}/pay、C2 发布单等）：跳过不消费（inbox 留 RECEIVED）
      logger.log(`回调订单键 ${orderKey} 非 1对1 形态，跳过（event_id=${event.eventId}）`);
      return;
    }

    const order = await payment.findOrderByIdempotencyKey(orderKey);
    if (!order) {
      throw new AppError(
        ErrorCode.NotFound,
        `PAY_SUCCESS 订单不可读：${orderKey}（进重试轨道，不静默丢弃）`,
      );
    }

    // R-01 支付即冻结（F1 冻结指令）：CREATED→FROZEN（paid_at 落值锚）；幂等+并发败者容忍
    let paidAtIso = order.paid_at;
    if (order.status === 'CREATED') {
      try {
        const frozen = await payment.markFrozen(order.id, null);
        paidAtIso = frozen.paid_at ?? paidAtIso;
      } catch (e) {
        if (!(e instanceof AppError && e.code === ErrorCode.StateStaleEntity)) {
          throw e; // 并发同单败者=竞态良性（重投短路），其余上抛重试
        }
      }
    }
    if (paidAtIso === null) {
      throw new AppError(
        ErrorCode.InternalError,
        `PAY_SUCCESS 订单 ${orderKey} 无 paid_at（FROZEN 推进后应落值——不应触达）`,
      );
    }

    if (ref.kind === 'pay') {
      await orders.onPaySuccess(ref.orderId, new Date(paidAtIso));
      logger.log(`1对1 预付收敛：订单 ${ref.orderId} → PAID（order=${order.id}）`);
    } else {
      await orders.onDiffPaySuccess(ref.orderId);
      logger.log(`1对1 补差收敛：订单 ${ref.orderId} → SETTLED（order=${order.id}）`);
    }

    // inbox 消费标记（读-判-标经 F1 导出面——跨域禁直查 payment-inbox 表，架构 §3.2）
    const inbox = await payment.findInboxRowByKey(bizKey);
    if (inbox && inbox.status === 'RECEIVED') {
      await payment.markInboxConsumed(inbox.id);
    }
  };
}

/**
 * RefundCompleted 收敛 handler：按退款单定位支付单 → ooo 预付形态键 → 订单终态收敛
 * （LAWYER_TIMEOUT→REFUNDED / CANCELLED→REFUNDED|PARTIAL_REFUNDED）。非 ooo 键=跳过
 * （C3 报名单等）；订单不可读 → 抛错进重试轨道。
 */
export function createOooRefundCompletedHandler(
  orders: OneOnOneService,
  payment: PaymentGatewayService,
): OutboxHandler {
  const logger = new Logger('OooRefundDone');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== REFUND_COMPLETED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `1对1 退款收敛消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<RefundCompletedPayload>;
    if (!isPositiveInt(payload.order_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `RefundCompleted 载荷缺 order_id（进重试轨道，不静默丢弃）`,
      );
    }
    const order = await payment.findOrderById(payload.order_id);
    if (!order) {
      throw new AppError(
        ErrorCode.NotFound,
        `RefundCompleted 订单不可读：${payload.order_id}（进重试轨道）`,
      );
    }
    const ref = parseOooOrderKey(order.idempotency_key);
    if (ref === null || ref.kind !== 'pay') return; // 非 1对1 预付单退款（补差单退款=M5 联调位）——跳过
    const amounts = payload.amounts as { cash?: unknown; points?: unknown } | undefined;
    const refundCents =
      moneyToCents((typeof amounts?.cash === 'string' ? amounts.cash : '0.00') as never) +
      (typeof amounts?.points === 'number' && Number.isFinite(amounts.points) ? amounts.points : 0);
    await orders.advanceRefundCompleted(ref.orderId, refundCents);
    logger.log(`1对1 退款完成收敛：订单 ${ref.orderId}（order=${order.id}）`);
  };
}

/** MessageSent handler（D5 生产不变）：one_on_one 会话计量面（text 锚+轮次；非该型跳过） */
export function createOooMessageSentHandler(orders: OneOnOneService): OutboxHandler {
  const logger = new Logger('OooMessageSent');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== MESSAGE_SENT_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `1对1 消息计量消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as { conversation_id?: unknown; seq?: unknown };
    if (!isPositiveInt(payload.conversation_id) || !isPositiveInt(payload.seq)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `MessageSent 载荷缺 conversation_id/seq（进重试轨道，不静默丢弃）`,
      );
    }
    const out = await orders.onMessageSent(payload.conversation_id, payload.seq);
    if (out.applied) {
      logger.log(
        `1对1 消息计量：conversation=${payload.conversation_id} seq=${payload.seq} rounds=${String(out.rounds)}`,
      );
    }
  };
}

@Injectable()
export class OneOnOneConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly orders: OneOnOneService,
    private readonly payment: PaymentGatewayService,
  ) {}

  onModuleInit(): void {
    // 同 topic 多 handler 扇出由 relay 承接（PaymentCallbackInboxed=F2/C3 消费器并存；
    // RefundCompleted=C3 收敛/G1-H4 管道并存；MessageSent=D5 内部消费/E1=W3 T4 预留并存）
    this.relay.registerHandler(
      PAYMENT_CALLBACK_INBOXED_TOPIC,
      createOooPayCallbackHandler(this.orders, this.payment),
    );
    this.relay.registerHandler(
      REFUND_COMPLETED_TOPIC,
      createOooRefundCompletedHandler(this.orders, this.payment),
    );
    this.relay.registerHandler(MESSAGE_SENT_TOPIC, createOooMessageSentHandler(this.orders));
  }
}
