/**
 * C1 场次 API（M3-W1 T2）：列表与详情（契约消费，@ljr/shared 类型面无场次视图——
 * 本文件按 core session.service 实文（toView/getDetail 出参）定义消费侧类型，
 * 金额走 Money（shared）禁 float）。
 *
 *   GET /sessions?specialty=&city=&lawyer=&from=&to= → SessionView[]（裸数组；
 *     ⚠core W3-12 决策：公开列表仅返回 CREATED（报名中）场次——本层不补状态过滤参数，
 *     缺口见任务报告 triage）
 *   GET /sessions/{id} → SessionDetailView（+remaining 剩余席位）
 *
 * fail-visible：响应形状（数组/行字段/金额形态）在本层校验，非法即 CLIENT_BAD_RESPONSE
 * （不 any 裸解构、不静默吞错——T6 评审轴「契约对齐」）。
 *
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { isValidMoney, type Money } from './money';

/** C1 场次状态机全集（core session.machine 十态逐字；REFUNDED 属退款域语义不落本机） */
export type SessionStatus =
  | 'CREATED'
  | 'FULL'
  | 'CONFIRMED'
  | 'OPEN'
  | 'IN_SERVICE'
  | 'FINISHED'
  | 'HOLD'
  | 'SETTLED'
  | 'FAILED'
  | 'CANCELLED';

/** §3 price_mode 值域 */
export type PriceMode = 'per_head' | 'session_total';

/** 场次行视图（core SessionView 实文逐字段；时间为 ISO 字符串、金额为 Money 字符串） */
export interface SessionView {
  readonly id: number;
  readonly lawyer_id: number;
  readonly mode: string;
  readonly specialty: string;
  readonly city: string;
  readonly slot_start: string;
  readonly price_mode: PriceMode;
  /** 每人份价格快照（per_head=单价；session_total=总价÷capacity 分摊快照） */
  readonly unit_price: Money;
  readonly session_total: Money;
  readonly capacity: number;
  readonly joined: number;
  readonly enroll_deadline: string;
  readonly room_mode: string;
  readonly status: SessionStatus;
  readonly created_at: string;
}

/** GET /sessions/{id} 出参：详情 + 剩余席位 */
export interface SessionDetailView extends SessionView {
  readonly remaining: number;
}

/** GET /sessions 筛选（§5 查询键；from/to=YYYY-MM-DD 上海日界） */
export interface SessionListQuery {
  readonly specialty?: string;
  readonly city?: string;
  readonly lawyer?: number;
  readonly from?: string;
  readonly to?: string;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `场次响应形状非法：${detail}`,
  });
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** 行形状校验（宽进严出：未知枚举值放行原样——展示层映射表负责回退显示原码）；
 *  M3-W2 T3 起导出——lawyer-sessions.ts（POST /sessions 出参 {session} 解包）复用同一解析 */
export function parseSessionView(raw: unknown): SessionView {
  if (typeof raw !== 'object' || raw === null) throw badShape('行非对象');
  const r = raw as Record<string, unknown>;
  if (!isNonNegInt(r['id']) || r['id'] === 0) throw badShape('id 非正整数');
  if (!isNonNegInt(r['lawyer_id']) || r['lawyer_id'] === 0) throw badShape('lawyer_id 非正整数');
  if (r['price_mode'] !== 'per_head' && r['price_mode'] !== 'session_total') {
    throw badShape('price_mode 越值域');
  }
  if (!isValidMoney(r['unit_price'])) throw badShape('unit_price 非两位小数字符串');
  if (!isValidMoney(r['session_total'])) throw badShape('session_total 非两位小数字符串');
  if (!isNonNegInt(r['capacity']) || r['capacity'] === 0) throw badShape('capacity 非正整数');
  if (!isNonNegInt(r['joined'])) throw badShape('joined 非非负整数');
  if (!isIsoString(r['slot_start'])) throw badShape('slot_start 非时刻');
  if (!isIsoString(r['enroll_deadline'])) throw badShape('enroll_deadline 非时刻');
  for (const key of ['mode', 'specialty', 'city', 'room_mode', 'status', 'created_at']) {
    if (typeof r[key] !== 'string' || (r[key] as string).length === 0) {
      throw badShape(`${key} 非非空字符串`);
    }
  }
  return {
    id: r['id'],
    lawyer_id: r['lawyer_id'],
    mode: r['mode'] as string,
    specialty: r['specialty'] as string,
    city: r['city'] as string,
    slot_start: r['slot_start'] as string,
    price_mode: r['price_mode'] as PriceMode,
    unit_price: r['unit_price'] as Money,
    session_total: r['session_total'] as Money,
    capacity: r['capacity'],
    joined: r['joined'],
    enroll_deadline: r['enroll_deadline'] as string,
    room_mode: r['room_mode'] as string,
    status: r['status'] as SessionStatus,
    created_at: r['created_at'] as string,
  };
}

/** 查询串序列化（undefined 键不出现在 URL） */
function toQueryString(query: SessionListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/** GET /sessions：公开列表（仅审核 PASSED 律师；core 侧仅返回报名中场次） */
export async function fetchSessions(query: SessionListQuery = {}): Promise<SessionView[]> {
  const raw = await apiFetch<unknown>(`/sessions${toQueryString(query)}`);
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map(parseSessionView);
}

/** GET /sessions/{id}：详情+剩余席位 */
export async function fetchSessionDetail(id: number): Promise<SessionDetailView> {
  if (!Number.isInteger(id) || id <= 0 || !Number.isSafeInteger(id)) {
    // 本地入参拒绝（评审 S6）：请求未发出——与「服务响应形状非法」的 CLIENT_BAD_RESPONSE 分码
    throw new AppApiError({
      code: AppClientErrorCode.BadRequest,
      copy: '请求参数有误，请返回重试',
      serverMessage: `场次 id 非正整数：${String(id)}`,
    });
  }
  const raw = await apiFetch<unknown>(`/sessions/${id}`);
  const view = parseSessionView(raw);
  const remaining = (raw as Record<string, unknown>)['remaining'];
  if (!isNonNegInt(remaining)) throw badShape('remaining 非非负整数');
  return { ...view, remaining };
}
