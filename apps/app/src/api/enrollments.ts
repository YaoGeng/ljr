/**
 * C3 报名 API（M3-W1 T3 建/T4 扩展）：
 *   POST /sessions/{id}/enroll（§5 契约 + core 控制器实文出参）：
 *     入参 {points_to_use?}（可选非负整数，100 积分=1 元、单次≤应付 50%——V1 前端默认 0 简化）
 *     出参 {enrollment, payment_order, pay_params}（enrollment.controller .then 包装实文五键）
 *     错误 402 E_REALNAME_REQUIRED / 403 E_RESTRICTED / 409 E_FULL_OR_DEADLINE /
 *          409 E_ENROLL_DUP_KEY（AppApiError 携码上抛，视图层按 error-messages 映射分诊）
 *   GET /enrollments/mine（T4；core enrollment.service listMine 实文）：
 *     EnrollmentMineItem[] {enrollment_id, ref_type, ref_id, status(pay_status),
 *     amounts{paid,cash,points}, refund_status, created_at}——LIMIT 100 无分页（core 自定护栏）。
 *
 * fail-visible：出参形状（金额 Money 形态/枚举/整数）本层校验，非法即 CLIENT_BAD_RESPONSE。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { isValidMoney, type Money } from './money';

/**
 * F1 支付单简报（enroll 出参内嵌=enrollment.service create() 实文七键最小集：无
 * channel/idempotency_key/created_at 等——T5 E2E 实证对齐；完整单据以 F1 导出面为准）。
 * （T3 原版误按 F1 PaymentOrderView 全字段校验，真实 core 出参无 channel 等 5 键 →
 *  恒抛 CLIENT_BAD_RESPONSE——单测喂了全量形状与实文漂移，E2E 全贯暴露后本卡修复。）
 */
export interface PaymentOrderView {
  readonly id: number;
  readonly biz_type: string;
  readonly biz_id: number;
  readonly cash_amount: Money;
  readonly points_amount: number;
  readonly total: Money;
  readonly status: string;
}

/** F1 PayParamsView（mock 通道形态：mockpay:// 非网络 URL + order_id + channel） */
export interface PayParamsView {
  readonly mock_pay_url: string;
  readonly order_id: number;
  readonly channel: string;
}

/** C3 enroll 出参的 enrollment 键（控制器包装实文：五键） */
export interface EnrollmentRefView {
  readonly id: number;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly paid_amount: Money;
  readonly cash_amount: Money;
  readonly points_amount: number;
}

export interface EnrollResult {
  readonly enrollment: EnrollmentRefView;
  readonly payment_order: PaymentOrderView;
  readonly pay_params: PayParamsView;
}

/** C3 报名支付状态机全集（core enrollment.machine 五态逐字） */
export type EnrollmentPayStatus =
  'PENDING' | 'PAID' | 'REFUNDED' | 'CONVERTED_OUT' | 'RESCHEDULED_OUT';

/** 退款态（core EnrollmentRefundStatus 四态：pay_status=REFUNDED 恒 REFUNDED，否则按 F2 最新退款映射） */
export type EnrollmentRefundStatus = 'NONE' | 'PROCESSING' | 'REFUNDED' | 'FAILED';

/**
 * GET /enrollments/mine 行（core EnrollmentMineItem 实文逐键；§5 {status, amounts, refund_status}）。
 * status/refund_status 结构层校验非空字符串（未知枚举值放行原样——展示层映射表回退显示原码）。
 */
