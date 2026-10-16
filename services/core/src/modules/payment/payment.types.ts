/**
 * F1 类型与金额工具（§3/§5 契约词汇 snake_case；Money=string 禁 float，架构 §1.3）。
 *
 * 金额不变量（§9 TDD 清单）：cash + points/100 = total 全接口断言——分母整化在「分」（int）上
 * 进行（moneyToCents/centsToMoney 严格两位小数字符串 ↔ 整数分），全程无浮点；生成列读回
 * NUMERIC 字符串（pg 驱动对 numeric 恒返 string）与本地整化值比对，不一致 InternalError
 * 显性化（DB 兜底层失守即硬错误，不静默）。
 *
 * 幂等键列宽推导（M-5 更正口径；V20 已 apply 冻结，V20 头注相应表述以本注释为准）：
 * shared 契约合法键最长 98（domain/entity/event 三段各≤32 + 两处 '/'）——
 *   - payment_orders.idempotency_key varchar(128) ≥ 98（V11「列宽只放宽不收紧」口径，留余量）；
 *   - inbox.biz_idempotency_key varchar(160) = 98（业务幂等号上限）+ 1（':'）+ 32（事件名上限）
 *     = 131 < 160，余量充足（非「128+32=160」字面推导——128 是列宽非键长上限）。
 * 回调通道事件类型（PAY_SUCCESS/REFUND_SUCCESS 等）不设枚举收口：开放值域由消费方按
 * event 解释（§3 注释例为示意），事件名上限 32 即上式推导依据。
 */
import { AppError, ErrorCode, assertMoney, type Money } from '@ljr/shared';
import type { PaymentOrderStatus } from './payment.machine';

export { assertMoney };
export type { Money };

/** §3 biz_type 值域（enroll 报名|ooo 1对1|ooo_diff 1对1差价|deposit 保证金） */
export const BIZ_TYPES = ['enroll', 'ooo', 'ooo_diff', 'deposit'] as const;
export type BizType = (typeof BIZ_TYPES)[number];

/** §5 /pay/deduct 扣减来源（F3 待结算余额 | A3b 保证金专户） */
export const DEDUCT_FROM = ['settlement', 'deposit'] as const;
export type DeductFrom = (typeof DEDUCT_FROM)[number];

/** int4 上限（points_amount int 列；越界显性 400 而非 PG 22003） */
const INT4_MAX = 2_147_483_647;
/** NUMERIC(12,2) 上限（整数位 10 位）：9999999999.99 = 999999999999 分 */
const MONEY_MAX_CENTS = 999_999_999_999;

const MONEY_SHAPE = /^\d+\.\d{2}$/;

/** Money 字符串 → 整数分（严格两位小数；非法形态/越界抛 AppError——不出 float） */
export function moneyToCents(v: Money): number {
  if (typeof v !== 'string' || !MONEY_SHAPE.test(v)) {
    throw new AppError(ErrorCode.MoneyInvalidFormat, `非法金额：${JSON.stringify(v)}`);
  }
  const [intPart, decPart] = v.split('.') as [string, string];
  const cents = Number(intPart) * 100 + Number(decPart);
  if (!Number.isSafeInteger(cents)) {
    throw new AppError(ErrorCode.InvalidArgument, `金额超出安全整数范围：${v}`);
  }
  if (cents > MONEY_MAX_CENTS) {
    throw new AppError(ErrorCode.InvalidArgument, `金额超出 NUMERIC(12,2) 上限：${v}`);
  }
  return cents;
}

/** 整数分 → Money 字符串（两位小数；None 反向不出浮点） */
export function centsToMoney(cents: number): Money {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new AppError(ErrorCode.InternalError, `整数分须为非负安全整数：${String(cents)}`);
  }
  const intPart = Math.floor(cents / 100);
  const decPart = cents % 100;
  return `${String(intPart)}.${String(decPart).padStart(2, '0')}`;
}

/**
 * DB numeric 文本 → 整数分（容忍无 typmod 的聚合结果：sum()/COALESCE 字面量可产 '0'/'40.5'
 * 等非两位形态； Money=列值恒两位，聚合值走本口。禁止 float——仍在十进制文本上整化）。
 */
