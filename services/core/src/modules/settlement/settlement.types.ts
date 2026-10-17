/**
 * F3 分账构成纯函数与契约词汇（§2/R-03/R-06/R-05 + D20 ⚠W3 裁决）——纯函数无 IO 无状态，
 * 全边界单测钉住于 settlement.types.spec.ts；服务层只编排不重复实现。
 *
 * 金额纪律：Money 字符串进出（@ljr/shared 契约），整化全在「分」（int 域）进行——
 * moneyToCents/centsToMoney/dbNumericToCents 与 payment.types 同形（F1 同口径；本模块按
 * 可剥离纪律不 import 他模块内部件，局部同形复制——报告偏差节记录）。
 * 乘法走 BigInt 防 2^53（NUMERIC(12,2) 上限 × 费率/占比的极端组合）。
 *
 * 取整裁量（Task 8 简报二择，全边界用例钉住）：**律师 70% 向下取整、尾差整份额归平台备付侧**
 * ——与 F4 share-split（floor + 余数归确定性桶）精神一致；费率计算同 floor 语义。
 *
 * R-05 硬规则（用例钉住）：违约金不进 platform_fee——平台服务费恒按 gross 计算，
 * 与 penalty 无关；违约金只减少律师侧净额。
 */
import { AppError, ErrorCode, type Money } from '@ljr/shared';
import type { SettlementSplitItem } from '@ljr/shared';

/** 结算实体类型（§3 逐字：session|one_on_one） */
export const SETTLEMENT_REF_TYPES = ['session', 'one_on_one'] as const;
export type SettlementRefType = (typeof SETTLEMENT_REF_TYPES)[number];

/** 分账构成模式（share_mode 列 ck 同文） */
export const SHARE_MODES = ['FULL_TO_LAWYER', 'ABSENCE_7030'] as const;
export type ShareMode = (typeof SHARE_MODES)[number];

/** R-02 冻结期时长（24h；job 注册用应用钟跨度，到期判定事实源=DB 钟 created_at+interval） */
export const HOLD_MS = 24 * 60 * 60 * 1000;

