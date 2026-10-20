/**
 * R-W3-M 退款源真实实现（T6 定型接口的 trade 侧落位）：enrollments 同表双源——
 * 'session' 键（SessionRefundSource：SessionFailed 流标/SessionCancelled 取消批量退款
 * 消费器取付款人清单）+ 'groupbuy' 键（GroupBuyRefundSource，I-1=M2-W3 T1：LawyerRejected
 * 拼团拒绝/超时全员全额退款消费器取清单——C2 12h 确认超时自动拒与 C4 显式拒同 topic）。
 * 均经 onModuleInit 注册到 F2 RefundSourceRegistry（PaymentModule 先于 TradeModule 初始化
 * 满足注册时序），F2 假源测试链换真源全链。
 *
 * 清单口径（shared RefundSource 契约逐字，两源同表同形态仅 ref_type 分流）：该业务实体
 * **PAID** enrollment 的 [{payment_order_id, user_id, cash_amount, points_amount}]——仅已支付
 * （未支付无款可退，流标静默跳过；其积分清场走 sweepPendingOnFail 的 UNFREEZE 轨道，
 * R-W3-O）。**拒绝/超时路径的 PENDING 冻结积分清场未接线=已知缺口**（LAWYER_REJECTED
 * 无 sweep 消费——仅「晚到支付→refundIfRejected」一条补救线，从不支付=冻结滞留；
 * T1 评审 I-1 发现，登记 M2-W3 T5 批内收口+04 §8）。支付单定位=F1 幂等键
 * enroll/e{id}/pay（报名↔支付单唯一关联口径，enrollments 无支付单列）；PAID 行订单不可读
 * =数据漂移，抛错整批进重试轨道（不静默缺行——资损不变量）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  REFUND_SOURCE_REF_TYPE_GROUPBUY,
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

/**
 * PAID 报名行 → 退款源清单（session/groupbuy 共用 impl：同 SQL 形态 ref_type 参数化分流——
 * B2 占用锁同款词汇，避免两源 SQL/回链双份漂移）。
 *
 * exec（可选，#42 M2-W2 T3 纯加法）：调用方业务事务句柄——传入时 enrollments 读与调用方
 * 事务同快照（close 聚合资金口径）；不传=池连接（既有形态）。F1 支付单定位读
 * （findOrderByIdempotencyKey）保持池连接——订单行创建后拆分不可变，非同事务漂移面（报告注记）。
 *
 * 迁移行订单回链（M2-W2 T4 纯加法，两源共享）：C4 确认/认领转化的迁移行（prev_enrollment_id
 * 非空），其支付单仍挂在原报名的 F1 幂等键 enroll/e{prev}/pay 上（迁移不搬家款、不另开单——
 * 快照价沿用口径）——本行键未命中时沿 prev 回链解析，F2 批量退款（SessionFailed/
 * SessionCancelled/LawyerRejected 消费）对转化/迁移行因此可取到付款人清单。当前生产链
 * groupbuy 行为迁移源侧（无 prev），回链为共享口径的防御性覆盖。
 */
async function listPaidEnrollmentOrders(
  pool: PgPoolService,
  payment: PaymentGatewayService,
  refType: 'session' | 'groupbuy',
  refId: number,
  exec?: SqlExecutorLike,
): Promise<readonly RefundSourceOrder[]> {
  const LIST_SQL = `SELECT id, user_id::text AS user_id, cash_amount::text AS cash_amount, points_amount,
       prev_enrollment_id::text AS prev_enrollment_id
     FROM trade.enrollments
     WHERE ref_type = $1 AND ref_id = $2 AND pay_status = 'PAID'
     ORDER BY id`;
  const rows: PaidEnrollmentRow[] = exec
    ? ((await exec.query(LIST_SQL, [refType, refId])).rows as unknown as PaidEnrollmentRow[]) // 结构型行收窄（列解释归本实现方）
    : (await pool.query<PaidEnrollmentRow>(LIST_SQL, [refType, refId])).rows;
  const orders: RefundSourceOrder[] = [];
  for (const row of rows) {
    const order = await resolveOrderForEnrollment(payment, row);
    if (!order) {
      // PAID 行必有支付单（成团守卫事务先行创建/迁移行经 prev 回链）；漂移显性化——整批进
      // 重试轨道，不静默缺行
      throw new AppError(
        ErrorCode.InternalError,
        `退款源漂移：PAID 报名 ${row.id} 的支付单不可读（${refType}=${refId}，prev=${row.prev_enrollment_id ?? '无'}）`,
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
async function resolveOrderForEnrollment(
  payment: PaymentGatewayService,
  row: PaidEnrollmentRow,
): Promise<{ id: number; cash_amount: string; points_amount: number } | null> {
  const own = await payment.findOrderByIdempotencyKey(enrollmentOrderKey(Number(row.id)));
  if (own) return own;
  if (row.prev_enrollment_id !== null) {
    return payment.findOrderByIdempotencyKey(enrollmentOrderKey(Number(row.prev_enrollment_id)));
  }
  return null;
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

  async listPaidPaymentOrders(
    refId: number,
    exec?: SqlExecutorLike,
  ): Promise<readonly RefundSourceOrder[]> {
    return listPaidEnrollmentOrders(
      this.pool,
      this.payment,
      REFUND_SOURCE_REF_TYPE_SESSION,
      refId,
      exec,
    );
  }
}

/**
 * I-1（M2-W3 T1）：'groupbuy' 退款源——LawyerRejected（C2 12h 确认超时自动拒 via_timeout=true
 * / C4 律师显式拒 via_timeout=false 同 topic）全员全额退款消费器经此取付款人清单。清单与
 * prev 回链口径与 Session 源共用一套 impl（enrollments 同表 ref_type 分流：groupbuy 报名行
 * 支付单同挂 enroll/e{id}/pay 键；拒绝/超时后无迁移环节，回链为共享口径的防御性覆盖——
 * 见 listPaidEnrollmentOrders 头注）。
 */
@Injectable()
export class GroupBuyRefundSource implements RefundSource, OnModuleInit {
  constructor(
    private readonly pool: PgPoolService,
    private readonly payment: PaymentGatewayService,
    private readonly registry: RefundSourceRegistry,
  ) {}

  onModuleInit(): void {
    // 与 session 键同注册表并存（不同键互不覆盖；注册表语义逐字）
    this.registry.register(REFUND_SOURCE_REF_TYPE_GROUPBUY, this);
  }

  async listPaidPaymentOrders(
    refId: number,
    exec?: SqlExecutorLike,
  ): Promise<readonly RefundSourceOrder[]> {
    return listPaidEnrollmentOrders(
      this.pool,
      this.payment,
      REFUND_SOURCE_REF_TYPE_GROUPBUY,
      refId,
      exec,
    );
  }
}
