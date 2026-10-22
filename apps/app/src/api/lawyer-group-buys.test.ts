import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError, setAccessToken, __resetClientForTest } from './client';
import { setApiBaseUrl } from './config';
import {
  confirmGroupBuy,
  convertGroupBuy,
  fetchLawyerHallGroupBuys,
  formatConfirmWindow,
  rejectGroupBuy,
  type ConvertGroupBuyInput,
} from './lawyer-group-buys';
import { jsonResponse, stubFetch } from './test-helpers';

/** C4 接单大厅行实文样例（GroupBuyView：PENDING_LAWYER + joined=已支付参与者数真值） */
const PENDING_GB = {
  id: 31,
  initiator_id: 7,
  lawyer_id: 1,
  specialty: 'labor_arbitration',
  city: '北京',
  slot_start: '2026-12-19T12:00:00.000Z',
  sub_min: 2,
  sub_max: 4,
  share_price: '150.00',
  question_tags: ['加班费', '经济补偿金'],
  deadline: '2026-12-18T12:00:00.000Z',
  status: 'PENDING_LAWYER',
  lawyer_confirm_by: '2026-10-23T14:00:00.000Z',
  created_at: '2026-10-21T10:00:00.000Z',
  joined: 2,
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('C4 接单大厅（GET /lawyer/group-buys?status=PENDING_LAWYER）', () => {
  it('列表解析通过（joined 真值）+ 显式 status 查询串 + Bearer 注入（律师面）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(200, [PENDING_GB])]);
    const views = await fetchLawyerHallGroupBuys();
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe('PENDING_LAWYER');
    expect(views[0]?.joined).toBe(2);
    expect(views[0]?.lawyer_confirm_by).toBe('2026-10-23T14:00:00.000Z');
    expect(seen[0]?.url).toBe('http://core.test/lawyer/group-buys?status=PENDING_LAWYER');
    expect(seen[0]?.init.method).toBe('GET');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer jwt-lawyer');
  });

  it('形状非法（joined 缺键）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    // JSON 往返剔除 joined 键（replacer 置 undefined 即落键省略——模拟服务端缺键漂移）
    const noJoined = JSON.parse(
      JSON.stringify(PENDING_GB, (k, v) => (k === 'joined' ? undefined : v)),
    );
    stubFetch([jsonResponse(200, [noJoined])]);
    const err = (await fetchLawyerHallGroupBuys().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });
});

describe('C4 确认接单（POST /group-buys/:id/confirm）', () => {
  it('无请求体 POST → {session_id} 解析', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { session_id: 77 })]);
    const r = await confirmGroupBuy(31);
    expect(r.session_id).toBe(77);
    expect(seen[0]?.url).toBe('http://core.test/group-buys/31/confirm');
    expect(seen[0]?.init.method).toBe('POST');
    expect((seen[0]?.init as RequestInit & { body?: string }).body).toBeUndefined();
  });

  it('409 E_NOT_REACHED（未达待确认态）→ 映射文案', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(409, { code: ErrorCode.NotReached, message: '原文' })]);
    const err = (await confirmGroupBuy(31).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(isAppApiError(err)).toBe(true);
    expect(err.code).toBe(ErrorCode.NotReached);
    expect(err.message).toBe('该拼团未进入待确认状态（未成团或已被处理），请刷新列表');
  });

  it('本地前置校验：非正整数 id → CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const err = (await confirmGroupBuy(bad).then(
        () => null,
        (e: unknown) => e,
      )) as { code: string };
      expect(err.code).toBe('CLIENT_BAD_REQUEST');
    }
    expect(seen).toHaveLength(0);
  });

  it('出参形状非法（session_id=0）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(201, { session_id: 0 })]);
    const err = (await confirmGroupBuy(31).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe('CLIENT_BAD_RESPONSE');
  });
});

