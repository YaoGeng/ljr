/**
 * C1 B2C 开团 API（M3-W2 T3）：POST /sessions 封装（§5 七键——lawyer_id 取 JWT claims
 * 不入 body，core session.controller 实文）：
 *   入参 {slot_start, price_mode, unit_price?, capacity, enroll_deadline?, room_mode}
 *   出参 {session: SessionView}（解包复用 sessions.ts parseSessionView 单源）
 *   错误 409 E_SLOT_TAKEN（B2 占用锁唯一防线）/409 E_SESSION_DUP_KEY（幂等键同键异载荷）/
 *        403 E_RESTRICTED（G1 BAN_PUBLISH）/429 E_RATE_LIMITED（B2 R-03 防御位——B2C 创建
 *        即锁 LOCKED 不计数，自然流程不可达，core 头注锚 R-W3-F）/400 E_ENROLL_DEADLINE_INVALID
 *        （临期场次缺省截止已过须显式传未来截止，R-W3-G）
 *
 * unit_price 语义（core resolvePrices）：per_head 模式=每人单价；session_total 模式=场次
 * 总价（core 内部 splitTotalIntoUnit 分摊出 unit）；缺省=取 B3 默认价（按 price_mode 同侧）。
 * 本地前置校验镜像 core parseSessionBody + assertCapacity/assertRoomMode（不发坏请求）。
 *
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { isValidMoney, type Money } from './money';
import { parseSessionView, type PriceMode, type SessionView } from './sessions';

export type { PriceMode, SessionView } from './sessions';

/** POST /sessions 入参（§5 逐字 snake_case；slot_start/enroll_deadline 为 ISO 8601 字符串） */
export interface CreateSessionInput {
  readonly slot_start: string;
  readonly price_mode: PriceMode;
  /** 缺省取 B3 默认价（per_head=单价 / session_total=总价，语义随 price_mode） */
  readonly unit_price?: Money;
  readonly capacity: number;
  /** 缺省=slot_start 前 24h（core config.enrollDeadlineHours；临期场次必填未来截止） */
  readonly enroll_deadline?: string;
  readonly room_mode: 'text' | 'voice' | 'video';
}

/** R-03/§3 CHECK capacity BETWEEN 2 AND 50（core assertCapacity 同口径） */
export const SESSION_CAPACITY_MIN = 2;
export const SESSION_CAPACITY_MAX = 50;

/** per_head 档 raw 值归属 unit_price 列=numeric(10,2) 上限（分；core UNIT_PRICE_MAX_CENTS 同值） */
export const UNIT_PRICE_MAX_CENTS = 9_999_999_999;

/** session_total 档 raw 值归属 session_total 列=numeric(12,2) 上限（分；core 同值——评审 N-1 分档） */
export const SESSION_TOTAL_MAX_CENTS = 999_999_999_999;

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `开团响应形状非法：${detail}`,
  });
}

function localReject(detail: string, copy = '请检查表单后重试'): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadRequest,
    copy,
    serverMessage: `开团入参非法：${detail}`,
  });
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/**
 * 入参本地前置校验（core parseSessionBody/assertCapacity/assertRoomMode 值域镜像；
 * slot_start 过去时刻=core R-W3-G ① 同拒——本地先行不发坏请求）。
 */
