import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError, setAccessToken, __resetClientForTest } from './client';
import { setApiBaseUrl } from './config';
import {
  fetchGroupBuys,
  filterInitiatedBy,
  publishGroupBuy,
  validatePublishInput,
  type GroupBuyView,
} from './group-buys';
import { jsonResponse, stubFetch } from './test-helpers';

/** C2 出参实文样例（PublishGroupBuyResult：{group_buy, share_price, payment_order 最小集}） */
const OK_BODY = {
  group_buy: {
    id: 21,
    initiator_id: 7,
    lawyer_id: 1,
    specialty: 'labor_arbitration',
    city: '北京',
    slot_start: '2026-12-18T12:00:00.000Z',
    sub_min: 2,
    sub_max: 3,
    share_price: '60.00',
    question_tags: ['加班费'],
    deadline: '2026-12-17T12:00:00.000Z',
    status: 'PUBLISHED',
    lawyer_confirm_by: null,
    created_at: '2026-10-21T10:00:00.000Z',
    joined: null,
  },
  share_price: '60.00',
  payment_order: {
    id: 9002,
    // biz_type 锚 core 实文 'enroll'（services/core/src/modules/trade/group-buy.service.ts:544
    // 发起人支付单同报名通道 createOrderInTx；原夹具 'groupbuy_publish' 为臆造值——T6 评审 S8）
    biz_type: 'enroll',
    biz_id: 21,
    cash_amount: '60.00',
    total: '60.00',
    status: 'CREATED',
  },
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('C2 发起拼团 API（POST /group-buys 载荷/形状/错误码）', () => {
  it('正常链：三键形状校验 + 请求体逐字段（deadline 可选缺省不发送）', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([jsonResponse(201, OK_BODY)]);
    const r = await publishGroupBuy({
      lawyer_id: 1,
      specialty: 'labor_arbitration',
      slot_start: '2026-12-18T20:00:00+08:00',
      sub_min: 2,
      sub_max: 3,
      question_tags: ['加班费'],
    });
    expect(r.group_buy.status).toBe('PUBLISHED');
    expect(r.share_price).toBe('60.00');
    expect(r.payment_order.id).toBe(9002);
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; body?: string };
    expect(init.headers.Authorization).toBe('Bearer jwt-u');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      lawyer_id: 1,
      specialty: 'labor_arbitration',
      slot_start: '2026-12-18T20:00:00+08:00',
      sub_min: 2,
      sub_max: 3,
      question_tags: ['加班费'],
    });
  });

  it('deadline 显式携带时随请求发送', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([jsonResponse(201, OK_BODY)]);
    await publishGroupBuy({
      lawyer_id: 1,
      specialty: 'labor_arbitration',
      slot_start: '2026-12-18T20:00:00+08:00',
      sub_min: 2,
      sub_max: 3,
      question_tags: [],
      deadline: '2026-12-17T20:00:00+08:00',
    });
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body['deadline']).toBe('2026-12-17T20:00:00+08:00');
  });

  it('409 E_SLOT_TAKEN / E_GROUP_BUY_DUP_KEY、400 E_OUT_OF_RANGE / E_ACCEPT_RANGE_UNSET → 映射文案', async () => {
    setAccessToken('jwt-u');
    const input = {
      lawyer_id: 1,
      specialty: 'labor_arbitration',
      slot_start: '2026-12-18T20:00:00+08:00',
      sub_min: 2,
      sub_max: 3,
      question_tags: [],
    };
    for (const [code, expected] of [
      // M3-W2 T3：E_SLOT_TAKEN/E_OUT_OF_RANGE 为 C2 用户发团与 C1 律师开团/B3 价格共用码
      // ——文案改双语境中性形（error-messages 表更新，此处同步钉新文案）
      [ErrorCode.SlotTaken, '该咨询时段已被占用（时段占用锁生效中），请更换时间'],
      [ErrorCode.GroupBuyDuplicateKey, '同一时段已有进行中的拼团，请勿重复发起'],
      [ErrorCode.PriceOutOfRange, '超出允许的范围（人数/价格区间），请调整后重试'],
      [ErrorCode.AcceptRangeUnset, '该律师尚未配置拼团接受人数范围，暂不可对其发起拼团'],
    ] as const) {
      stubFetch([
        jsonResponse(
          code === ErrorCode.SlotTaken || code === ErrorCode.GroupBuyDuplicateKey ? 409 : 400,
          { code, message: '原文' },
        ),
      ]);
      const err = (await publishGroupBuy(input).then(
        () => null,
        (e: unknown) => e,
      )) as { code: string; message: string };
      expect(isAppApiError(err)).toBe(true);
      expect(err.code).toBe(code);
      expect(err.message).toBe(expected);
    }
  });

  it('本地前置校验（core 值域镜像）：非法时刻/人数域/标签域 → CLIENT_BAD_REQUEST 不发请求', () => {
    const seen = stubFetch([]);
    const base = {
      lawyer_id: 1,
      specialty: 'labor_arbitration',
      slot_start: '2026-12-18T20:00:00+08:00',
      question_tags: ['加班费'],
    };
    expect(() => validatePublishInput({ ...base, sub_min: 1, sub_max: 3 })).toThrow();
    expect(() => validatePublishInput({ ...base, sub_min: 3, sub_max: 2 })).toThrow();
    expect(() => validatePublishInput({ ...base, sub_min: 2, sub_max: 51 })).toThrow();
    expect(() =>
      validatePublishInput({ ...base, sub_min: 2, sub_max: 3, slot_start: 'not-a-date' }),
    ).toThrow();
    expect(() =>
      validatePublishInput({ ...base, sub_min: 2, sub_max: 3, question_tags: ['x'.repeat(65)] }),
    ).toThrow();
    expect(() =>
      validatePublishInput({
        ...base,
        sub_min: 2,
        sub_max: 3,
        question_tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
      }),
    ).toThrow();
    expect(seen).toHaveLength(0);
  });

  it('形状非法（group_buy.share_price 数字）→ CLIENT_BAD_RESPONSE', async () => {
    stubFetch([
      jsonResponse(201, { ...OK_BODY, group_buy: { ...OK_BODY.group_buy, share_price: 60 } }),
    ]);
    const err = (await publishGroupBuy({
      lawyer_id: 1,
      specialty: 'labor_arbitration',
      slot_start: '2026-12-18T20:00:00+08:00',
      sub_min: 2,
      sub_max: 3,
      question_tags: [],
    }).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });
});

