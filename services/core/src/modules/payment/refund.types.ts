/**
 * F2 退款类型契约（施工规格 docs/modules/F-资金/F2-退款处理.md §2/§3/§5 + Task 6 简报裁决）。
 * 金额词汇 snake_case 逐字 §5；Money=string 禁 float（架构 §1.3），整化工具复用 F1 payment.types。
 *
 * ISSUE_REFUND 契约（§5 内部接口）：{order_id, cash, points, reason, idempotency_key} →
 * {refund}；409 DUP。增补位（⚠T6 裁决，报告偏差节注明）：user_id——§3 裸列无付款人而
 * R-03 积分还原/§5 mine 过滤/I1 通知必需（V25 头注⑤同口径）。
 */
import { AppError, ErrorCode, type Money } from '@ljr/shared';
import type { RefundStatus } from './refund.machine';

/** int4 上限（points_amount int 列；越界显性 400 而非 PG 22003，payment 同款口径） */
const INT4_MAX = 2_147_483_647;

/** 积分金额校验（int 列：非负整数 ≤ int4 上限；同 F1 assertPoints 口径，本域就近收口） */
export function assertPointsLike(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > INT4_MAX) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `points 须为 0..${INT4_MAX} 整数：${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** §2 原因枚举（九值逐字；V25 ck 同值域） */
export const REFUND_REASONS = [
  'GROUP_FAIL',
  'LAWYER_REJECT',
  'TIMEOUT',
  'CONVERT_WINDOW',
  'NO_SHOW_ALL',
  'CANCEL_RULE',
  'OOO_CANCEL',
  'OOO_TIMEOUT',
  'SETTLE_REFUND',
] as const;

export type RefundReason = (typeof REFUND_REASONS)[number];

/** §4「失败重试 3 次」：总尝试上限（含首次）；耗尽 → PROCESSING→FAILED + RefundFailed 出箱 */
export const MAX_DISPATCH_ATTEMPTS = 3;

/**
 * 卡死判定阈值（评审 Important-1）：PROCESSING 且无退避位（next_retry_at IS NULL）的行，
 * 受理时点超龄即视为「首发事务提交后崩溃」候选——dispatchDue 拾取后按 F1 台账权威判定
 * 重发或收敛。5 分钟远大于正常下发路径耗时（指令面同步确认），常态在途单不误触。
 */
export const STUCK_PROCESSING_AFTER_MINUTES = 5;

/** 退避秒表（第 n 次失败后的重试间隔；n 从 1 起，耗尽前最后一次失败无退避位） */
export const RETRY_BACKOFF_SECONDS = [2, 8] as const;

/** §5 ISSUE_REFUND 入参（snake_case 逐字 + user_id 增补） */
export interface IssueRefundInput {
  readonly order_id: number;
  readonly user_id: number;
  /** 现金退款（原路退回部分；Money 字符串） */
  readonly cash: Money;
  /** 积分退款（R-03 还原为积分不退现；非负整数，1 积分=0.01 元） */
  readonly points: number;
  readonly reason: RefundReason;
  readonly idempotency_key: string;
}

/** 退款单视图（DB 行读出口径：金额/时间一律字符串 ISO） */
export interface RefundView {
  readonly refund_id: number;
  readonly order_id: number;
  readonly user_id: number;
  readonly cash_amount: Money;
  readonly points_amount: number;
  readonly reason: RefundReason;
  readonly status: RefundStatus;
  readonly idempotency_key: string;
  readonly requested_at: string;
  readonly done_at: string | null;
}

/** §5 GET /refunds/mine 条目（状态列表 + R-01「1-3 工作日」文案字段） */
export interface RefundMineItem {
  readonly refund_id: number;
  readonly order_id: number;
  readonly cash_amount: Money;
  readonly points_amount: number;
  readonly reason: RefundReason;
  readonly status: RefundStatus;
  /** R-01 原路退回文案（在途=1-3 工作日；DONE/FAILED 终态文案；⚠T6 裁决位：I1 模板化=M2） */
  readonly eta_text: string;
  readonly requested_at: string;
  readonly done_at: string | null;
}