/** hold_reason 词汇（§10 验收/R-02/R-07） */
export const HOLD_REASONS = ['HOLD_24H', 'OPEN_TICKETS', 'MERCHANT_NOT_ACTIVE'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

// ---------------------------------------------------------------------------
// 契约入参/出参（snake_case 逐字；金额/时间一律字符串 ISO）
// ---------------------------------------------------------------------------

/** 违约扣减留痕单腿（deduction_detail.items[]；§3 注释 {from: settlement|deposit, items[]} 口径归一） */
export interface DeductionLeg {
  /** 扣减来源（R-04 顺序：settlement=待结算余额优先，deposit=保证金专户补足） */
  readonly leg: 'settlement' | 'deposit';
  readonly amount: Money;
  readonly idempotency_key: string;
  /** F1 split_ledgers 流水 id（SHORTFALL 腿无流水=null） */
  readonly ledger_id: number | null;
  readonly status: 'CONFIRMED' | 'SHORTFALL';
}

/** 违约扣减留痕（settlements.deduction_detail；锚=该律师最后被摊扣的结算行） */
export interface SettlementDeductionDetail {
  readonly items: readonly DeductionLeg[];
  /** 挂欠款（待结算余额与保证金专户均不足部分；>0 时同事务出箱 SettlementDebtIncurred） */
  readonly debt: Money;
  /** APPLY_PENALTY 入参快照（重放载荷比对 + M2 C3 快照回查换装位锚） */
  readonly amount: Money;
  readonly base_ref: { readonly ref_type: string; readonly ref_id: number };
  readonly base_version: number | null;
  readonly reason: string;
  readonly idempotency_key: string;
  readonly applied_at: string;
}

/** 结算单视图（DB 行读出口径） */
export interface SettlementView {
  readonly id: number;
  readonly ref_type: SettlementRefType;
  readonly ref_id: number;
  readonly lawyer_id: number;
  readonly firm_id: number;
  readonly gross: Money;
  readonly penalty: Money;
  readonly platform_fee: Money;
  readonly fee_version_id: number;
  readonly net: Money;
  readonly share_mode: ShareMode;
  readonly payment_order_id: number | null;
  readonly escrow_status: string | null;
  readonly deduction_detail: SettlementDeductionDetail | null;
  readonly status: SettlementStatus;
  readonly hold_reason: string | null;
  readonly created_at: string;
  readonly settled_at: string | null;
}

/** 结算状态词汇（settlement.machine 同文再导出；视图/过滤器用） */
export type { SettlementStatus } from './settlement.machine';
import type { SettlementStatus } from './settlement.machine';

/** 履约完成进结算（§6 消费 RoomClosed/OneOnOneSettled 的载荷归一；§5 内部 RUN_SETTLEMENT 前置） */
export interface EnterSettlementInput {
  readonly ref_type: SettlementRefType;
  readonly ref_id: number;
  readonly lawyer_id: number;
  readonly firm_id: number;
  /** 入账总额快照（F1 冻结额口径） */
  readonly gross: Money;
  /** F1 支付单 id（/pay/split 指令定位；恢复重驱动持久绑定） */
  readonly payment_order_id: number;
}

/** RUN_SETTLE 结果（§5 内部指令；幂等键=ref_type+ref_id） */
export interface RunSettleResult {
  readonly settlement_id: number;
  readonly settled: boolean;
  /** 幂等重放：已 SETTLED（§10-7 重复触发无操作） */
  readonly already_settled?: boolean;
  /** 未到 READY（当前状态） */
  readonly status?: SettlementStatus;
  /** R-07：进件非 ACTIVE → 挂起 SUSPENDED 不分账 */
  readonly suspended?: boolean;
}

/** HOLD 释放结果（blocked=未满足的释放条件） */
export interface ReleaseHoldResult {
  readonly released: boolean;
  readonly blocked?: 'HOLD_24H' | 'OPEN_TICKETS';
}

/** 缺席分成标记结果（R-03；NO_SETTLEMENT=D3 先于 RoomClosed 的真实时序=M2 联调位） */
export interface MarkAbsenceResult {
  readonly marked: boolean;
  readonly reason?: 'NO_SETTLEMENT' | 'SETTLED';
}

/** APPLY_PENALTY 入参（§5 逐字 {owner, amount, base_ref, base_version, reason, idempotency_key}；
 *  R-W3-A 裁决：W3 带金额入参（调用方 D4=M2 自备快照金额），按 base_ref 回查 C3 快照=M2 换装位） */
export interface ApplyPenaltyInput {
  /** 违约责任人（§5 owner=lawyer，identity 侧用户 id） */
  readonly owner_id: number;
  readonly amount: Money;
  /** 违约基数引用（C3 价格快照实体，如 {session, id}） */
  readonly base_ref: { readonly ref_type: string; readonly ref_id: number };
  /** 快照版本（W3 透传留痕；M2 快照回查时作一致性锚） */
  readonly base_version?: number | null;
  readonly reason: string;
  /** 幂等键（须 penalty/ 域前缀——保证金腿派生键=首段换 deposit 防同键撞向） */
  readonly idempotency_key: string;
}

/** APPLY_PENALTY 结果（§5 扣减结果；400 INSUFFICIENT 经 F1 语义转为 debt 挂账+出箱） */
export interface ApplyPenaltyResult {
  /** 同键重放=true（§10-7 幂等无操作） */
  readonly replayed: boolean;
  /** 实际从待结算余额扣到（CONFIRMED 腿合计） */
  readonly from_settlement: Money;
  /** 实际从保证金专户扣到 */
  readonly from_deposit: Money;
  /** 挂欠款（R-04：不足挂欠款+暂停接单，G1 事件出箱） */
  readonly debt: Money;
  readonly items: readonly DeductionLeg[];
}

// ---------------------------------------------------------------------------
// 分 ↔ Money 字符串（与 payment.types 同形；禁 float）
// ---------------------------------------------------------------------------

const MONEY_SHAPE = /^\d+\.\d{2}$/;
/** NUMERIC(12,2) 上限（整数位 10 位）：9999999999.99 = 999999999999 分 */
const MONEY_MAX_CENTS = 999_999_999_999;

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

export function centsToMoney(cents: number): Money {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new AppError(ErrorCode.InternalError, `整数分须为非负安全整数：${String(cents)}`);
  }
  const intPart = Math.floor(cents / 100);
  const decPart = cents % 100;
  return `${String(intPart)}.${String(decPart).padStart(2, '0')}`;
}

export function dbNumericToCents(text: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) {
    throw new AppError(ErrorCode.InternalError, `DB numeric 文本非法：${JSON.stringify(text)}`);
  }
  const dec = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  return Number(m[1]) * 100 + Number(dec);
}

// ---------------------------------------------------------------------------
// 费率与构成（纯函数）
// ---------------------------------------------------------------------------

/** numeric(5,4) 费率文本 → 基点整数（×10000；ck 0..1，形态/越界显性抛） */
export function rateToBasisPoints(rate: string): number {
  if (typeof rate !== 'string' || !/^[01]\.\d{4}$/.test(rate)) {
    throw new AppError(
      ErrorCode.InternalError,
      `费率文本非法（numeric(5,4) 期望形如 0.0500）：${JSON.stringify(rate)}`,
    );
  }
  const bps = Number(rate.replace('.', ''));
  if (!Number.isSafeInteger(bps) || bps > 10_000) {
    throw new AppError(ErrorCode.InternalError, `费率越界（R-06 ck 0..1）：${rate}`);
  }
  return bps;
}

