/**
 * F4 ①切片积分类型契约（施工规格 docs/modules/F-资金/F4-权益积分优惠券备付台账.md §3/§5/§7
 * + Task 2 简报裁决）。积分一律 int（100 积分=1 元；金额换算全 int 分运算禁 float——订单应付
 * 由调用方以「分」整化传入 order_payable_cents，本模块无 Money 字符串面）。
 *
 * 词汇表/事件契约在 @ljr/shared（POINTS_TXN_KINDS / PointsGrantedPayload 等）；本文件只收
 * 接口出入参与视图。
 */
import { AppError, ErrorCode } from '@ljr/shared';

/** int4 上限（delta int 列；越界显性 400 而非 PG 22003，payment 同款口径） */
export const INT4_MAX = 2_147_483_647;

/** source_ref 列宽（§3 varchar(64)） */
export const SOURCE_REF_MAX = 64;

/** expiring_soon 窗口（§5 未具名「即将过期」窗长，最小口径常量 7 天，报告注明） */
export const EXPIRING_SOON_WINDOW_DAYS = 7;

/** expiring_soon 返回条数上限（最小口径常量，按 expires_at 升序截断，报告注明） */
export const EXPIRING_SOON_LIMIT = 20;

/** 本切片授予原语可用的 kind（GRANT_COMPENSATION/GRANT_ABSENCE_SHARE 两个 §5 内部接口=②全量；
 *  本原语是三事件中 PointsGranted 的生产路径 + 测试/C3 联调种子通道，编排层②再包） */
export const GRANT_KINDS = ['COMPENSATION', 'ABSENCE_SHARE'] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** 冻结/核销/解冻的 order 幂等引用（source_ref 同文；§5 幂等键=order） */
export function orderSourceRef(paymentOrderId: number): string {
  return `order:${paymentOrderId}`;
}

// ---------------------------------------------------------------------------
// 入参（snake_case 契约词汇）
// ---------------------------------------------------------------------------

/** 授予原语入参（正向；幂等键=(user_id, kind, ref)） */
export interface GrantInput {
  readonly user_id: number;
  /** 正整数（1..int4 上限） */
  readonly points: number;
  readonly kind: GrantKind;
  /** 幂等引用（1-64 字符，调用方语义：如 price_change:{id} / attendance:{id}） */
  readonly ref: string;
}

/** FREEZE 入参（§5 幂等键=order；R-01 校验在入参——points_to_use 与订单应付比较） */
export interface FreezeInput {
  readonly user_id: number;
  /** F1 支付单 id（幂等键=order；source_ref=order:{id}） */
  readonly payment_order_id: number;
  /** 本次抵扣积分（int 分域：1 积分=1 分；须 ≤ floor(订单应付/2)，R-01） */
  readonly points_to_use: number;
  /** 订单应付总额（分；= cash + points/100 整化，调用方 C3 传入，R-01 分母） */
  readonly order_payable_cents: number;
}

/** SETTLE / UNFREEZE_POINTS 入参（§5 幂等键=order；冻结额从 FREEZE 留痕行取，调用方不重传） */
export interface OrderOpInput {
  readonly user_id: number;
  readonly payment_order_id: number;
}

/** REFUND_RESTORE 入参（R-06：积分部分还原+过期时钟重置；幂等键=(user_id, ref)） */
export interface RestoreInput {
  readonly user_id: number;
  readonly points: number;
  /** 幂等引用（调用方 F2 的退款维度 ref，1-64 字符） */
  readonly ref: string;
}

// ---------------------------------------------------------------------------
// 出参/视图
// ---------------------------------------------------------------------------

/** 变更通用出参（deduplicated=true=at-least-once 重放短路：账户不动、无新流水/事件） */
export interface PointsMutationResult {
  readonly deduplicated: boolean;
  /** 出参时点可用余额（物理列值；不含惰性过期剔除——变更路径的余额口径） */
  readonly balance: number;
  readonly frozen: number;
}

/** expiring_soon 条目（GET /points/mine；expires_at=ISO 8601 出站口径） */
export interface ExpiringSoonItem {
  readonly points: number;
  readonly expires_at: string;
}

/** GET /points/mine 出参（§5 契约表逐字：{balance, frozen, expiring_soon[]}） */
export interface PointsMineView {
  /** 可用余额（惰性过期口径：物理余额剔除「已过期未扣减」部分，读时纯计算不落行） */
  readonly balance: number;
  readonly frozen: number;
  readonly expiring_soon: readonly ExpiringSoonItem[];
}

// ---------------------------------------------------------------------------
// 校验助手（服务面对直调方同样防御；HTTP 面无入参——/points/mine 从 claims 注入）
// ---------------------------------------------------------------------------

export function assertPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

/** 积分域校验（1..int4 上限；0 抵扣无意义显性拒绝） */
export function assertPoints(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > INT4_MAX) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `${field} 须为 1..${INT4_MAX} 整数：${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** 非负 int 分域金额（订单应付分母；0 合法——零应付订单任何抵扣被 R-01 拒） */
export function assertNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为非负整数：${JSON.stringify(v)}`);
  }
  return v;
}

export function assertSourceRef(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > SOURCE_REF_MAX) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `${field} 须为 1-${SOURCE_REF_MAX} 字符：${JSON.stringify(v)}`,
    );
  }
  return v;
}
