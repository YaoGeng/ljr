import { describe, expect, it, beforeEach } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import { AppClientErrorCode, __resetClientForTest } from './client';
import { fetchSessionDetail, fetchSessions, type SessionView } from './sessions';

/** fetch 桩：固定应答（Response 或网络层 Error），返回记录到的请求 */
function stubFetch(respond: (url: string) => Response | Error): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const res = respond(u);
    if (res instanceof Response) return res;
    throw res;
  }) as typeof fetch;
  return urls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SESSION_ROW = {
  id: 9,
  lawyer_id: 4,
  mode: 'B2C',
  specialty: 'labor_arbitration',
  city: '北京',
  slot_start: '2026-11-06T12:00:00.000Z',
  price_mode: 'per_head',
  unit_price: '199.00',
  session_total: '995.00',
  capacity: 5,
  joined: 3,
  enroll_deadline: '2026-11-05T12:00:00.000Z',
  room_mode: 'text',
  status: 'CREATED',
  created_at: '2026-10-20T10:00:00.000Z',
} satisfies SessionView;

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('GET /sessions（C1 列表：裸数组出参 + 双维筛选参数）', () => {
  it('空筛选=裸路径；筛选键只带已定义项（specialty/city 编码进查询串）', async () => {
    let urls = stubFetch(() => jsonResponse(200, [SESSION_ROW]));
    const rows = await fetchSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unit_price).toBe('199.00');
    expect(urls[0]).toBe('http://core.test/sessions');

    urls = stubFetch(() => jsonResponse(200, []));
    await fetchSessions({ specialty: 'labor_arbitration', city: '北京', lawyer: 4 });
    expect(urls[0]).toContain('/sessions?');
    expect(urls[0]).toContain('specialty=labor_arbitration');
    expect(urls[0]).toContain(`city=${encodeURIComponent('北京')}`);
    expect(urls[0]).toContain('lawyer=4');

    urls = stubFetch(() => jsonResponse(200, []));
    await fetchSessions({ city: undefined });
    expect(urls[0]).toBe('http://core.test/sessions'); // undefined 键不出现在查询串
  });

  it('响应非数组 / 行形状非法 → CLIENT_BAD_RESPONSE（fail-visible，不静默吞错）', async () => {
    stubFetch(() => jsonResponse(200, { sessions: [SESSION_ROW] })); // 包键体=契约外形态
    let err: unknown = null;
    await fetchSessions().catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);

    stubFetch(() => jsonResponse(200, [{ ...SESSION_ROW, unit_price: 199 }])); // 金额 number=非法
    err = null;
    await fetchSessions().catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadResponseBody);
  });
});

describe('GET /sessions/:id（C1 详情+剩余席位）', () => {
  it('路径拼 id，出参含 remaining', async () => {
    const urls = stubFetch(() => jsonResponse(200, { ...SESSION_ROW, remaining: 2 }));
    const detail = await fetchSessionDetail(9);
    expect(detail.remaining).toBe(2);
    expect(detail.status).toBe('CREATED');
    expect(urls[0]).toBe('http://core.test/sessions/9');
  });

  it('404 → AppApiError（shared 码 + 映射文案，不另造错误形态）', async () => {
    stubFetch(() => jsonResponse(404, { code: ErrorCode.NotFound, message: '场次不存在：9' }));
    let err: unknown = null;
    await fetchSessionDetail(9).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(ErrorCode.NotFound);
    expect((err as { httpStatus?: number }).httpStatus).toBe(404);
    expect((err as Error).message).toBe('请求的内容不存在');
  });

  it('非正整数 id → 本地拒绝 CLIENT_BAD_REQUEST（评审 S6：与响应形状错 CLIENT_BAD_RESPONSE 分离）', async () => {
    const urls = stubFetch(() => jsonResponse(200, SESSION_ROW));
    let err: unknown = null;
    await fetchSessionDetail(0).catch((e) => {
      err = e;
    });
    expect((err as { code?: string }).code).toBe(AppClientErrorCode.BadRequest);
    expect((err as Error).message).toBe('请求参数有误，请返回重试');
    await expect(fetchSessionDetail(Number.NaN)).rejects.toThrow();
    expect(urls).toHaveLength(0);
  });
});
