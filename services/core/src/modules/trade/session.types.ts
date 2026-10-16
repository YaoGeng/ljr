/**
 * C1 场次类型契约与金额/值域工具（§3/§5 契约词汇 snake_case；Money=string 禁 float，架构 §1.3）。
 *
 * 金额工具为模块内实现（payment.types 同形先例——各模块自包含，shared 只承载 Money 形态契约）：
 * moneyToCents/centsToMoney 严格两位小数字符串 ↔ 整数分，全程无浮点；分摊口径
 * splitTotalIntoUnit=总价÷capacity 半分向上取整到分（自定口径，报告注明）。
 *
 * 列宽约束（V23）：unit_price numeric(10,2)（整数位 8 位）；session_total numeric(12,2)
 * （整数位 10 位）——应用层先行 400，不让 DB 22003 漏成 500。
 */
import { AppError, ErrorCode, assertMoney, type Money } from '@ljr/shared';
import type { SessionStatus } from './session.machine';

export { assertMoney };
export type { Money };

/** §3 price_mode 值域（ck_sessions_price_mode 同字面） */
export const PRICE_MODES = ['per_head', 'session_total'] as const;
export type PriceMode = (typeof PRICE_MODES)[number];

/** 沟通形式值域（B3 §3 room_modes 同词汇：text|voice|video；本地定义不跨模块 import 内部件——
 *  V23 头注⑦：值域防御在应用层，不设 DB CHECK 以留 M2 沟通形式演进位） */
export const SESSION_ROOM_MODES = ['text', 'voice', 'video'] as const;
export type SessionRoomMode = (typeof SESSION_ROOM_MODES)[number];

/** NUMERIC(12,2) 上限（整数位 10 位）＝session_total 列上限 */
const SESSION_TOTAL_MAX_CENTS = 999_999_999_999;
/** NUMERIC(10,2) 上限（整数位 8 位）＝unit_price 列上限 */
export const UNIT_PRICE_MAX_CENTS = 9_999_999_999;

/** R-03/§3 CHECK capacity BETWEEN 2 AND 50 同口径（应用层先行 400） */
export const CAPACITY_MIN = 2;
export const CAPACITY_MAX = 50;

const MONEY_SHAPE = /^\d+\.\d{2}$/;

/** Money 字符串 → 整数分（严格两位小数；非法形态/越 NUMERIC(12,2) 抛 AppError——不出 float） */
export function moneyToCents(v: Money): number {
  if (typeof v !== 'string' || !MONEY_SHAPE.test(v)) {
    throw new AppError(ErrorCode.MoneyInvalidFormat, `非法金额：${JSON.stringify(v)}`);
  }
  const [intPart, decPart] = v.split('.') as [string, string];
  const cents = Number(intPart) * 100 + Number(decPart);
  if (!Number.isSafeInteger(cents)) {
    throw new AppError(ErrorCode.InvalidArgument, `金额超出安全整数范围：${v}`);
  }
  if (cents > SESSION_TOTAL_MAX_CENTS) {
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

/** DB numeric 文本 → 整数分（容忍无 typmod 的聚合形态；仍在十进制文本上整化，禁 float） */
export function dbNumericToCents(text: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) {
    throw new AppError(ErrorCode.InternalError, `DB numeric 文本非法：${JSON.stringify(text)}`);
  }
  const dec = (m[2] ?? '').padEnd(2, '0').slice(0, 2);
  return Number(m[1]) * 100 + Number(dec);
}

/**
 * 总价÷capacity 半分向上取整到分（total 模式 unit_price 分摊口径）：
 * floor((2×total + capacity) / (2×capacity))——纯整数运算无浮点；0.5 分恰半向上。
 */
export function splitTotalIntoUnit(totalCents: number, capacity: number): number {
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    !Number.isSafeInteger(capacity) ||
    capacity <= 0
  ) {
    throw new AppError(ErrorCode.InternalError, '分摊入参非法（不应触达）');
  }
  return Math.floor((2 * totalCents + capacity) / (2 * capacity));
}

// ---------------------------------------------------------------------------
// §5 契约入参/出参（snake_case 逐字）
// ---------------------------------------------------------------------------

