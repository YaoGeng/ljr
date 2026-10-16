/**
 * C3 事件消费端（§6 消费 + Task 7 简报裁决）：
 *   ① PaymentCallbackInboxed（payment.callback.inboxed，F1 既有出口）：event=PAY_SUCCESS →
 *      按 F1 订单幂等键定位报名（键=enroll/e{id}/pay；非报名形态键=C2 发布单 groupbuy/g{id}/pay
 *      等——M2 C4 域，跳过不消费）→ F1 冻结推进（R-01「支付即冻结」：CREATED→FROZEN，幂等）→
 *      onPaySuccess 成团原子守卫 → 席位被拒走 refundIfRejected 自动退款分支 → inbox CONSUMED。
 *   ② SessionFailed（trade.session.failed，C1 真事件；与 F2 批量退款消费器同 topic 扇出并存）：
 *      PENDING 未支付清场（R-W3-O——UNFREEZE 解冻；F1 单保持 CREATED 不发明关单指令）。
 *   ③ RefundCompleted（payment.refund.completed，F2 真生产）：enrollment →REFUNDED 终态收敛
 *      （PAID→REFUNDED 主链/PENDING→REFUNDED 兜底；已终态短路幂等）。
 *   **不注册** RESTRICTION_ISSUED / CREDIT_EVENT_EMITTED 消费者（简报裁决：入口拉取校验已足，
 *   w2-smoke 的 RI/CEE noop 维持 TODO(H4) 不动——报告注明）。
 *
 * 事务形态（refund.consumer 先例）：守卫自持事务（先提交后标记）；inbox 标记先读 status
 * （CONSUMED/DEAD 跳过——重复标记会被 inbox 守卫拒成永久重试环），RECEIVED 才 markInboxConsumed。
 * 崩溃窗口「业务已提交而 inbox 未标」→ 重投由 onPaySuccess/refundIfRejected 幂等短路收敛。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  GROUP_BUY_EXPIRED_TOPIC,
  PAYMENT_CALLBACK_INBOXED_TOPIC,
  REFUND_COMPLETED_TOPIC,
  SESSION_FAILED_TOPIC,
  type RefundCompletedPayload,
  type SessionFailedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { EnrollmentService } from './enrollment.service';
import { parseEnrollmentOrderKey } from './enrollment.types';

const PAY_SUCCESS_SUFFIX = ':PAY_SUCCESS';

/** relay 认领事务的 client（OutboxHandler 第二参同形别名；handler 内仅作 inbox 定位读） */
type RelayUow = Parameters<OutboxHandler>[1];

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * PAY_SUCCESS 回调 handler（F1 Inbox 既有出口）。ORDERED 步骤（幂等均内建）：
 *   1) 键形态过滤：非报名键跳过（C2 发布单/未来域单——消费者各归其位）；
 *   2) F1 冻结推进（R-01）：CREATED→FROZEN（先决于退款分支的 REFUNDING 合法源态）；
 *   3) 成团原子守卫（§4）；席位被拒 → 自动退款分支（F2 受理+终态化+解冻）；
 *   4) inbox 消费标记（RECEIVED 才动；重复投递跳过）。
 * 订单不可读/载荷漂移 → 抛错进 relay 重试轨道（不静默丢弃）。
 */
