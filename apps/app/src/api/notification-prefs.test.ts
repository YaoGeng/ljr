import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import { __resetClientForTest, setAccessToken } from './client';
import { fetchNotificationPrefs, mergePrefRows, putNotificationPrefs } from './notification-prefs';
import { jsonResponse, stubFetch } from './test-helpers';

/** core NotificationPref 实文样例（camelCase 键） */
const PREF_ROW = {
  templateCode: 'SESSION_REMIND',
  enabled: true,
  updatedAt: '2026-10-21T08:00:00.000Z',
};

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('I1 通知偏好 API（GET/PUT /notification-prefs，T4）', () => {
  it('GET：行形状校验通过（camelCase 键/布尔/时刻），auth 注入', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([jsonResponse(200, [PREF_ROW])]);
    const rows = await fetchNotificationPrefs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.templateCode).toBe('SESSION_REMIND');
    expect(rows[0]?.enabled).toBe(true);
    expect(seen[0]?.url).toBe('http://core.test/notification-prefs');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; method: string };
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-u');
  });

  it('GET 形状非法（enabled 字符串/非数组）→ CLIENT_BAD_RESPONSE', async () => {
    setAccessToken('jwt-u');
    stubFetch([jsonResponse(200, [{ ...PREF_ROW, enabled: 'yes' }])]);
    const e1 = (await fetchNotificationPrefs().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e1.code).toBe('CLIENT_BAD_RESPONSE');
    stubFetch([jsonResponse(200, { prefs: [PREF_ROW] })]);
    const e2 = (await fetchNotificationPrefs().then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e2.code).toBe('CLIENT_BAD_RESPONSE');
  });

  it('PUT：体形 {prefs:[{template_code,enabled}]}（snake_case 逐字）+ method PUT + 回读解析', async () => {
    setAccessToken('jwt-u');
    const seen = stubFetch([jsonResponse(200, [{ ...PREF_ROW, enabled: false }])]);
    const rows = await putNotificationPrefs([{ template_code: 'SESSION_REMIND', enabled: false }]);
    expect(rows[0]?.enabled).toBe(false);
    expect(seen[0]?.url).toBe('http://core.test/notification-prefs');
    const init = seen[0]?.init as RequestInit & {
      headers: Record<string, string>;
      method: string;
      body?: string;
    };
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer jwt-u');
    expect(JSON.parse(String(init.body))).toEqual({
      prefs: [{ template_code: 'SESSION_REMIND', enabled: false }],
    });
  });

  it('PUT 本地拒绝（空 code/非布尔 enabled）→ CLIENT_BAD_REQUEST，请求未发出', async () => {
    const seen = stubFetch([]);
    const e1 = (await putNotificationPrefs([{ template_code: '', enabled: true }]).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e1.code).toBe('CLIENT_BAD_REQUEST');
    const e2 = (await putNotificationPrefs([
      // 故意非法形态（enabled 非布尔）——运行时拒绝路径；类型断言仅为通过编译期检查
      { template_code: 'X', enabled: 1 as unknown as boolean },
    ]).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string };
    expect(e2.code).toBe('CLIENT_BAD_REQUEST');
    expect(seen).toHaveLength(0);
  });

  it('PUT 404 E_NOT_FOUND（模板不在册）→ AppApiError 携码 + 映射文案', async () => {
    setAccessToken('jwt-u');
    stubFetch([jsonResponse(404, { code: ErrorCode.NotFound, message: '模板不存在' })]);
    const err = (await putNotificationPrefs([{ template_code: 'GHOST', enabled: false }]).then(
      () => null,
      (e: unknown) => e,
    )) as { code: string; message: string };
    expect(err.code).toBe('E_NOT_FOUND');
    expect(err.message).toBe('请求的内容不存在');
  });

  it('mergePrefRows：偏好行权威态优先，收件箱 code 补充（默认投递），按 code 排序', () => {
    const rows = mergePrefRows(
      [
        { templateCode: 'SESSION_REMIND', enabled: false },
        { templateCode: 'PRICE_DOWN_COMP', enabled: true },
      ],
      ['PRICE_UP_LOCKED', 'SESSION_REMIND'],
    );
    expect(rows.map((r) => r.code)).toEqual([
      'PRICE_DOWN_COMP',
      'PRICE_UP_LOCKED',
      'SESSION_REMIND',
    ]);
    expect(rows[2]).toEqual({ code: 'SESSION_REMIND', enabled: false, fromPrefRow: true });
    expect(rows[1]).toEqual({ code: 'PRICE_UP_LOCKED', enabled: true, fromPrefRow: false });
    expect(mergePrefRows([], [])).toEqual([]);
  });
});