describe('C4 婉拒（POST /group-buys/:id/reject）', () => {
  it('无理由时请求体为空对象（core parseRejectBody 须收 JSON 对象）→ {status} 解析', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { status: 'REJECTED' })]);
    const r = await rejectGroupBuy(31);
    expect(r.status).toBe('REJECTED');
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({});
  });

  it('带理由时体={reason} 逐字', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { status: 'REJECTED' })]);
    await rejectGroupBuy(31, '档期冲突，建议改约下周');
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({ reason: '档期冲突，建议改约下周' });
  });

  it('409 E_NOT_PENDING → 映射文案', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(409, { code: ErrorCode.NotPending, message: '原文' })]);
    const err = (await rejectGroupBuy(31).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(err.code).toBe(ErrorCode.NotPending);
    expect(err.message).toBe('该拼团不在待确认状态（已被响应或已超窗），请刷新列表');
  });

  it('本地前置校验：空串/超长理由 → CLIENT_BAD_REQUEST（core ≤500 镜像）', async () => {
    const seen = stubFetch([]);
    for (const bad of ['', 'x'.repeat(501)]) {
      const err = (await rejectGroupBuy(31, bad).then(
        () => null,
        (e: unknown) => e,
      )) as { code: string };
      expect(err.code).toBe('CLIENT_BAD_REQUEST');
    }
    expect(seen).toHaveLength(0);
  });
});

describe('C4 认领转化（POST /group-buys/:id/convert）', () => {
  it('缺省入参：请求体为空对象（capacity 缺省=sub_max、价缺省=B3 现值在 core 解算）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { session_id: 81 })]);
    const r = await convertGroupBuy(31);
    expect(r.session_id).toBe(81);
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({});
  });

  it('capacity/price 覆盖逐字（两位小数金额字符串）', async () => {
    setAccessToken('jwt-lawyer');
    const seen = stubFetch([jsonResponse(201, { session_id: 82 })]);
    await convertGroupBuy(31, { capacity: 8, price: '120.00' });
    const body = JSON.parse(
      String((seen[0]?.init as RequestInit & { body?: string }).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({ capacity: 8, price: '120.00' });
  });

  it('409 E_NOT_CONVERTIBLE（如 CONFIRMED 后转化）→ 映射文案', async () => {
    setAccessToken('jwt-lawyer');
    stubFetch([jsonResponse(409, { code: ErrorCode.NotConvertible, message: '原文' })]);
    const err = (await convertGroupBuy(31).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(err.code).toBe(ErrorCode.NotConvertible);
    expect(err.message).toBe('该拼团当前状态不可认领转化（仅拼团中/已成团/待确认可转）');
  });

  it('本地前置校验：capacity 越人数域/price 非两位小数 → CLIENT_BAD_REQUEST 不发请求', async () => {
    const seen = stubFetch([]);
    // 运行时形态防御（price=number 等坏类型）——测试侧显式宽化注入，生产侧类型面已收窄
    const bads = [
      { capacity: 1 },
      { capacity: 51 },
      { capacity: 1.5 },
      { price: '12.3' },
      { price: 120 },
    ] as unknown as ConvertGroupBuyInput[];
    for (const bad of bads) {
      const err = (await convertGroupBuy(31, bad).then(
        () => null,
        (e: unknown) => e,
      )) as { code: string };
      expect(err.code).toBe('CLIENT_BAD_REQUEST');
    }
    expect(seen).toHaveLength(0);
  });
});

describe('12h 确认窗剩余展示（formatConfirmWindow 纯函数）', () => {
  const NOW = new Date('2026-10-23T08:00:00.000Z');

  it('5h03m → 剩余 5 小时 3 分（时+分两段）', () => {
    expect(formatConfirmWindow('2026-10-23T13:03:00.000Z', NOW)).toBe('剩余 5 小时 3 分');
  });

  it('59m59s → 剩余 60 分钟（向上取整到分，不显示 0 小时）', () => {
    expect(formatConfirmWindow('2026-10-23T08:59:59.000Z', NOW)).toBe('剩余 60 分钟');
  });

  it('整 2h → 剩余 2 小时 0 分', () => {
    expect(formatConfirmWindow('2026-10-23T10:00:00.000Z', NOW)).toBe('剩余 2 小时 0 分');
  });

  it('恰到期/已超窗 → 已超窗', () => {
    expect(formatConfirmWindow('2026-10-23T08:00:00.000Z', NOW)).toBe('已超窗');
    expect(formatConfirmWindow('2026-10-23T07:00:00.000Z', NOW)).toBe('已超窗');
  });
});
