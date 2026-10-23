import { describe, expect, it } from 'bun:test';
import {
  AdminClientErrorCode,
  AdminApiError,
  apiFetch,
  isAdminApiError,
  setAccessToken,
  setOnUnauthorized,
  __resetClientForTest,
} from './client';

/** fetch 桩：按调用序回放预设响应；记录请求供断言（app client.test.ts 同形态） */
function stubFetch(plays: Array<Response | Error>): Array<{ url: string; init: RequestInit }> {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? ({} as RequestInit) });
    const next = plays[i++];
    if (i > plays.length) throw new Error('意外的额外请求');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return seen;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin API client（M3-W3 T1）', () => {
  it('表内服务端码 → AdminApiError 携带 code/httpStatus + 映射表文案（403 E_ROLE_FORBIDDEN）', async () => {
    __resetClientForTest();
    stubFetch([
      jsonResponse(403, { code: 'E_ROLE_FORBIDDEN', message: '该接口要求运营（admin）角色' }),
    ]);
    const err = (await apiFetch('/admin/dashboard/metrics', { auth: true }).then(
      () => null,
      (e: unknown) => e,
    )) as AdminApiError;
    expect(isAdminApiError(err)).toBe(true);
    expect(err.code).toBe('E_ROLE_FORBIDDEN');
    expect(err.httpStatus).toBe(403);
    expect(err.message).toBe('该操作要求运营（admin）权限');
    expect(err.serverMessage).toBe('该接口要求运营（admin）角色');
  });

  it('表外服务端码 → 回退服务端 message（不吞错不造码）；空错误体 → CLIENT_BAD_RESPONSE', async () => {
    __resetClientForTest();
    stubFetch([jsonResponse(409, { code: 'E_SOMETHING_NEW', message: '新业务码原文' })]);
    const err = (await apiFetch('/x').then(
      () => null,
      (e: unknown) => e,
    )) as AdminApiError;
    expect(err.code).toBe('E_SOMETHING_NEW');
    expect(err.message).toBe('新业务码原文');

    stubFetch([new Response('no-json', { status: 500 })]);
    const err2 = (await apiFetch('/y').then(
      () => null,
      (e: unknown) => e,
    )) as AdminApiError;
    expect(err2.code).toBe(AdminClientErrorCode.BadResponseBody);
  });

  it('错误体 code 非字符串 → CLIENT_BAD_RESPONSE + 固定文案（与成功体非 JSON 路径同口径，NIT-1）', async () => {
    __resetClientForTest();
    // JSON 错误体但无字符串 code：不走服务端 message 回退（形状错≠服务端语义）
    stubFetch([jsonResponse(502, { message: 'oops' })]);
    const err = (await apiFetch('/x').then(
      () => null,
      (e: unknown) => e,
    )) as AdminApiError;
    expect(err.code).toBe(AdminClientErrorCode.BadResponseBody);
    expect(err.httpStatus).toBe(502);
    expect(err.message).toBe('服务响应异常，请稍后重试');
    expect(err.serverMessage).toBeUndefined();
  });

  it('Bearer token 注入 + 网络层失败 → CLIENT_NETWORK 本地码', async () => {
    __resetClientForTest();
    setAccessToken('jwt-admin');
    const seen = stubFetch([new Error('ECONNREFUSED')]);
    const err = (await apiFetch('/admin/dashboard/metrics', { auth: true }).then(
      () => null,
      (e: unknown) => e,
    )) as AdminApiError;
    expect(err.code).toBe(AdminClientErrorCode.NetworkUnreachable);
    expect(err.message).toBe('网络连接失败，请检查网络后重试');
    expect(seen[0]?.url).toBe('/admin/dashboard/metrics'); // 同源相对路径（基址缺省空串）
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin');
  });

  it('2xx JSON 透传', async () => {
    __resetClientForTest();
    stubFetch([jsonResponse(200, { group: 'core', metrics: [] })]);
    expect(
      await apiFetch<{ group: string; metrics: unknown[] }>('/admin/dashboard/metrics'),
    ).toEqual({ group: 'core', metrics: [] });
  });

  it('401 统一拦截：受保护面（auth:true）触发 onUnauthorized；登录面 401 不触发', async () => {
    __resetClientForTest();
    let fired = 0;
    setOnUnauthorized(() => {
      fired += 1;
    });
    stubFetch([
      jsonResponse(401, { code: 'E_UNAUTHORIZED', message: '凭证无效或已过期' }),
      jsonResponse(401, { code: 'E_CODE_INVALID', message: '验证码无效或已过期' }),
    ]);
    // 受保护面：回调先于抛错（壳层清会话回登录）
    const err = (await apiFetch('/admin/dashboard/metrics', { auth: true }).then(
      () => null,
      (e: unknown) => e,
    )) as AdminApiError;
    expect(err.httpStatus).toBe(401);
    expect(fired).toBe(1);
    // 登录面（auth:false）：错码 401 就地内联展示，不触发会话拦截
    const loginErr = (await apiFetch('/auth/verify', { method: 'POST', body: {} }).then(
      () => null,
      (e: unknown) => e,
    )) as AdminApiError;
    expect(loginErr.httpStatus).toBe(401);
    expect(fired).toBe(1);
    setOnUnauthorized(null);
  });
});
