import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import { isAppApiError, setAccessToken, __resetClientForTest } from './client';
import { enrollInSession, fetchMyEnrollments } from './enrollments';
import { jsonResponse, stubFetch } from './test-helpers';

/** C3 enroll 出参实文样例（enrollment.controller 包装；payment_order=enrollment.service
 *  create() 实文七键最小集——无 channel/idempotency_key 等，T5 E2E 对齐后逐字锁形状） */
const OK_BODY = {
  enrollment: {
    id: 11,
    ref_type: 'session',
    ref_id: 4,
    paid_amount: '100.00',
    cash_amount: '100.00',
    points_amount: 0,
  },
  payment_order: {
    id: 9001,
    biz_type: 'enroll',
    biz_id: 11,
    cash_amount: '100.00',
    points_amount: 0,
    total: '100.00',
    status: 'CREATED',
  },
  pay_params: {
    mock_pay_url: 'mockpay://wechat_ecom/pay?order_id=9001',
    order_id: 9001,
    channel: 'wechat_ecom',
  },
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('C3 报名 API（POST /sessions/{id}/enroll 形状与错误码）', () => {
  it('正常链：出参三键形状校验通过，金额为 Money 字符串', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([jsonResponse(201, OK_BODY)]);
    const r = await enrollInSession(4, 0);
    expect(r.enrollment.id).toBe(11);
    expect(r.payment_order.total).toBe('100.00');
    expect(r.pay_params.channel).toBe('wechat_ecom');
    // points=0 不发键（载荷最小化）；auth 注入
    expect(seen[0]?.url).toBe('http://core.test/sessions/4/enroll');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; body?: string };
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer jwt-u');
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it('积分抵扣 >0 时随请求发送（{points_to_use: 5000}）', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([
      jsonResponse(201, {
        ...OK_BODY,
        enrollment: { ...OK_BODY.enrollment, cash_amount: '50.00', points_amount: 5000 },
        payment_order: {
          ...OK_BODY.payment_order,
          cash_amount: '50.00',
          points_amount: 5000,
          total: '100.00',
        },
      }),
    ]);
    const r = await enrollInSession(4, 5000);
    expect(r.enrollment.points_amount).toBe(5000);
    const init = seen[0]?.init as RequestInit & { body?: string };
    expect(JSON.parse(String(init.body))).toEqual({ points_to_use: 5000 });
  });

  it('402 E_REALNAME_REQUIRED → AppApiError 携码 + 映射文案（报名前需完成实名认证）', async () => {
    setAccessToken('jwt-u');
    stubFetch([jsonResponse(402, { code: ErrorCode.RealnameRequired, message: '实名未通过' })]);
    const err = (await enrollInSession(4, 0).then(
      () => null,
      (e: unknown) => e,
    )) as ReturnType<typeof Object> & { code: string; message: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.code).toBe('E_REALNAME_REQUIRED');
    expect(err.httpStatus).toBe(402);
    expect(err.message).toBe('报名前需完成实名认证');
  });

  it('409 E_FULL_OR_DEADLINE / E_ENROLL_DUP_KEY → 映射文案（错误三态之二）', async () => {
    setAccessToken('jwt-u');
    stubFetch([jsonResponse(409, { code: ErrorCode.FullOrDeadline, message: '满员' })]);
    const e1 = (await enrollInSession(4, 0).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(e1.message).toBe('名额已满或已过报名截止时间，请选择其他场次');
    stubFetch([jsonResponse(409, { code: ErrorCode.EnrollDuplicateKey, message: '同键异载荷' })]);
    const e2 = (await enrollInSession(4, 0).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(e2.message).toBe('已存在进行中的报名，请勿重复提交');
  });

  it('形状非法（payment_order.cash_amount 数字）→ CLIENT_BAD_RESPONSE 不裸解构', async () => {
    stubFetch([
      jsonResponse(201, {
        ...OK_BODY,
        payment_order: { ...OK_BODY.payment_order, cash_amount: 100 },
      }),
    ]);
    const err = (await enrollInSession(4, 0).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('本地入参拒绝（非法 id / 负积分）→ CLIENT_BAD_REQUEST，请求未发出', async () => {
    const seen = stubFetch([]);
    const e1 = (await enrollInSession(0, 0).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e1.code).toBe('CLIENT_BAD_REQUEST');
    const e2 = (await enrollInSession(4, -5).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e2.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });
});

/** GET /enrollments/mine 行实文样例（core EnrollmentMineItem：§5 {status, amounts, refund_status}） */
const MINE_ROW = {
  enrollment_id: 31,
  ref_type: 'session',
  ref_id: 10,
  status: 'PAID',
  amounts: { paid: '199.00', cash: '199.00', points: 0 },
  refund_status: 'NONE',
  created_at: '2026-10-21T09:00:00.000Z',
};

describe('C3 我的报名 API（GET /enrollments/mine，T4）', () => {
  it('正常链：行形状校验通过（金额 Money/积分数/枚举串），auth 注入', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([jsonResponse(200, [MINE_ROW])]);
    const rows = await fetchMyEnrollments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enrollment_id).toBe(31);
    expect(rows[0]?.amounts.paid).toBe('199.00');
    expect(rows[0]?.amounts.points).toBe(0);
    expect(rows[0]?.refund_status).toBe('NONE');
    expect(seen[0]?.url).toBe('http://core.test/enrollments/mine');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; method: string };
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-u');
  });

  it('退款态与拼团行：refund_status 四态值透传 + ref_type=groupbuy 行解析', async () => {
    setAccessToken('jwt-u');
    stubFetch([
      jsonResponse(200, [
        {
          ...MINE_ROW,
          enrollment_id: 32,
          ref_type: 'groupbuy',
          ref_id: 21,
          status: 'REFUNDED',
          refund_status: 'REFUNDED',
          amounts: { paid: '60.00', cash: '60.00', points: 0 },
        },
        { ...MINE_ROW, enrollment_id: 33, status: 'PENDING', refund_status: 'PROCESSING' },
      ]),
    ]);
    const rows = await fetchMyEnrollments();
    expect(rows[0]?.ref_type).toBe('groupbuy');
    expect(rows[0]?.status).toBe('REFUNDED');
    expect(rows[0]?.refund_status).toBe('REFUNDED');
    expect(rows[1]?.refund_status).toBe('PROCESSING');
  });

  it('形状非法（amounts.paid 数字 / points 负数 / 非数组）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-u');
    // amounts.paid 数字
    stubFetch([
      jsonResponse(200, [{ ...MINE_ROW, amounts: { paid: 199, cash: '199.00', points: 0 } }]),
    ]);
    const e1 = (await fetchMyEnrollments().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e1.code).toBe('CLIENT_BAD_RESPONSE');
    // points 负数
    stubFetch([
      jsonResponse(200, [{ ...MINE_ROW, amounts: { paid: '199.00', cash: '199.00', points: -1 } }]),
    ]);
    const e2 = (await fetchMyEnrollments().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e2.code).toBe('CLIENT_BAD_RESPONSE');
    // 顶层非数组
    stubFetch([jsonResponse(200, { rows: [MINE_ROW] })]);
    const e3 = (await fetchMyEnrollments().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e3.code).toBe('CLIENT_BAD_RESPONSE');
  });
});