export function validateCreateSessionInput(input: CreateSessionInput): void {
  if (!isIsoString(input?.slot_start)) {
    throw localReject(
      `slot_start 须为 ISO 8601 字符串：${String(input?.slot_start)}`,
      '开始时间格式有误',
    );
  }
  if (Date.parse(input.slot_start) <= Date.now()) {
    throw localReject(`slot_start 须为未来时刻：${input.slot_start}`, '开始时间须晚于当前时刻');
  }
  if (input.price_mode !== 'per_head' && input.price_mode !== 'session_total') {
    throw localReject(
      `price_mode 须为 per_head|session_total：${JSON.stringify(input?.price_mode)}`,
      '计价方式须选择人头价或场次总价',
    );
  }
  if (
    typeof input.capacity !== 'number' ||
    !Number.isInteger(input.capacity) ||
    input.capacity < SESSION_CAPACITY_MIN ||
    input.capacity > SESSION_CAPACITY_MAX
  ) {
    throw localReject(
      `capacity 须为 ${SESSION_CAPACITY_MIN}-${SESSION_CAPACITY_MAX} 整数（R-03 开团人数域）：${JSON.stringify(input?.capacity)}`,
      `开团人数须在 ${SESSION_CAPACITY_MIN}-${SESSION_CAPACITY_MAX} 之间`,
    );
  }
  if (input.room_mode !== 'text' && input.room_mode !== 'voice' && input.room_mode !== 'video') {
    throw localReject(
      `room_mode 须为 text|voice|video：${JSON.stringify(input?.room_mode)}`,
      '沟通形式须选择文字/语音/视频之一',
    );
  }
  if (input.unit_price !== undefined) {
    if (!isValidMoney(input.unit_price)) {
      throw localReject(
        `unit_price 须为两位小数金额字符串（Money 禁 float/number）：${JSON.stringify(input.unit_price)}`,
        '价格须为两位小数金额（如 99.00）',
      );
    }
    // 列宽按模式分档镜像 core assertColumnBounds（评审 N-1：raw 值归属列随 price_mode——
    // per_head=每人单价入 unit_price numeric(10,2)，session_total=场次总价入 numeric(12,2)）。
    // 注：core 另有 totalCents=单价×capacity ≤12,2 第二重，但在 unit≤10,2 且 capacity≤50
    // 值域下数学不可达（max 499,999,999,950 分 < 12,2 上限）——本地不镜像不可达分支。
    const dot = input.unit_price.indexOf('.');
    const cents =
      Number(input.unit_price.slice(0, dot)) * 100 + Number(input.unit_price.slice(dot + 1));
    const cap = input.price_mode === 'per_head' ? UNIT_PRICE_MAX_CENTS : SESSION_TOTAL_MAX_CENTS;
    if (cents > cap) {
      const column =
        input.price_mode === 'per_head'
          ? 'unit_price numeric(10,2)（每人单价）'
          : 'session_total numeric(12,2)（场次总价）';
      throw localReject(`unit_price 超出 ${column} 列宽：${input.unit_price}`);
    }
  }
  if (input.enroll_deadline !== undefined) {
    if (!isIsoString(input.enroll_deadline)) {
      throw localReject(
        `enroll_deadline 须为 ISO 8601 字符串：${String(input.enroll_deadline)}`,
        '报名截止时间格式有误',
      );
    }
    if (Date.parse(input.enroll_deadline) >= Date.parse(input.slot_start)) {
      throw localReject(
        `enroll_deadline 须早于 slot_start（截止先于开始）：${input.enroll_deadline}`,
        '报名截止须早于开始时间',
      );
    }
  }
}

/**
 * session_total 模式人均分摊预览（core splitTotalIntoUnit 同口径纯整数算式：
 * floor((2×total + capacity) / (2×capacity))——0.5 分恰半向上；无浮点）。
 */
export function splitTotalPerHead(total: Money, capacity: number): Money {
  if (!isValidMoney(total)) {
    throw localReject(`total 须为两位小数金额字符串：${JSON.stringify(total)}`);
  }
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw localReject(`capacity 须为正整数：${String(capacity)}`);
  }
  const dot = total.indexOf('.');
  const totalCents = Number(total.slice(0, dot)) * 100 + Number(total.slice(dot + 1));
  const per = Math.floor((2 * totalCents + capacity) / (2 * capacity));
  return `${String(Math.floor(per / 100))}.${String(per % 100).padStart(2, '0')}`;
}

/** POST /sessions：B2C 开团（Bearer+lawyer；成功即 B2 加锁同事务——409=时段被占/同键异载荷） */
export async function createSession(input: CreateSessionInput): Promise<SessionView> {
  validateCreateSessionInput(input);
  const body: Record<string, unknown> = {
    slot_start: input.slot_start,
    price_mode: input.price_mode,
    capacity: input.capacity,
    room_mode: input.room_mode,
  };
  if (input.unit_price !== undefined) body['unit_price'] = input.unit_price;
  if (input.enroll_deadline !== undefined) body['enroll_deadline'] = input.enroll_deadline;
  const raw = await apiFetch<unknown>('/sessions', { method: 'POST', auth: true, body });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['session'] !== 'object' || r['session'] === null) {
    throw badShape('session 包键缺失');
  }
  return parseSessionView(r['session']);
}