export interface EnrollmentMineItem {
  readonly enrollment_id: number;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly status: EnrollmentPayStatus;
  readonly amounts: {
    readonly paid: Money;
    readonly cash: Money;
    readonly points: number;
  };
  readonly refund_status: EnrollmentRefundStatus;
  readonly created_at: string;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `报名响应形状非法：${detail}`,
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

function parseEnrollment(raw: unknown): EnrollmentRefView {
  if (typeof raw !== 'object' || raw === null) throw badShape('enrollment 非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['id'])) throw badShape('enrollment.id 非正整数');
  if (!isPosInt(r['ref_id'])) throw badShape('enrollment.ref_id 非正整数');
  if (typeof r['ref_type'] !== 'string' || r['ref_type'].length === 0) {
    throw badShape('enrollment.ref_type 非非空字符串');
  }
  if (!isValidMoney(r['paid_amount'])) throw badShape('enrollment.paid_amount 非两位小数字符串');
  if (!isValidMoney(r['cash_amount'])) throw badShape('enrollment.cash_amount 非两位小数字符串');
  if (!isNonNegInt(r['points_amount'])) throw badShape('enrollment.points_amount 非非负整数');
  return {
    id: r['id'],
    ref_type: r['ref_type'],
    ref_id: r['ref_id'],
    paid_amount: r['paid_amount'] as Money,
    cash_amount: r['cash_amount'] as Money,
    points_amount: r['points_amount'],
  };
}

function parsePaymentOrder(raw: unknown): PaymentOrderView {
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
  if (!isNonNegInt(r['points_amount'])) throw badShape('payment_order.points_amount 非非负整数');
  return {
    id: r['id'],
    biz_type: r['biz_type'],
    biz_id: r['biz_id'],
    cash_amount: r['cash_amount'] as Money,
    points_amount: r['points_amount'],
    total: r['total'] as Money,
    status: r['status'],
  };
}

function parsePayParams(raw: unknown): PayParamsView {
  if (typeof raw !== 'object' || raw === null) throw badShape('pay_params 非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['mock_pay_url'] !== 'string' || r['mock_pay_url'].length === 0) {
    throw badShape('pay_params.mock_pay_url 非非空字符串');
  }
  if (!isPosInt(r['order_id'])) throw badShape('pay_params.order_id 非正整数');
  if (typeof r['channel'] !== 'string' || r['channel'].length === 0) {
    throw badShape('pay_params.channel 非非空字符串');
  }
  return {
    mock_pay_url: r['mock_pay_url'],
    order_id: r['order_id'],
    channel: r['channel'],
  };
}

/**
 * POST /sessions/{id}/enroll：报名下单（快照价）。
 * pointsToUse=0 视同未抵扣（不发键——与服务端 parseEnrollBody 0 值语义等价，载荷最小化）。
 */
export async function enrollInSession(sessionId: number, pointsToUse = 0): Promise<EnrollResult> {
  if (!isPosInt(sessionId) || !Number.isSafeInteger(sessionId)) {
    throw new AppApiError({
      code: AppClientErrorCode.BadRequest,
      copy: '请求参数有误，请返回重试',
      serverMessage: `场次 id 非正整数：${String(sessionId)}`,
    });
  }
  if (!isNonNegInt(pointsToUse) || !Number.isSafeInteger(pointsToUse)) {
    throw new AppApiError({
      code: AppClientErrorCode.BadRequest,
      copy: '积分抵扣数额有误，请重新输入',
      serverMessage: `points_to_use 非非负整数：${String(pointsToUse)}`,
    });
  }
  const body = pointsToUse > 0 ? { points_to_use: pointsToUse } : {};
  const raw = await apiFetch<unknown>(`/sessions/${sessionId}/enroll`, {
    method: 'POST',
    body,
    auth: true,
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  return {
    enrollment: parseEnrollment(r['enrollment']),
    payment_order: parsePaymentOrder(r['payment_order']),
    pay_params: parsePayParams(r['pay_params']),
  };
}

/** GET /enrollments/mine 行形状校验（宽进严出：枚举未知值放行——文案层回退原码） */
function parseEnrollmentMineItem(raw: unknown): EnrollmentMineItem {
  if (typeof raw !== 'object' || raw === null) throw badShape('mine 行非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['enrollment_id'])) throw badShape('enrollment_id 非正整数');
  if (!isPosInt(r['ref_id'])) throw badShape('ref_id 非正整数');
  if (typeof r['ref_type'] !== 'string' || r['ref_type'].length === 0) {
    throw badShape('ref_type 非非空字符串');
  }
  if (typeof r['status'] !== 'string' || r['status'].length === 0) {
    throw badShape('status 非非空字符串');
  }
  if (typeof r['refund_status'] !== 'string' || r['refund_status'].length === 0) {
    throw badShape('refund_status 非非空字符串');
  }
  if (!isIsoString(r['created_at'])) throw badShape('created_at 非时刻');
  const a = r['amounts'];
  if (typeof a !== 'object' || a === null) throw badShape('amounts 非对象');
  const amounts = a as Record<string, unknown>;
  if (!isValidMoney(amounts['paid'])) throw badShape('amounts.paid 非两位小数字符串');
  if (!isValidMoney(amounts['cash'])) throw badShape('amounts.cash 非两位小数字符串');
  if (!isNonNegInt(amounts['points'])) throw badShape('amounts.points 非非负整数');
  return {
    enrollment_id: r['enrollment_id'],
    ref_type: r['ref_type'],
    ref_id: r['ref_id'],
    status: r['status'] as EnrollmentPayStatus,
    amounts: {
      paid: amounts['paid'] as Money,
      cash: amounts['cash'] as Money,
      points: amounts['points'],
    },
    refund_status: r['refund_status'] as EnrollmentRefundStatus,
    created_at: r['created_at'],
  };
}

/** GET /enrollments/mine：我的报名列表（user 本人面；core LIMIT 100 无分页） */
export async function fetchMyEnrollments(): Promise<EnrollmentMineItem[]> {
  const raw = await apiFetch<unknown>('/enrollments/mine', { auth: true });
  if (!Array.isArray(raw)) throw badShape('mine 响应非数组');
  return raw.map(parseEnrollmentMineItem);
}
