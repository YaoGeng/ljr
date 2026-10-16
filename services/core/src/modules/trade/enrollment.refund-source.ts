/**
 * R-W3-M 退款源真实实现（T6 定型接口的 trade 侧落位）：'session' 键注册到 F2
 * RefundSourceRegistry（onModuleInit；PaymentModule 先于 TradeModule 初始化满足注册时序）——
 * SessionFailed 流标批量退款消费器经此取付款人清单，F2 假源测试链换真源全链。
 *
 * 清单口径（shared RefundSource 契约逐字）：该场 **PAID** enrollment 的
 * [{payment_order_id, user_id, cash_amount, points_amount}]——仅已支付（未支付无款可退，
 * 流标静默跳过；其积分清场走 sweepPendingOnSessionFail 的 UNFREEZE 轨道，R-W3-O）。
 * 支付单定位=F1 幂等键 enroll/e{id}/pay（报名↔支付单唯一关联口径，enrollments 无支付单列）；
 * PAID 行订单不可读=数据漂移，抛错整批进重试轨道（不静默缺行——资损不变量）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  REFUND_SOURCE_REF_TYPE_SESSION,
  type RefundSource,
  type RefundSourceOrder,
} from '@ljr/shared';
import { PgPoolService } from '../../infrastructure/sql';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { RefundSourceRegistry } from '../payment/refund.source';
import { enrollmentOrderKey } from './enrollment.types';

interface PaidEnrollmentRow {
  readonly id: string;
  readonly user_id: string;
  readonly cash_amount: string;
  readonly points_amount: number;
}

@Injectable()
export class SessionRefundSource implements RefundSource, OnModuleInit {
  constructor(
    private readonly pool: PgPoolService,
    private readonly payment: PaymentGatewayService,
    private readonly registry: RefundSourceRegistry,
  ) {}

  onModuleInit(): void {
    // 同键覆盖=后到实现接管（T6 测试假源 → T7 真源的同形通道；注册表语义逐字）
    this.registry.register(REFUND_SOURCE_REF_TYPE_SESSION, this);
  }

  async listPaidPaymentOrders(refId: number): Promise<readonly RefundSourceOrder[]> {
    const res = await this.pool.query<PaidEnrollmentRow>(
      `SELECT id, user_id::text AS user_id, cash_amount::text AS cash_amount, points_amount
         FROM trade.enrollments
        WHERE ref_type = 'session' AND ref_id = $1 AND pay_status = 'PAID'
        ORDER BY id`,
      [refId],
    );
    const orders: RefundSourceOrder[] = [];
    for (const row of res.rows) {
      const order = await this.payment.findOrderByIdempotencyKey(
        enrollmentOrderKey(Number(row.id)),
      );
      if (!order) {
        // PAID 行必有支付单（成团守卫事务先行创建）；漂移显性化——整批进重试轨道，不静默缺行
        throw new AppError(
          ErrorCode.InternalError,
          `退款源漂移：PAID 报名 ${row.id} 的支付单不可读（session=${refId}）`,
        );
      }
      orders.push({
        payment_order_id: order.id,
        user_id: Number(row.user_id),
        cash_amount: row.cash_amount,
        points_amount: row.points_amount,
      });
    }
    return orders;
  }
}
