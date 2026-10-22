/**
 * C4 律师响应面 API（M3-W2 T4）：接单大厅 + 三动作封装（§5 契约 + core 实文）：
 *   GET  /lawyer/group-buys?status=PENDING_LAWYER   接单大厅（指定自己的待确认清单）
 *                                                    → GroupBuyView[] 裸数组
 *                                                    （joined=已支付参与者数真值——与公开
 *                                                    列表恒 null 桩不同，group-buy.types 头注）
 *   POST /group-buys/{id}/confirm                   → {session_id}（409 E_NOT_REACHED /
 *                                                    403 E_RESTRICTED #36 停接拦 confirm 时点）
 *   POST /group-buys/{id}/reject  {reason?}         → {status}（409 E_NOT_PENDING）
 *   POST /group-buys/{id}/convert {capacity?,price?} → {session_id}（409 E_NOT_CONVERTIBLE）
 *
 * 独立文件理由（T4 简报二选一）：lawyer-* 命名先例（lawyer-sessions/lawyer-stats）——
 * group-buys.ts 保持用户面（C2 发布/公开列表）；本件=律师面（C4 响应/转化）。
 * GroupBuyView 解析复用 group-buys.ts parseGroupBuy 单源（T3 parseSessionView export 先例），
 * 零第二份形状校验。
 *
 * 注意（core parseRejectBody/parseConvertBody 实文）：reject/convert 请求体必须为 JSON
 * 对象（缺体 400「请求体须为 JSON 对象」）——无输入时本层显式发 {}，不发空体。
 * fail-visible：出参形状本层校验；入参本地前置校验（id/人数域/金额形态/理由长度）不发坏请求。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { parseGroupBuy, type GroupBuyView } from './group-buys';
import { isValidMoney, type Money } from './money';

/** core 容量域（session.types assertCapacity 实文：2..50——convert capacity 同域） */
export const CONVERT_CAPACITY_MIN = 2;
export const CONVERT_CAPACITY_MAX = 50;
/** core parseRejectBody 理由域（1..500 字符，值域不设） */
export const REJECT_REASON_MAX_LEN = 500;

export interface ConvertGroupBuyInput {
  /** 转化场容量（§11：律师定，缺省=sub_max 在 core 解算） */
  readonly capacity?: number;
  /** per_head 单价覆盖（两位小数金额字符串；缺省=B3 现值在 core 解算，B3 未配须显式传） */
  readonly price?: Money;
}

/** 动作出参（§5 逐字：confirm/convert → {session_id}；reject → {status}） */
export interface SessionIdResult {
  readonly session_id: number;
}

export interface RejectResult {
  readonly status: string;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `拼团响应动作出参形状非法：${detail}`,
  });
}

function localReject(detail: string, copy = '请求参数有误，请返回重试'): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadRequest,
    copy,
    serverMessage: detail,
  });
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 动作目标 id 本地校验（core parsePositiveInt 镜像——不发坏请求） */
function assertActionId(groupBuyId: number): number {
  if (!isPosInt(groupBuyId) || !Number.isSafeInteger(groupBuyId)) {
    throw localReject(
      `group_buy_id 非正整数：${String(groupBuyId)}`,
      '拼团任务参数有误，请刷新列表',
    );
  }
  return groupBuyId;
}

/** {session_id} 出参解析（confirm/convert 共用） */
function parseSessionIdResult(raw: unknown): SessionIdResult {
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['session_id'])) throw badShape('session_id 非正整数');
  return { session_id: r['session_id'] };
}

/** GET /lawyer/group-buys?status=PENDING_LAWYER：接单大厅（Bearer+lawyer；
 *  status 显式携带=§5 逐字——core 仅此一档，其他值 400） */
export async function fetchLawyerHallGroupBuys(): Promise<GroupBuyView[]> {
  const raw = await apiFetch<unknown>('/lawyer/group-buys?status=PENDING_LAWYER', {
    auth: true,
  });
  if (!Array.isArray(raw)) throw badShape('大厅列表响应非数组');
  return raw.map(parseGroupBuy);
}

