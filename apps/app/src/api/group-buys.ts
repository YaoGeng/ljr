/**
 * C2 发起拼团 API（M3-W1 T3 建/T4 扩展）：
 *   POST /group-buys（§5 契约 + core 控制器实文）：
 *     入参 {lawyer_id, specialty, slot_start, sub_min, sub_max, question_tags, deadline?}
 *     出参 {group_buy, share_price, payment_order}（payment_order=最小集 PaymentOrderRefView，
 *          无 channel/pay_params——发起人支付回调通道取主通道缺省，见 dev-pay-sim 头注）
 *     错误 409 E_SLOT_TAKEN/E_GROUP_BUY_DUP_KEY、400 E_OUT_OF_RANGE/E_ACCEPT_RANGE_UNSET、403 E_RESTRICTED
 *   GET /group-buys?specialty=&city=（T4；core group-buy.service list 实文）：
 *     GroupBuyView[] 公开列表——仅 PUBLISHED+PASSED 律师（⚠无 /group-buys/mine：GroupBuyView 含
 *     initiator_id，「我发起的团」=公开列表客户端按发起人过滤；状态推进（成团链/终态）后即从
 *     公开列表消失=历史不可见，契约缺口见任务报告 triage，App 如实呈现可得面）
 *
 * fail-visible：出参形状本层校验；入参本地前置校验（id/日期/人数域）不发坏请求。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { isValidMoney, type Money } from './money';

/** C2 §4 状态机全集（group-buy.machine 实文语义见 C2 文档 §4） */
export type GroupBuyStatus =
  | 'PUBLISHED'
  | 'REACHED'
  | 'PENDING_LAWYER'
  | 'CONFIRMED'
  | 'CONVERTED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'REJECTED';

/** C2 GroupBuyView 实文（joined=公开列表恒 null 桩；金额 Money、时间 ISO） */
export interface GroupBuyView {
  readonly id: number;
  readonly initiator_id: number;
  readonly lawyer_id: number;
  readonly specialty: string;
  readonly city: string;
  readonly slot_start: string;
  readonly sub_min: number;
  readonly sub_max: number;
  readonly share_price: Money;
  readonly question_tags: readonly string[];
  readonly deadline: string;
  readonly status: GroupBuyStatus;
  readonly lawyer_confirm_by: string | null;
  readonly created_at: string;
  readonly joined: number | null;
}

/** 发起人支付单引用（F1 最小集：无 channel——回调通道由 dev 模拟器按主通道缺省） */
export interface PaymentOrderRefView {
  readonly id: number;
  readonly biz_type: string;
  readonly biz_id: number;
  readonly cash_amount: Money;
  readonly total: Money;
  readonly status: string;
}

export interface PublishGroupBuyResult {
  readonly group_buy: GroupBuyView;
  readonly share_price: Money;
  readonly payment_order: PaymentOrderRefView;
}

/** POST /group-buys 入参（§5 逐字 snake_case；slot_start/deadline 为 ISO 8601 字符串） */
export interface PublishGroupBuyInput {
  readonly lawyer_id: number;
  readonly specialty: string;
  readonly slot_start: string;
  readonly sub_min: number;
  readonly sub_max: number;
  readonly question_tags: readonly string[];
  readonly deadline?: string;
}

/** GET /group-buys 查询键（§5 ?specialty= + 序 11.5 ?city=；两维均真过滤） */
export interface ListGroupBuysQuery {
  readonly specialty?: string;
  readonly city?: string;
}

/** core 值域（group-buy.types 实文）：sub 2..50；标签 ≤20 项、每项 1..64 字符 */
export const GROUP_BUY_SUB_MIN = 2;
export const GROUP_BUY_SUB_MAX = 50;
export const QUESTION_TAGS_MAX_ITEMS = 20;
export const QUESTION_TAG_MAX_LEN = 64;

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `拼团响应形状非法：${detail}`,
  });
}