/** POST /sessions 服务入参（lawyer_id 取 JWT claims，非 body；slot_start/enroll_deadline 为 Date） */
export interface CreateSessionInput {
  readonly lawyer_id: number;
  readonly slot_start: Date;
  readonly price_mode: PriceMode;
  /** 缺省取 B3 默认价（per_head 单价 / session_total 总价，语义随 price_mode——报告注明口径） */
  readonly unit_price?: Money;
  readonly capacity: number;
  /** 缺省=slot_start 前 N 小时（⚠04§8-3，config.enrollDeadlineHours 默认 24） */
  readonly enroll_deadline?: Date;
  readonly room_mode: SessionRoomMode;
}

/** 场次行视图（DB 行读出口径：金额 Money 字符串/时间 ISO 字符串） */
export interface SessionView {
  readonly id: number;
  readonly lawyer_id: number;
  readonly mode: string;
  readonly slot_start: string;
  readonly price_mode: PriceMode;
  readonly unit_price: Money;
  readonly session_total: Money;
  readonly capacity: number;
  readonly joined: number;
  readonly enroll_deadline: string;
  readonly room_mode: string;
  readonly status: SessionStatus;
  readonly created_at: string;
}

/** GET /sessions/{id}：详情+剩余席位（§5 逐字） */
export interface SessionDetailView extends SessionView {
  readonly remaining: number;
}

/** GET /lawyer/sessions/stats 出参（§5 逐字四键）。口径（范围内=slot_start 落 [from,to) 的
 *  sessions 聚合，报告注明）：enroll_rate=Σjoined/Σcapacity；group_rate=已出 CREATED（成团链
 *  FULL..SETTLED）场次数/总场次数；attendance/ooo 桩=null（D3/D6=M2，H4 联调 M2-W2）。 */
export interface SessionStatsView {
  readonly enroll_rate: number | null;
  readonly group_rate: number | null;
  /** 桩标注：到场率依赖 D3 到场判定（M2 落位），本批恒 null——H4 数据源联调 M2-W2 */
  readonly attendance_rate: null;
  /** 桩标注：1对1转化率依赖 D6（M2 落位），本批恒 null */
  readonly ooo_rate: null;
}

/** GET /sessions 筛选（§5 ?specialty=&lawyer=&from=&to=；from/to=YYYY-MM-DD 上海日界）。
 *  specialty 形态收口但本批不参与过滤：V1 仅 labor_arbitration 单专项（E3 R-04），
 *  无律师↔专项映射导出面，过滤语义为恒真——报告/头注注明，M2 专项扩展时接线。 */
export interface ListSessionsFilter {
  readonly specialty?: string;
  readonly lawyer?: number;
  readonly from?: string;
  readonly to?: string;
}

// ---------------------------------------------------------------------------
// 值域校验（错误一律 InvalidArgument=400）
// ---------------------------------------------------------------------------

export function assertPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
  }
  return v;
}

export function assertPriceMode(v: unknown): PriceMode {
  if (typeof v === 'string' && (PRICE_MODES as readonly string[]).includes(v)) {
    return v as PriceMode;
  }
  throw new AppError(ErrorCode.InvalidArgument, `price_mode 须为 per_head|session_total：${JSON.stringify(v)}`);
}

export function assertRoomMode(v: unknown): SessionRoomMode {
  if (typeof v === 'string' && (SESSION_ROOM_MODES as readonly string[]).includes(v)) {
    return v as SessionRoomMode;
  }
  throw new AppError(
    ErrorCode.InvalidArgument,
    `room_mode 须为 text|voice|video（B3 §3 同词汇）：${JSON.stringify(v)}`,
  );
}

export function assertCapacity(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < CAPACITY_MIN || v > CAPACITY_MAX) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `capacity 须为 ${CAPACITY_MIN}-${CAPACITY_MAX} 整数（R-03 开团人数域）：${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** ISO 8601 时刻（POST slot_start/enroll_deadline 线格式；Date 解析失败即 400） */
export function assertIsoDatetime(v: unknown, field: string): Date {
  if (typeof v !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为 ISO 8601 字符串：${JSON.stringify(v)}`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 非法时刻：${v}`);
  }
  return d;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD（列表/stats 区间；上海单时区日界，架构 §4.2 时间语义） */
export function assertIsoDate(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DATE_SHAPE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为 YYYY-MM-DD：${JSON.stringify(v)}`);
  }
  return v;
}

/** 上海日界 → UTC 瞬间（中国无夏令时，偏移恒 +08:00——架构 §4.2 逐字口径） */
export function shanghaiDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+08:00`);
}

export function shanghaiDayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
