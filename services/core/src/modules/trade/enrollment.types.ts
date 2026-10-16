/**
 * C3 报名类型契约与幂等键口径（§3/§5 词汇 snake_case；Money=string 禁 float，架构 §1.3）。
 * 金额工具复用同域 session.types（moneyToCents/centsToMoney/dbNumericToCents），不重复实现。
 */
import type { EnrollmentRefType, Money } from '@ljr/shared';
import type { EnrollmentPayStatus } from './enrollment.machine';

export type { Money, EnrollmentRefType };

/** R-05 截止前 30s 停止新建支付单（§5 409 FULL_OR_DEADLINE 的截止半边；架构 §4.1 逐字口径） */
export const ENROLL_CUTOFF_LEAD_MS = 30_000;

/** GET /enrollments/mine 单页护栏上限（§5 未定分页；自定口径报告注明，与 C1/C2 list LIMIT 500 同形） */
export const ENROLL_MINE_LIMIT = 100;

/** R-04 积分抵扣：100 积分=1 元——1 积分=1 分（F4 freeze 同口径；换算全程整数禁 float） */
export const POINTS_PER_CENT = 1;

/**
 * §3 price_snapshot jsonb 形状（六键逐字）：session_total=违约金基数单一来源（F3/D4 消费，
 * 禁双端各自计算）；share_price 在 B2C 场次报名行为 null（分摊额是 C2B 语义，V26 头注⑦）；
 * price_version=报名时点 B3 当前版本号；snapshot_at=ISO 8601。
 */
export interface PriceSnapshot {
  readonly price_mode: 'per_head' | 'session_total';
  readonly unit_price: Money;
  readonly share_price: Money | null;
  readonly session_total: Money;
  readonly price_version: number;
  readonly snapshot_at: string;
}

/** 出库形态防御：price_snapshot 漂移=InternalError 显性化，不静默透传残缺数据（group-buy toTags 同形） */
export function parsePriceSnapshot(raw: unknown): PriceSnapshot {
  const s = (raw ?? {}) as Partial<PriceSnapshot>;
  if (
    (s.price_mode !== 'per_head' && s.price_mode !== 'session_total') ||
    typeof s.unit_price !== 'string' ||
    typeof s.session_total !== 'string' ||
    (s.share_price !== null && typeof s.share_price !== 'string') ||
    typeof s.price_version !== 'number' ||
    typeof s.snapshot_at !== 'string'
  ) {
    throw new Error('enrollments.price_snapshot 出库形态漂移（不应触达）');
  }
  return s as PriceSnapshot;
}

/** POST /sessions/{id}/enroll 与 POST /group-buys/{id}/join 服务入参（§5；user_id 取 JWT claims） */
export interface EnrollInput {
  readonly ref_type: EnrollmentRefType;
  readonly ref_id: number;
  readonly user_id: number;
  /** 积分抵扣（缺省 0；R-04 ≤ 应付 50% 由 F4 freeze 权威校验，C3 入口先行同口径 400） */
  readonly points_to_use?: number;
}

/** 报名下单出参（§5 {payment_order} 逐字 + 简报补位 pay_params——端上唤起支付必需） */
export interface EnrollResult {
  readonly enrollment_id: number;
  readonly ref_type: EnrollmentRefType;
  readonly ref_id: number;
  readonly paid_amount: Money;
  readonly cash_amount: Money;
  readonly points_amount: number;
  readonly payment_order: {
    readonly id: number;
    readonly biz_type: string;
    readonly biz_id: number;
    readonly cash_amount: Money;
    readonly points_amount: number;
    readonly total: Money;
    readonly status: string;
  };
  readonly pay_params: Record<string, unknown>;
}

/** enrollments 行视图（DB 行读出口径：金额 Money 字符串/时间 ISO 字符串） */
export interface EnrollmentRowView {
  readonly id: number;
  readonly ref_type: EnrollmentRefType;
  readonly ref_id: number;
  readonly user_id: number;
  readonly price_snapshot: PriceSnapshot;
  readonly unit_price: Money;
  readonly paid_amount: Money;
  readonly cash_amount: Money;
  readonly points_amount: number;
  readonly price_version_id: number;
  readonly pay_status: EnrollmentPayStatus;
  readonly credit_used: number;
  readonly created_at: string;
}

/** GET /enrollments/mine 条目（§5 {status, amounts, refund_status}；refund_status 取数=F2 listByOrderId） */
export type EnrollmentRefundStatus = 'NONE' | 'PROCESSING' | 'REFUNDED' | 'FAILED';

export interface EnrollmentMineItem {
  readonly enrollment_id: number;
  readonly ref_type: EnrollmentRefType;
  readonly ref_id: number;
  /** pay_status（§5 status） */
  readonly status: EnrollmentPayStatus;
  readonly amounts: {
    readonly paid: Money;
    readonly cash: Money;
    readonly points: number;
  };
  /** 退款态：pay_status=REFUNDED 恒 REFUNDED；否则按 F2 该单最新退款状态映射（无=NONE） */
  readonly refund_status: EnrollmentRefundStatus;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// F1 支付单幂等键口径（报名 ↔ 支付单唯一关联；enrollments 无支付单列，§3 逐字）
// ---------------------------------------------------------------------------

/** 报名的 F1 支付单幂等键（domain/entity/event 三段小写：entity=e{enrollmentId}） */
export function enrollmentOrderKey(enrollmentId: number): string {
  return `enroll/e${enrollmentId}/pay`;
}

/** 从 F1 支付单幂等键解析报名 id（非报名形态键——如 C2 发布单 groupbuy/g{id}/pay——返 null） */
export function parseEnrollmentOrderKey(key: string): number | null {
  const m = /^enroll\/e(\d+)\/pay$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** 自动退款分支的 F2 受理幂等键（稳定可重放；与流标批量键 refund/po-{id}/group-fail 互斥不撞） */
export function autoRefundKey(orderId: number): string {
  return `refund/po-${orderId}/enroll-guard`;
}