/** POST /group-buys/{id}/confirm：确认接单（幂等键=gb——CONFIRMED 态重放回原 session_id） */
export async function confirmGroupBuy(groupBuyId: number): Promise<SessionIdResult> {
  const id = assertActionId(groupBuyId);
  const raw = await apiFetch<unknown>(`/group-buys/${id}/confirm`, { method: 'POST', auth: true });
  return parseSessionIdResult(raw);
}

/** POST /group-buys/{id}/reject：婉拒（幂等键=gb——REJECTED 态重放回 {status}；
 *  后果=用户全额退款+信用 -5（R-01），文案层承载） */
export async function rejectGroupBuy(groupBuyId: number, reason?: string): Promise<RejectResult> {
  const id = assertActionId(groupBuyId);
  if (reason !== undefined) {
    if (
      typeof reason !== 'string' ||
      reason.length === 0 ||
      reason.length > REJECT_REASON_MAX_LEN
    ) {
      throw localReject(
        `reason 须为 1-${REJECT_REASON_MAX_LEN} 字符字符串`,
        `婉拒理由须 1-${REJECT_REASON_MAX_LEN} 字`,
      );
    }
  }
  // core parseRejectBody 须收 JSON 对象——无理由时显式 {}（缺体 400）
  const body: Record<string, unknown> = reason === undefined ? {} : { reason };
  const raw = await apiFetch<unknown>(`/group-buys/${id}/reject`, {
    method: 'POST',
    body,
    auth: true,
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('reject 响应非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['status'] !== 'string' || r['status'].length === 0) {
    throw badShape('status 非非空字符串');
  }
  return { status: r['status'] };
}

/** POST /group-buys/{id}/convert：认领转化 C2B→B2C（幂等键=gb；源态=
 *  PUBLISHED/REACHED/PENDING_LAWYER——PENDING_LAWYER 直接转化=认领口径） */
export async function convertGroupBuy(
  groupBuyId: number,
  input: ConvertGroupBuyInput = {},
): Promise<SessionIdResult> {
  const id = assertActionId(groupBuyId);
  const body: Record<string, unknown> = {};
  if (input.capacity !== undefined) {
    if (
      !Number.isInteger(input.capacity) ||
      input.capacity < CONVERT_CAPACITY_MIN ||
      input.capacity > CONVERT_CAPACITY_MAX
    ) {
      throw localReject(
        `capacity 须为 ${CONVERT_CAPACITY_MIN}-${CONVERT_CAPACITY_MAX} 整数：${String(input.capacity)}`,
        `转化容量须在 ${CONVERT_CAPACITY_MIN}-${CONVERT_CAPACITY_MAX} 之间`,
      );
    }
    body['capacity'] = input.capacity;
  }
  if (input.price !== undefined) {
    if (!isValidMoney(input.price)) {
      throw localReject(
        `price 须为两位小数金额字符串：${String(input.price)}`,
        '转化单价须为两位小数金额（如 120.00）',
      );
    }
    body['price'] = input.price;
  }
  // core parseConvertBody 须收 JSON 对象——无覆盖时显式 {}（缺省解算在 core）
  const raw = await apiFetch<unknown>(`/group-buys/${id}/convert`, {
    method: 'POST',
    body,
    auth: true,
  });
  return parseSessionIdResult(raw);
}

// ---------------------------------------------------------------------------
// 12h 确认窗剩余展示（纯函数，可注入时钟直测）
// ---------------------------------------------------------------------------

/**
 * lawyer_confirm_by 锚的剩余响应窗展示：分钟向上取整（倒计时永不显示「剩余 0 分钟」
 * 而窗未到；向上取整=提示用户提前行动的安全方向）；≤60 分钟用纯分钟形，>60 分钟用
 * 'X 小时 Y 分'；≤0 → '已超窗'（超窗=12h 自动拒绝在途/已生效，C4 R-01——刷新后该团
 * 离开待确认面）。
 */
export function formatConfirmWindow(confirmBy: string, now: Date = new Date()): string {
  const remainingMs = Date.parse(confirmBy) - now.getTime();
  if (Number.isNaN(remainingMs)) {
    throw new Error(`非法时刻（期望 ISO 8601 字符串）：${JSON.stringify(confirmBy)}`);
  }
  if (remainingMs <= 0) return '已超窗';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes <= 60) return `剩余 ${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `剩余 ${hours} 小时 ${minutes} 分`;
}