function localReject(detail: string, copy = '请求参数有误，请返回重试'): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadRequest,
    copy,
    serverMessage: detail,
  });
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function parseGroupBuy(raw: unknown): GroupBuyView {
  if (typeof raw !== 'object' || raw === null) throw badShape('group_buy 非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['id'])) throw badShape('group_buy.id 非正整数');
  if (!isPosInt(r['initiator_id'])) throw badShape('group_buy.initiator_id 非正整数');
  if (!isPosInt(r['lawyer_id'])) throw badShape('group_buy.lawyer_id 非正整数');
  if (!isPosInt(r['sub_min'])) throw badShape('group_buy.sub_min 非正整数');
  if (!isPosInt(r['sub_max'])) throw badShape('group_buy.sub_max 非正整数');
  if (typeof r['specialty'] !== 'string' || r['specialty'].length === 0) {
    throw badShape('group_buy.specialty 非非空字符串');
  }
  if (typeof r['city'] !== 'string' || r['city'].length === 0) {
    throw badShape('group_buy.city 非非空字符串');
  }
  if (typeof r['status'] !== 'string' || r['status'].length === 0) {
    throw badShape('group_buy.status 非非空字符串');
  }
  if (!isIsoString(r['slot_start'])) throw badShape('group_buy.slot_start 非时刻');
  if (!isIsoString(r['deadline'])) throw badShape('group_buy.deadline 非时刻');
  if (!isIsoString(r['created_at'])) throw badShape('group_buy.created_at 非时刻');
  if (!isValidMoney(r['share_price'])) throw badShape('group_buy.share_price 非两位小数字符串');
  if (!Array.isArray(r['question_tags'])) throw badShape('group_buy.question_tags 非数组');
  if (r['lawyer_confirm_by'] !== null && !isIsoString(r['lawyer_confirm_by'])) {
    throw badShape('group_buy.lawyer_confirm_by 形态非法');
  }
  if (r['joined'] !== null && !isNonNegInt(r['joined'])) {
    throw badShape('group_buy.joined 形态非法');
  }
  return {
    id: r['id'],
    initiator_id: r['initiator_id'],
    lawyer_id: r['lawyer_id'],
    specialty: r['specialty'],
    city: r['city'],
    slot_start: r['slot_start'],
    sub_min: r['sub_min'],
    sub_max: r['sub_max'],
    share_price: r['share_price'] as Money,
    question_tags: r['question_tags'] as readonly string[],
    deadline: r['deadline'],
    status: r['status'] as GroupBuyStatus,
    lawyer_confirm_by: r['lawyer_confirm_by'] as string | null,
    created_at: r['created_at'],
    joined: r['joined'] as number | null,
  };
}

function parseOrderRef(raw: unknown): PaymentOrderRefView {
  if (typeof raw !== 'object' || raw === null) throw badShape('payment_order 非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['id'])) throw badShape('payment_order.id 非正整数');
  if (!isPosInt(r['biz_id'])) throw badShape('payment_order.biz_id 非正整数');
  if (typeof r['biz_type'] !== 'string' || r['biz_type'].length === 0) {
    throw badShape('payment_order.biz_type 非非空字符串');
  }
  if (typeof r['status'] !== 'string' || r['status'].length === 0) {
    throw badShape('payment_order.status 非非空字符串');
  }
  if (!isValidMoney(r['cash_amount'])) throw badShape('payment_order.cash_amount 非两位小数字符串');
  if (!isValidMoney(r['total'])) throw badShape('payment_order.total 非两位小数字符串');
  return {
    id: r['id'],
    biz_type: r['biz_type'],
    biz_id: r['biz_id'],
    cash_amount: r['cash_amount'] as Money,
    total: r['total'] as Money,
    status: r['status'],
  };
}

/** 入参本地前置校验（core 值域镜像：2..50、min≤max、标签域、ISO 时刻） */
export function validatePublishInput(input: PublishGroupBuyInput): void {
  if (!isPosInt(input.lawyer_id) || !Number.isSafeInteger(input.lawyer_id)) {
    throw localReject(`lawyer_id 非正整数：${String(input.lawyer_id)}`, '请先选择目标律师');
  }
  if (typeof input.specialty !== 'string' || input.specialty.length === 0) {
    throw localReject('specialty 非非空字符串');
  }
  if (!isIsoString(input.slot_start)) {
    throw localReject(
      `slot_start 非法时刻：${String(input.slot_start)}`,
      '咨询时间格式有误，请重新填写',
    );
  }
  if (input.deadline !== undefined && !isIsoString(input.deadline)) {
    throw localReject(
      `deadline 非法时刻：${String(input.deadline)}`,
      '截止时间格式有误，请重新填写',
    );
  }
  if (
    !isPosInt(input.sub_min) ||
    !isPosInt(input.sub_max) ||
    input.sub_min < GROUP_BUY_SUB_MIN ||
    input.sub_max > GROUP_BUY_SUB_MAX ||
    input.sub_min > input.sub_max
  ) {
    throw localReject(
      `子范围非法（${GROUP_BUY_SUB_MIN}-${GROUP_BUY_SUB_MAX} 且 min≤max）：` +
        `${String(input.sub_min)}-${String(input.sub_max)}`,
      `拼团人数须在 ${GROUP_BUY_SUB_MIN}-${GROUP_BUY_SUB_MAX} 之间且下限不超过上限`,
    );
  }
  if (!Array.isArray(input.question_tags) || input.question_tags.length > QUESTION_TAGS_MAX_ITEMS) {
    throw localReject(
      `question_tags 须为数组且至多 ${QUESTION_TAGS_MAX_ITEMS} 项`,
      `问题标签至多 ${QUESTION_TAGS_MAX_ITEMS} 项`,
    );
  }
  for (const tag of input.question_tags) {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > QUESTION_TAG_MAX_LEN) {
      throw localReject(
        `question_tags 项须为 1-${QUESTION_TAG_MAX_LEN} 字符：${JSON.stringify(tag)}`,
        `问题标签每项须 1-${QUESTION_TAG_MAX_LEN} 字符`,
      );
    }
  }
}

/** POST /group-buys：发布拼团（发起人=登录 user；city 缺省由 core 按律师执业城市物化） */
export async function publishGroupBuy(input: PublishGroupBuyInput): Promise<PublishGroupBuyResult> {
  validatePublishInput(input);
  const body: Record<string, unknown> = {
    lawyer_id: input.lawyer_id,
    specialty: input.specialty,
    slot_start: input.slot_start,
    sub_min: input.sub_min,
    sub_max: input.sub_max,
    question_tags: [...input.question_tags],
  };
  if (input.deadline !== undefined) body['deadline'] = input.deadline;
  const raw = await apiFetch<unknown>('/group-buys', { method: 'POST', body, auth: true });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (!isValidMoney(r['share_price'])) throw badShape('顶层 share_price 非两位小数字符串');
  return {
    group_buy: parseGroupBuy(r['group_buy']),
    share_price: r['share_price'] as Money,
    payment_order: parseOrderRef(r['payment_order']),
  };
}

/** GET /group-buys：公开列表（仅拼团中 PUBLISHED+PASSED 律师；无 initiator 查询键——本人过滤在客户端） */
export async function fetchGroupBuys(query: ListGroupBuysQuery = {}): Promise<GroupBuyView[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  const raw = await apiFetch<unknown>(`/group-buys${qs.length > 0 ? `?${qs}` : ''}`);
  if (!Array.isArray(raw)) throw badShape('列表响应非数组');
  return raw.map(parseGroupBuy);
}

/** 「我发起的拼团」=公开列表按发起人过滤（纯函数；可见窗口仅 PUBLISHED——见文件头 triage 注记） */
export function filterInitiatedBy(
  views: readonly GroupBuyView[],
  initiatorId: number,
): GroupBuyView[] {
  if (!isPosInt(initiatorId)) return [];
  return views.filter((g) => g.initiator_id === initiatorId);
}
