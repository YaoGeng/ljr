import { beforeEach, describe, expect, it } from 'bun:test';
import { setApiBaseUrl } from './config';
import { __resetClientForTest, setAccessToken } from './client';
import { fetchMyNotifications } from './notifications';
import { jsonResponse, stubFetch } from './test-helpers';

/** core InboxItem 实文样例（camelCase 键；listInbox 恒 INBOX/SENT） */
const ITEM = {
  id: 101,
  templateCode: 'SESSION_REMIND',
  channel: 'INBOX',
  status: 'SENT',
  params: {
    session_id: 10,
    kind: 'REMIND_24H',
    slot_start: '2026-11-20T12:00:00.000Z',
    kind_label: '24 小时前',
  },
  sentAt: '2026-11-19T12:00:05.000Z',
  createdAt: '2026-11-19T12:00:00.000Z',
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('I1 通知 API（GET /notifications/mine，T4）', () => {
  it('正常链：行形状校验通过（camelCase 键/params 对象/可空 sentAt），auth 注入', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([
      jsonResponse(200, [ITEM, { ...ITEM, id: 102, sentAt: null, params: {} }]),
    ]);
    const rows = await fetchMyNotifications();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.templateCode).toBe('SESSION_REMIND');
    expect(rows[0]?.params['kind_label']).toBe('24 小时前');
    expect(rows[1]?.sentAt).toBeNull();
    expect(seen[0]?.url).toBe('http://core.test/notifications/mine');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; method: string };
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-u');
  });

  it('形状非法（params 数组 / sentAt 非时刻 / 非数组体）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-u');
    stubFetch([jsonResponse(200, [{ ...ITEM, params: ['a'] }])]);
    const e1 = (await fetchMyNotifications().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e1.code).toBe('CLIENT_BAD_RESPONSE');
    stubFetch([jsonResponse(200, [{ ...ITEM, sentAt: 'yesterday' }])]);
    const e2 = (await fetchMyNotifications().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e2.code).toBe('CLIENT_BAD_RESPONSE');
    stubFetch([jsonResponse(200, { items: [ITEM] })]);
    const e3 = (await fetchMyNotifications().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e3.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('401 E_UNAUTHORIZED → AppApiError 携码（登录失效分诊链同源）', async () => {
    setAccessToken('jwt-u');
    stubFetch([jsonResponse(401, { code: 'E_UNAUTHORIZED', message: '未认证' })]);
    const err = (await fetchMyNotifications().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(err.code).toBe('E_UNAUTHORIZED');
    expect(err.message).toBe('登录已失效，请重新登录');
  });
});
