import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import { AppClientErrorCode, __resetClientForTest, setAccessToken } from './client';
import {
  createSession,
  SESSION_CAPACITY_MAX,
  SESSION_CAPACITY_MIN,
  splitTotalPerHead,
  validateCreateSessionInput,
  type CreateSessionInput,
} from './lawyer-sessions';
import { jsonResponse, stubFetch } from './test-helpers';

const SESSION_VIEW = {
  id: 2045,
  lawyer_id: 1,
  mode: 'B2C',
  specialty: 'labor_arbitration',
  city: '北京',
  slot_start: '2027-03-19T11:30:00.000Z',
  price_mode: 'per_head',
  unit_price: '99.00',
  session_total: '495.00',
  capacity: 5,
  joined: 0,
  enroll_deadline: '2027-03-18T11:30:00.000Z',
  room_mode: 'text',
  status: 'CREATED',
  created_at: '2026-10-23T08:00:00.000Z',
};

const BASE_INPUT: CreateSessionInput = {
  slot_start: '2027-03-19T11:30:00.000Z',
  price_mode: 'per_head',
  unit_price: '99.00',
  capacity: 5,
  room_mode: 'text',
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('POST /sessions（C1 §5 七键——lawyer_id 取 JWT 不入 body）', () => {
  it('Bearer 注入 + 体形状逐键；可选键缺省不出现在 JSON；出参 {session} 解包', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, { session: SESSION_VIEW })]);
    const s = await createSession(BASE_INPUT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer lawyer-token');
    expect(seen[0]?.url).toBe('http://core.test/sessions');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      slot_start: '2027-03-19T11:30:00.000Z',
      price_mode: 'per_head',
      unit_price: '99.00',
      capacity: 5,
      room_mode: 'text',
    }); // enroll_deadline 缺省=不传（core 补 slot_start-24h）
    expect(s.id).toBe(2045);
    expect(s.unit_price).toBe('99.00');
    expect(s.status).toBe('CREATED');
  });

  it('enroll_deadline 显式传入时进体；unit_price 缺省=不传（core 取 B3 默认价）', async () => {
    setAccessToken('lawyer-token');
    const seen = stubFetch([jsonResponse(200, { session: SESSION_VIEW })]);
    await createSession({
      slot_start: '2027-03-19T11:30:00.000Z',
      price_mode: 'session_total',
      capacity: 6,
      enroll_deadline: '2027-03-18T02:00:00.000Z',
      room_mode: 'voice',
    });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      slot_start: '2027-03-19T11:30:00.000Z',
      price_mode: 'session_total',
      capacity: 6,
      enroll_deadline: '2027-03-18T02:00:00.000Z',
      room_mode: 'voice',
    });
  });

  it('出参 session 形状非法（缺 status/金额非两位小数）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('lawyer-token');
    stubFetch([jsonResponse(200, { session: { ...SESSION_VIEW, status: 1 } })]);
    let err: unknown = null;
    await createSession(BASE_INPUT).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);

    stubFetch([jsonResponse(200, { session: { ...SESSION_VIEW, unit_price: '99.0' } })]);
    err = null;
    await createSession(BASE_INPUT).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });

  it('错误态映射：409 E_SLOT_TAKEN（B2 锁）/409 E_SESSION_DUP_KEY/403 E_RESTRICTED/429/400 截止无效', async () => {
    setAccessToken('lawyer-token');
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [409, ErrorCode.SlotTaken, '该咨询时段已被占用（时段占用锁生效中），请更换时间'],
      [409, ErrorCode.SessionDuplicateKey, '该时段已有进行中的开团且配置不一致'],
      [403, ErrorCode.Restricted, '当前账号受平台限制令影响，暂不可开团'],
      [429, ErrorCode.RateLimited, '操作过于频繁，请稍后再试'],
      [400, ErrorCode.EnrollDeadlineInvalid, '临期场次须手动设置晚于当前且早于开始的报名截止'],
    ];
    for (const [status, code, copyContains] of cases) {
      stubFetch([jsonResponse(status, { code, message: `${code} server message` })]);
      let err: unknown = null;
      await createSession(BASE_INPUT).catch((e) => {
        err = e;
      });
      expect((err as { code?: string }).code).toBe(code);
      expect((err as { httpStatus?: number }).httpStatus).toBe(status);
      expect((err as Error).message).toContain(copyContains);
    }
  });
});