export function createEnrollPayCallbackHandler(
  enrollments: EnrollmentService,
  payment: PaymentGatewayService,
): OutboxHandler {
  const logger = new Logger('EnrollPayGuard');
  return async (event: RelayEvent, uow: RelayUow): Promise<void> => {
    if (event.topic !== PAYMENT_CALLBACK_INBOXED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `报名回调消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as { biz_idempotency_key?: string; event?: string };
    if (payload.event !== 'PAY_SUCCESS') return; // REFUND_SUCCESS=F2 域；未知事件 warn 归 F2 消费器
    const bizKey = payload.biz_idempotency_key;
    if (typeof bizKey !== 'string' || !bizKey.endsWith(PAY_SUCCESS_SUFFIX)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `PAY_SUCCESS 事件载荷 biz_idempotency_key 缺失或无事件后缀（进重试轨道，不静默丢弃）`,
      );
    }
    const orderKey = bizKey.slice(0, -PAY_SUCCESS_SUFFIX.length);
    const enrollmentId = parseEnrollmentOrderKey(orderKey);
    if (enrollmentId === null) {
      // 非报名形态键（C2 发布单 groupbuy/g{id}/pay=M2 C4 域）：跳过不消费（inbox 留 RECEIVED，
      // 消费权归属方；w2-smoke「noop 承接」同款纪律——报告注明）
      logger.log(`回调订单键 ${orderKey} 非报名形态，跳过（event_id=${event.eventId}）`);
      return;
    }

    const order = await payment.findOrderByIdempotencyKey(orderKey);
    if (!order) {
      throw new AppError(
        ErrorCode.NotFound,
        `PAY_SUCCESS 订单不可读：${orderKey}（进重试轨道，不静默丢弃）`,
      );
    }

    // R-01 支付即冻结（F1 冻结指令）：CREATED→FROZEN；幂等（非 CREATED 跳过/并发败者 StateStale 容忍）
    if (order.status === 'CREATED') {
      try {
        await payment.markFrozen(order.id, null);
      } catch (e) {
        if (
          !(e instanceof AppError && e.code === ErrorCode.StateStaleEntity)
        ) {
          throw e; // 并发同单败者=竞态良性（重投短路），其余上抛重试
        }
      }
    }

    // 成团原子守卫（§4；自持事务）——席位被拒即自动退款分支
    const outcome = await enrollments.onPaySuccess(enrollmentId, order.id);
    if (outcome.refund) {
      await enrollments.refundIfRejected(enrollmentId, order.id);
      logger.warn(
        `报名 ${enrollmentId} 席位被拒（满员/终态）→ 自动退款分支已触发（order=${order.id}，event_id=${event.eventId}）`,
      );
    } else if (outcome.processed) {
      logger.log(`报名 ${enrollmentId} 支付守卫通过（PAID，order=${order.id}）`);
    }

    // inbox 消费标记（先读 status——重复标记会被 inbox 守卫拒成永久重试环）
    const inbox = await uow.query<{ id: string; status: string }>(
      `SELECT id, status FROM payment.inbox WHERE biz_idempotency_key = $1`,
      [bizKey],
    );
    const row = inbox.rows[0];
    if (row && row.status === 'RECEIVED') {
      await payment.markInboxConsumed(Number(row.id));
    }
  };
}

/**
 * SessionFailed/GroupBuyExpired 扫场 handler（R-W3-O 未支付清场；SessionFailed 与 F2 批量退款
 * handler、GroupBuyExpired 与 C2 生产事件同 topic 扇出并存，消费者间幂等互不干扰——F2 退 PAID
 * 清单（session 侧）、本 handler 解冻 PENDING，集合不相交）。
 */
export function createEnrollSweepHandler(enrollments: EnrollmentService): OutboxHandler {
  const logger = new Logger('EnrollSweep');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== SESSION_FAILED_TOPIC && event.topic !== GROUP_BUY_EXPIRED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `报名扫场消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<SessionFailedPayload>;
    if (!isPositiveInt(payload.id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `事件 ${event.topic} 载荷缺 id（进重试轨道，不静默丢弃）`,
      );
    }
    const refType = event.topic === SESSION_FAILED_TOPIC ? 'session' : 'groupbuy';
    const { swept, failed } = await enrollments.sweepPendingOnFail(refType, payload.id);
    if (failed > 0) {
      // 部分失败进 relay 重试轨道：重入只补未解冻单（F4 unfreeze 幂等短路已解冻单）
      throw new AppError(
        ErrorCode.OutboxHandlerFailed,
        `${event.topic} 未支付清场部分失败（${refType}=${payload.id}）：swept=${swept} failed=${failed}`,
      );
    }
    logger.log(`${event.topic} 未支付清场完成：${refType}=${payload.id} 解冻单数=${swept}`);
  };
}

/** RefundCompleted 收敛 handler：按退款单定位支付单 → 报名 →REFUNDED 终态（幂等短路） */
export function createRefundCompletedHandler(
  enrollments: EnrollmentService,
  payment: PaymentGatewayService,
): OutboxHandler {
  const logger = new Logger('EnrollRefundDone');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== REFUND_COMPLETED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `退款收敛消费器收到未注册 topic：${event.topic}`,
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
    const enrollmentId = parseEnrollmentOrderKey(order.idempotency_key);
    if (enrollmentId === null) return; // 非报名单退款（C2 发布单等=M2 域）——跳过
    await enrollments.advanceToRefunded(
      enrollmentId,
      `refund_completed:refund-${payload.refund_id ?? 0}`,
    );
    logger.log(`退款完成收敛：报名 ${enrollmentId} →REFUNDED（order=${order.id}）`);
  };
}

@Injectable()
export class EnrollmentConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly enrollments: EnrollmentService,
    private readonly payment: PaymentGatewayService,
  ) {}

  onModuleInit(): void {
    // 同 topic 多 handler 扇出由 relay 承接（PaymentCallbackInboxed=F2 两 handler 并存三扇出；
    // SessionFailed=F2 批量退款 handler 并存；GroupBuyExpired=R-W3-O 清场扩展，报告偏差节）
    this.relay.registerHandler(
      PAYMENT_CALLBACK_INBOXED_TOPIC,
      createEnrollPayCallbackHandler(this.enrollments, this.payment),
    );
    this.relay.registerHandler(
      SESSION_FAILED_TOPIC,
      createEnrollSweepHandler(this.enrollments),
    );
    this.relay.registerHandler(
      GROUP_BUY_EXPIRED_TOPIC,
      createEnrollSweepHandler(this.enrollments),
    );
    this.relay.registerHandler(
      REFUND_COMPLETED_TOPIC,
      createRefundCompletedHandler(this.enrollments, this.payment),
    );
  }
}