describe('C2 拼团公开列表（GET /group-buys + 发起人过滤，T4）', () => {
  const LIST_BODY = [
    OK_BODY.group_buy,
    { ...OK_BODY.group_buy, id: 22, initiator_id: 12, share_price: '80.00' },
  ];

  it('列表解析通过（GroupBuyView 逐键）+ specialty 查询串 + 无 auth 头（公开面）', async () => {
    const seen = stubFetch([jsonResponse(200, LIST_BODY)]);
    const views = await fetchGroupBuys({ specialty: 'labor_arbitration' });
    expect(views).toHaveLength(2);
    expect(views[0]?.initiator_id).toBe(7);
    expect(views[1]?.share_price).toBe('80.00');
    expect(seen[0]?.url).toBe('http://core.test/group-buys?specialty=labor_arbitration');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; method: string };
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('无过滤键时 URL 裸路径（不带空查询串）', async () => {
    const seen = stubFetch([jsonResponse(200, [])]);
    await fetchGroupBuys();
    expect(seen[0]?.url).toBe('http://core.test/group-buys');
  });

  it('形状非法（initiator_id 数字 0）→ CLIENT_BAD_RESPONSE', async () => {
    stubFetch([jsonResponse(200, [{ ...OK_BODY.group_buy, initiator_id: 0 }])]);
    const err = (await fetchGroupBuys().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('filterInitiatedBy：「我发起的团」客户端过滤 + 非法 userId 返回空', () => {
    // OK_BODY 为非类型化样例常量（status 宽化为 string）——按 GroupBuyView 收窄（值即 PUBLISHED）
    const views: GroupBuyView[] = [
      { ...OK_BODY.group_buy, id: 21, initiator_id: 7 } as GroupBuyView,
      { ...OK_BODY.group_buy, id: 22, initiator_id: 12 } as GroupBuyView,
    ];
    expect(filterInitiatedBy(views, 7).map((g) => g.id)).toEqual([21]);
    expect(filterInitiatedBy(views, 12).map((g) => g.id)).toEqual([22]);
    expect(filterInitiatedBy(views, 99)).toEqual([]);
    expect(filterInitiatedBy(views, 0)).toEqual([]); // 非法 id 不放行
  });
});