describe('validateCreateSessionInput（本地前置——core parseSessionBody/assert* 值域镜像）', () => {
  const expectReject = (input: CreateSessionInput): string => {
    try {
      validateCreateSessionInput(input);
    } catch (e) {
      return (e as { code: string }).code;
    }
    throw new Error('应当拒绝的入参被放行');
  };

  it('合法入参（七键全量/最简）均放行', () => {
    validateCreateSessionInput(BASE_INPUT);
    validateCreateSessionInput({
      slot_start: '2027-03-19T11:30:00.000Z',
      price_mode: 'session_total',
      capacity: 2,
      enroll_deadline: '2027-03-19T02:00:00.000Z',
      room_mode: 'video',
    });
  });

  it('price_mode/room_mode 越值域拒；capacity 域 2-50（R-03）外拒', () => {
    expect(expectReject({ ...BASE_INPUT, price_mode: 'head' as never })).toBe(
      AppClientErrorCode.BadRequest,
    );
    expect(expectReject({ ...BASE_INPUT, room_mode: 'chat' as never })).toBe(
      AppClientErrorCode.BadRequest,
    );
    expect(SESSION_CAPACITY_MIN).toBe(2);
    expect(SESSION_CAPACITY_MAX).toBe(50);
    expect(expectReject({ ...BASE_INPUT, capacity: 1 })).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject({ ...BASE_INPUT, capacity: 51 })).toBe(AppClientErrorCode.BadRequest);
    expect(expectReject({ ...BASE_INPUT, capacity: 4.5 })).toBe(AppClientErrorCode.BadRequest);
  });

  it('unit_price 非 Money 线格式（number/一位小数）拒', () => {
    expect(expectReject({ ...BASE_INPUT, unit_price: 99 as never })).toBe(
      AppClientErrorCode.BadRequest,
    );
    expect(expectReject({ ...BASE_INPUT, unit_price: '99.0' })).toBe(AppClientErrorCode.BadRequest);
  });

  it('unit_price 列宽按模式分档镜像 core assertColumnBounds（评审 N-1）：per_head=numeric(10,2)、session_total=numeric(12,2)', () => {
    // per_head 档：raw=每人单价 → unit_price 列 10,2（9 位整数拒、8 位收；
    // 单价×capacity ≤12,2 第二重在值域下数学不可达（max 9,999,999,999×50 < 999,999,999,999 分）——不镜像）
    expect(expectReject({ ...BASE_INPUT, unit_price: '123456789.00' })).toBe(
      AppClientErrorCode.BadRequest,
    );
    validateCreateSessionInput({ ...BASE_INPUT, unit_price: '12345678.00' });
    validateCreateSessionInput({ ...BASE_INPUT, unit_price: '99999999.99', capacity: 50 });
    // session_total 档：raw=场次总价 → session_total 列 12,2（10 位整数恰上限收、11 位拒）
    validateCreateSessionInput({
      ...BASE_INPUT,
      price_mode: 'session_total',
      unit_price: '9999999999.99',
    }); // numeric(12,2) 上限
    expect(
      expectReject({ ...BASE_INPUT, price_mode: 'session_total', unit_price: '10000000000.00' }),
    ).toBe(AppClientErrorCode.BadRequest);
    // 同一 9 位整数值在两档结论不同（per_head 拒 / session_total 收）——分档镜像钉住
    expect(expectReject({ ...BASE_INPUT, unit_price: '123456789.00' })).toBe(
      AppClientErrorCode.BadRequest,
    );
    validateCreateSessionInput({
      ...BASE_INPUT,
      price_mode: 'session_total',
      unit_price: '123456789.00',
    });
  });

  it('slot_start 非 ISO/过去时刻拒；enroll_deadline 非 ISO/不早于 slot_start 拒（Date 可解析性镜像 core assertIsoDatetime——空格分隔形态同 core 放行）', () => {
    expect(expectReject({ ...BASE_INPUT, slot_start: 'not-a-date' })).toBe(
      AppClientErrorCode.BadRequest,
    );
    expect(expectReject({ ...BASE_INPUT, slot_start: '2000-01-01T00:00:00.000Z' })).toBe(
      AppClientErrorCode.BadRequest,
    );
    expect(expectReject({ ...BASE_INPUT, enroll_deadline: '2027-03-19T11:30:00.000Z' })).toBe(
      AppClientErrorCode.BadRequest,
    ); // 截止==开始（须严格早于）
    expect(expectReject({ ...BASE_INPUT, enroll_deadline: '2027-03-20T11:30:00.000Z' })).toBe(
      AppClientErrorCode.BadRequest,
    ); // 截止晚于开始
  });
});

describe('splitTotalPerHead（session_total 模式人均分摊预览——core splitTotalIntoUnit 同口径）', () => {
  it('半分向上取整到分：100.00/3 → 33.33；1.01/2 → 0.51（0.5 分恰半向上）', () => {
    expect(splitTotalPerHead('100.00', 3)).toBe('33.33');
    expect(splitTotalPerHead('1.01', 2)).toBe('0.51');
  });

  it('整除无尾差：99.00/3 → 33.00；650.00/2 → 325.00', () => {
    expect(splitTotalPerHead('99.00', 3)).toBe('33.00');
    expect(splitTotalPerHead('650.00', 2)).toBe('325.00');
  });

  it('非法入参（非 Money/容量 0）→ 本地拒绝', () => {
    let err: unknown = null;
    try {
      splitTotalPerHead('99', 3);
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    err = null;
    try {
      splitTotalPerHead('99.00', 0);
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
  });
});