/** 平台服务费（R-06）：floor(gross × rate)——基数恒为 gross，与 penalty 无关（R-05 硬规则） */
export function platformFeeCents(grossCents: number, rate: string): number {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0) {
    throw new AppError(ErrorCode.InternalError, `gross 分须为非负安全整数：${String(grossCents)}`);
  }
  const bps = rateToBasisPoints(rate);
  return Number((BigInt(grossCents) * BigInt(bps)) / 10_000n);
}

/**
 * R-03 缺席 70/30 分摊取整：律师 70% 向下取整（BigInt 域），尾差整份额归平台备付侧
 * （firm + reserve === distributable 恒等）。
 */
export function splitAbsence7030(distributableCents: number): {
  readonly firm_cents: number;
  readonly reserve_cents: number;
} {
  if (!Number.isSafeInteger(distributableCents) || distributableCents < 0) {
    throw new AppError(
      ErrorCode.InternalError,
      `可分配净额分须为非负安全整数：${String(distributableCents)}`,
    );
  }
  const firm = Number((BigInt(distributableCents) * 7n) / 10n);
  return { firm_cents: firm, reserve_cents: distributableCents - firm };
}

export interface ComposeSplitsInput {
  readonly firm_id: number;
  readonly gross_cents: number;
  readonly penalty_cents: number;
  /** 平台服务费（分；建行时按生效费率固化于行——settle 时从行读，不随版本漂移） */
  readonly platform_fee_cents: number;
  readonly share_mode: ShareMode;
}

export interface ComposeSplitsResult {
  /** 平台服务费（R-06；恒按 gross 计，R-05 与 penalty 无关；splits 构成项） */
  readonly fee_cents: number;
  /** 分账净额 = gross − penalty（恒等式 Σsplits === net） */
  readonly net_cents: number;
  /** 律师份额（律所对公；缺席模式=扣费后净额的 70% floor） */
  readonly firm_share_cents: number;
  /** 缺席 30% 备付份额（FULL 模式恒 0；尾差归此） */
  readonly reserve_share_cents: number;
  /** F1 /pay/split 构成明细（律所份额+平台服务费+缺席备付；零项=无可分金额，服务层跳过指令面） */
  readonly splits: readonly SettlementSplitItem[];
}

/** 分账构成（§2：律师费→律所对公 + 平台服务费 + 缺席 30% 备付；构成校验 Σsplits=net=gross−penalty） */
export function composeSplits(input: ComposeSplitsInput): ComposeSplitsResult {
  const { firm_id, gross_cents, penalty_cents, platform_fee_cents, share_mode } = input;
  for (const [name, v] of [
    ['gross_cents', gross_cents],
    ['penalty_cents', penalty_cents],
    ['platform_fee_cents', platform_fee_cents],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new AppError(ErrorCode.InternalError, `${name} 须为非负安全整数：${String(v)}`);
    }
  }
  if (penalty_cents > gross_cents) {
    throw new AppError(
      ErrorCode.InternalError,
      `penalty 超过 gross（扣减顺序守恒失守）：${penalty_cents} > ${gross_cents}`,
    );
  }
  const fee = platform_fee_cents;
  const net = gross_cents - penalty_cents; // 分账净额（=Σsplits；fee 为其中构成项）
  if (net < fee) {
    throw new AppError(
      ErrorCode.InternalError,
      `可分配额为负（net−fee<0）：${net}−${fee}（行内构成不变量失守）`,
    );
  }
  // 律师/备付份额在扣费后的可分配额上切分（fee 亦为 splits 构成项——平台服务费实走分账指令）
  const firmShare = share_mode === 'ABSENCE_7030' ? splitAbsence7030(net - fee).firm_cents : net - fee;
  const reserveShare = net - fee - firmShare;

  const splits: SettlementSplitItem[] = [];
  if (firmShare > 0) {
    splits.push({ payee_type: 'lawyer_firm', payee_id: firm_id, amount: centsToMoney(firmShare) });
  }
  if (fee > 0) {
    splits.push({ payee_type: 'platform', payee_id: 0, amount: centsToMoney(fee) });
  }
  if (reserveShare > 0) {
    splits.push({ payee_type: 'platform', payee_id: 0, amount: centsToMoney(reserveShare) });
  }
  return {
    fee_cents: fee,
    net_cents: net,
    firm_share_cents: firmShare,
    reserve_share_cents: reserveShare,
    splits,
  };
}
