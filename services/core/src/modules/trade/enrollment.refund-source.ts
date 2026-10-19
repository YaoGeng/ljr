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
  type SqlExecutorLike,
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
  readonly prev_enrollment_id: string | null;
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

  /**
   * exec（可选，#42 M2-W2 T3 纯加法）：调用方业务事务句柄——传入时 enrollments 读与调用方
   * 事务同快照（close 聚合资金口径）；不传=池连接（既有形态）。F1 支付单定位读
   * （findOrderByIdempotencyKey）保持池连接——订单行创建后拆分不可变，非同事务漂移面（报告注记）。
   *
   * 迁移行订单回链（M2-W2 T4 纯加法）：C4 确认/认领转化的迁移行（prev_enrollment_id 非空），
   * 其支付单仍挂在原报名的 F1 幂等键 enroll/e{prev}/pay 上（迁移不搬家款、不另开单——快照价
   * 沿用口径）——本行键未命中时沿 prev 回链解析，F2 批量退款（SessionFailed/SessionCancelled
   * 消费）对 C2B/转化场次因此可取到付款人清单。
   */
  async listPaidPaymentOrders(
    refId: number,
    exec?: SqlExecutorLike,
  ): Promise<readonly RefundSourceOrder[]> {
    const LIST_SQL = `SELECT id, user_id::text AS user_id, cash_amount::text AS cash_amount, points_amount,
         prev_enrollment_id::text AS prev_enrollment_id
       FROM trade.enrollments
       WHERE ref_type = 'session' AND ref_id = $1 AND pay_status = 'PAID'
       ORDER BY id`;
    const rows: PaidEnrollmentRow[] = exec
      ? ((await exec.query(LIST_SQL, [refId])).rows as unknown as PaidEnrollmentRow[]) // 结构型行收窄（列解释归本实现方）
      : (await this.pool.query<PaidEnrollmentRow>(LIST_SQL, [refId])).rows;
    const orders: RefundSourceOrder[] = [];
    for (const row of rows) {
      const order = await this.resolveOrderForEnrollment(row);
      if (!order) {
        // PAID 行必有支付单（成团守卫事务先行创建/迁移行经 prev 回链）；漂移显性化——整批进
        // 重试轨道，不静默缺行
        throw new AppError(
          ErrorCode.InternalError,
          `退款源漂移：PAID 报名 ${row.id} 的支付单不可读（session=${refId}，prev=${row.prev_enrollment_id ?? '无'}）`,
        );
      }
      orders.push({
        payment_order_id: order.id,
        user_id: Number(row.user_id),
        cash_amount: order.cash_amount,
        points_amount: order.points_amount,
      });
    }
    return orders;
  }

  /**
   * 报名行 → F1 支付单：先本行键 enroll/e{id}/pay；未命中且为迁移行（prev 非空）→ 回链原报名键
   * （迁移行无自持单，类注 T4 口径）。两跳兜底覆盖 C4 单层迁移链；多层链（V1 不产生）未命中
   * 走调用方漂移显性化。
   */
  private async resolveOrderForEnrollment(
    row: PaidEnrollmentRow,
  ): Promise<{ id: number; cash_amount: string; points_amount: number } | null> {
    const own = await this.payment.findOrderByIdempotencyKey(enrollmentOrderKey(Number(row.id)));
    if (own) return own;
    if (row.prev_enrollment_id !== null) {
      return this.payment.findOrderByIdempotencyKey(
        enrollmentOrderKey(Number(row.prev_enrollment_id)),
      );
    }
    return null;
  }
}
