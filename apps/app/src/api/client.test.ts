import { describe, expect, it, beforeEach } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import {
  AppApiError,
  apiFetch,
  AppClientErrorCode,
  isAppApiError,
  setAccessToken,
  __resetClientForTest,
} from './client';

/** fetch 桩：按调用序回放预设响应；记录请求供断言 */
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

beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl('http://core.test');
});

describe('api client 错误码映射（A1 契约 {code,message}）', () => {
  it('表内服务端码 → AppApiError 携带 code + 映射表文案（429 E_RATE_LIMITED）', async () => {
    stubFetch([
      jsonResponse(429, {
        code: ErrorCode.RateLimited,
        message: '验证码发送过于频繁（60s 窗口限频）',
      }),
    ]);
    const promise = apiFetch('/auth/sms', { method: 'POST', body: { phone: '13800000000' } });
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(isAppApiError(err)).toBe(true);
    const apiErr = err as AppApiError;
    expect(apiErr.code).toBe('E_RATE_LIMITED');
    expect(apiErr.httpStatus).toBe(429);
    // 文案走映射表（表内码优先于服务端原文；T3 改中性形——A1 短信限频与 B2 发团滥用限频共用码）
    expect(apiErr.message).toBe('操作过于频繁，请稍后再试');
    expect(apiErr.serverMessage).toBe('验证码发送过于频繁（60s 窗口限频）');
  });

  it('表外服务端码 → 回退服务端 message（不吞错不造码）', async () => {
    stubFetch([jsonResponse(409, { code: 'E_SOMETHING_NEW', message: '新业务码原文' })]);
    const err = (await apiFetch('/x').then(
      () => null,
      (e: unknown) => e,
    )) as AppApiError;
    expect(err.code).toBe('E_SOMETHING_NEW');
    expect(err.message).toBe('新业务码原文');
  });

  it('网络层失败 → CLIENT_NETWORK 本地码 + 基址拼接 + token 注入', async () => {
    const seen = stubFetch([new Error('ECONNREFUSED')]);
    setAccessToken('jwt-abc');
    const err = (await apiFetch('/me', { auth: true }).then(
      () => null,
      (e: unknown) => e,
    )) as AppApiError;
    expect(err.code).toBe(AppClientErrorCode.NetworkUnreachable);
    expect(err.message).toBe('网络连接失败，请检查网络后重试');
    expect(seen[0]?.url).toBe('http://core.test/me');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-abc');
  });

  it('2xx JSON 正常透传；非 JSON 成功体 → CLIENT_BAD_RESPONSE', async () => {
    stubFetch([jsonResponse(200, { ttl: 60 })]);
    expect(await apiFetch<{ ttl: number }>('/auth/sms')).toEqual({ ttl: 60 });
    stubFetch([new Response('<html>', { status: 200 })]);
    const err = (await apiFetch('/x').then(
      () => null,
      (e: unknown) => e,
    )) as AppApiError;
    expect(err.code).toBe(AppClientErrorCode.BadResponseBody);
  });

  it('主路径超时：fetch 挂起被 abort → reject CLIENT_NETWORK（T6 评审 I1）', async () => {
    // 假 fetch：挂起直到 signal abort 才 reject（模拟真 fetch 的 AbortError 形态）
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error('测试桩缺 signal（apiFetch 必须传 AbortController）');
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error('AbortError'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      });
    }) as typeof fetch;
    // 压缩时钟：15s 兜底缩为 5ms（只改 delay，回调与 clearTimeout 原样），断言后恢复
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    globalThis.setTimeout = ((handler: TimerHandler, ..._rest: unknown[]) =>
      realSetTimeout(handler, 5)) as typeof setTimeout;
    try {
      const err = (await apiFetch('/slow').then(
        () => null,
        (e: unknown) => e,
      )) as AppApiError;
      expect(isAppApiError(err)).toBe(true);
      expect(err.code).toBe(AppClientErrorCode.NetworkUnreachable);
      expect(err.message).toBe('网络连接失败，请检查网络后重试');
    } finally {
      globalThis.setTimeout = realSetTimeout as typeof setTimeout;
    }
  });
});