export function dbNumericToCents(text: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) {
    throw new AppError(ErrorCode.InternalError, `DB numeric 文本非法：${JSON.stringify(text)}`);
  }
  const dec = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  return Number(m[1]) * 100 + Number(dec);
}

/** 金额拆分不变量（§9）：total(生成列读回) === cash + points/100（整数分比对，禁 float） */
export function assertAmountInvariant(cash: Money, points: number, totalFromDb: Money): void {
  const expected = moneyToCents(cash) + points;
  const actual = moneyToCents(totalFromDb);
  if (expected !== actual) {
    throw new AppError(
      ErrorCode.InternalError,
      `金额拆分不变量失守（DB 兜底层异常）：cash=${cash} points=${points} 期望 total=${centsToMoney(expected)} 实际=${totalFromDb}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §5 契约入参/出参（snake_case 逐字）
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  readonly biz_type: string;
  readonly biz_id: number;
  readonly cash_amount: Money;
  readonly points_amount: number;
  readonly idempotency_key: string;
}

/** 支付单视图（DB 行读出口径：金额/时间一律字符串 ISO） */
export interface PaymentOrderView {
  readonly id: number;
  readonly biz_type: string;
  readonly biz_id: number;
  readonly channel: string;
  readonly cash_amount: Money;
  readonly points_amount: number;
  readonly total: Money;
  readonly status: PaymentOrderStatus;
  readonly idempotency_key: string;
  readonly channel_txn_no: string | null;
  readonly created_at: string;
  readonly paid_at: string | null;
}

export interface PayParamsView {
  readonly mock_pay_url: string;
  readonly order_id: number;
  readonly channel: string;
}

export interface CreateOrderResult {
  readonly payment_order: PaymentOrderView;
  readonly pay_params: PayParamsView;
}

export interface RefundInput {
  readonly order_id: number;
  readonly cash_refund: Money;
  readonly points_refund: number;
  readonly reason: string;
  readonly idempotency_key: string;
}

export interface RefundView {
  readonly ledger_id: number;
  readonly order_id: number;
  readonly direction: 'REFUND';
  readonly amount: Money;
  readonly status: 'ISSUED' | 'CONFIRMED';
  readonly channel: string;
  readonly channel_txn_no: string | null;
  readonly idempotency_key: string;
  readonly cash_refund: Money;
  readonly points_refund: number;
  readonly reason: string;
  readonly order_status: PaymentOrderStatus;
  readonly created_at: string;
}

export interface SplitItem {
  /** 分账接收方类型（F3 构成词汇：lawyer_firm|platform|user，本层不解释透传） */
  readonly payee_type: string;
  readonly payee_id: number;
  readonly amount: Money;
}

export interface SplitInput {
  readonly order_id: number;
  readonly splits: readonly SplitItem[];
  readonly idempotency_key: string;
}

export interface SplitResultView {
  readonly ledger_id: number;
  readonly order_id: number;
  readonly direction: 'SPLIT';
  readonly amount: Money;
  readonly status: 'ISSUED' | 'CONFIRMED';
  readonly channel: string;
  readonly channel_txn_no: string | null;
  readonly idempotency_key: string;
  readonly order_status: PaymentOrderStatus;
  readonly created_at: string;
}

export interface DeductInput {
  readonly lawyer_id: number;
  readonly amount: Money;
  readonly from: DeductFrom;
  readonly idempotency_key: string;
}

export interface DeductResultView {
  readonly ledger_id: number;
  readonly direction: 'DEDUCT';
  readonly amount: Money;
  readonly status: 'ISSUED' | 'CONFIRMED';
  readonly channel: string;
  readonly channel_txn_no: string | null;
  readonly idempotency_key: string;
  readonly lawyer_id: number;
  readonly from: DeductFrom;
  readonly created_at: string;
}

/** 入参校验共用（正整数；HTTP 面经 parse-positive-int 收口，服务面对直调方同样防御） */
export function assertPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

/** 积分金额校验（int 列：非负整数 ≤ int4 上限） */
export function assertPoints(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > INT4_MAX) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `points_amount 须为 0..${INT4_MAX} 整数：${JSON.stringify(v)}`,
    );
  }
  return v;
}
