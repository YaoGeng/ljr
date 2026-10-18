/**
 * D1 房间类型契约（§3/§5 契约词汇 snake_case；Money=string 禁 float，架构 §1.3）。
 *
 * 金额工具为模块内实现（settlement.types/payment.types 同形先例——各模块自包含，shared 只
 * 承载 Money 形态契约；本批金额面仅 RoomClosed 的 gross 聚合：Σ(cash+points) 整数分运算）。
 * 时间一律 timestamptz+DB 钟写入；视图出参 ISO 8601 UTC 即时串（D19 口径同 D5 契约冻结）。
 */
import { AppError, ErrorCode, type Money } from '@ljr/shared';

/** §3 status 值域（V35 ck_rooms_status 同字面；迁移经守卫+STL，entity_type='room'） */
export const ROOM_STATUSES = ['OPEN', 'IN_SERVICE', 'CLOSED', 'CANCELLED'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** §3 mode 值域（V35 ck_rooms_mode 同字面；=场次 room_mode 透传，R-04） */
export const ROOM_MODES = ['text', 'voice', 'video'] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

/** R-01 宽限期 5 分钟（毫秒）：grace_end=scheduled_start+本值，应用层锚定（V35 头注禁 DB 表达式） */
export const GRACE_PERIOD_MS = 5 * 60_000;

/** open_fail_reason 列宽（V35 varchar(64)；超长截断——错误码审计口径非 PII） */
export const OPEN_FAIL_REASON_MAX = 64;

export function assertRoomMode(v: unknown): RoomMode {
  if (typeof v === 'string' && (ROOM_MODES as readonly string[]).includes(v)) {
    return v as RoomMode;
  }
  throw new AppError(ErrorCode.InvalidArgument, `mode 须为 text|voice|video：${JSON.stringify(v)}`);
}

export function assertPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

const MONEY_SHAPE = /^\d+\.\d{2}$/;
/** gross 聚合保守上限（实际列上限=NUMERIC(12,2) 的 999,999,999,999 分；聚合前先拦防溢出） */
export const GROSS_MAX_CENTS = 99_999_999_999;

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
  return cents;
}

/** 整数分 → Money 字符串（两位小数；gross 聚合出口） */
export function centsToMoney(cents: number): Money {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new AppError(ErrorCode.InternalError, `整数分须为非负安全整数：${String(cents)}`);
  }
  const intPart = Math.floor(cents / 100);
  const decPart = cents % 100;
  return `${String(intPart)}.${String(decPart).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// §5 契约出参（snake_case 逐字；时间 ISO 字符串）
// ---------------------------------------------------------------------------

/** POST /rooms/{session_id}/close 出参（§5 逐字 {closed_at}） */
export interface RoomClosedResult {
  readonly closed_at: string;
}

/** ROOM_OPEN 执行器返回值（序列化进 schedule_job_log.detail，I2 §4） */
export interface RoomOpenOutcome {
  /** true=本次落 OPEN 行；false=失败分支（CANCELLED） */
  readonly opened: boolean;
  readonly room_id: number;
  readonly session_id: number;
  /** 开房失败因（仅失败分支携带） */
  readonly reason?: string;
  /** true=房间已存在（幂等重放短路，无副作用） */
  readonly deduplicated?: boolean;
}

/** GRACE_END 执行器返回值（session_id=null=房间不存在——可空语义，非 0 哨兵） */
export interface GraceEndOutcome {
  readonly ended: boolean;
  readonly room_id: number;
  readonly session_id: number | null;
}

/** gross 聚合结果（close 用） */
export interface GrossAggregation {
  readonly gross: Money;
  readonly payment_order_id: number;
}
