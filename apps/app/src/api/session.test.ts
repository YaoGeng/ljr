import { describe, expect, it, beforeEach } from 'bun:test';
import { ErrorCode } from '@ljr/shared';
import { setApiBaseUrl } from './config';
import { __resetClientForTest } from './client';
import {
  __resetSessionForTest,
  fetchMeWithRefresh,
  getSessionSnapshot,
  logout,
  requestSmsCode,
  verifyAndLogin,
} from './session';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** fetch 桩：handler 按调用返回 Response（正常）或抛 Error（网络层），记录全部调用 */
function stubFetch(handler: (call: number, c: RecordedCall) => Response | Error): RecordedCall[] {
  const seen: RecordedCall[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? ({} as RequestInit) };
    seen.push(call);
    const res = handler(i, call);
    i += 1;
    if (res instanceof Response) return res;
    throw res;
  }) as typeof fetch;
  return seen;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ME = { id: 7, roles: ['user'], status: 'ACTIVE', phone_masked: '138****6688' };

beforeEach(() => {
  __resetClientForTest();
  __resetSessionForTest();
  setApiBaseUrl('http://core.test');
});

describe('会话态流转（A1：sms → verify → /me → logout）', () => {
  it('发码 → 校验 → 存 token → /me 携带 Bearer → authenticated 快照', async () => {
    const seen = stubFetch((call) => {
      if (call === 0) return jsonResponse(200, { ttl: 60 });
      if (call === 1)
        return jsonResponse(200, {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          roles: ['user'],
        });
      return jsonResponse(200, ME);
    });

    expect(await requestSmsCode('13800000000')).toEqual({ ttl: 60 });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ phone: '13800000000' });

    const me = await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true });
    expect(me.phone_masked).toBe('138****6688');
    // verify 体：勾选才带 age_declared
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      phone: '13800000000',
      code: '123456',
      age_declared: true,
    });
    // /me 注入 verify 签发的 token
    const meHeaders = seen[2]?.init.headers as Record<string, string>;
    expect(meHeaders.Authorization).toBe('Bearer at-1');
    expect(getSessionSnapshot()).toEqual({ status: 'authenticated', me: ME });
  });

  it('未勾年龄声明 → 不带 age_declared 字段（R-W2-C 契约：可选键不发送）', async () => {
    const seen = stubFetch(() =>
      jsonResponse(400, { code: ErrorCode.AgeDeclarationRequired, message: '须先勾选' }),
    );
    await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: false }).catch(
      () => null,
    );
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      phone: '13800000000',
      code: '123456',
    });
    expect(getSessionSnapshot().status).toBe('anonymous');
  });

  it('verify 成功但 /me 失败 → 回匿名态（不滞留半登录态）', async () => {
    stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', roles: ['user'] });
      return jsonResponse(500, { code: ErrorCode.InternalError, message: '内部错误' });
    });
    let thrown = false;
    await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true }).catch(() => {
      thrown = true;
    });
    expect(thrown).toBe(true);
    expect(getSessionSnapshot()).toEqual({ status: 'anonymous', me: null });
  });

  it('logout：本地先清态 + 服务端吊销 refresh（幂等面网络失败不阻塞）', async () => {
    const seen = stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, { access_token: 'at-3', refresh_token: 'rt-3', roles: ['user'] });
      if (call === 1) return jsonResponse(200, ME);
      if (call === 2) return jsonResponse(200, { ok: true, revoked: true });
      return new Error('不应有第 4 个请求');
    });
    await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true });
    await logout();
    expect(getSessionSnapshot()).toEqual({ status: 'anonymous', me: null });
    // 第 3 个请求 = POST /auth/logout 且带 refresh_token
    expect(seen[2]?.url.endsWith('/auth/logout')).toBe(true);
    expect(JSON.parse(String(seen[2]?.init.body))).toEqual({ refresh_token: 'rt-3' });
    // 再 logout（已清态）不应再发请求
    await logout();
    expect(seen.length).toBe(3);
  });

  it('verify 后 /me 遇 401 → 单飞 refresh 换新 token 重试成功（不回匿名态）', async () => {
    const seen = stubFetch((call, c) => {
      if (call === 0)
        return jsonResponse(200, {
          access_token: 'at-old',
          refresh_token: 'rt-4',
          roles: ['user'],
        });
      if (call === 1) return jsonResponse(401, { code: ErrorCode.Unauthorized, message: '未认证' });
      if (call === 2) return jsonResponse(200, { access_token: 'at-new' });
      const headers = c.init.headers as Record<string, string>;
      return headers.Authorization === 'Bearer at-new'
        ? jsonResponse(200, ME)
        : jsonResponse(401, { code: ErrorCode.Unauthorized, message: '未认证' });
    });
    const me = await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true });
    expect(me.id).toBe(7);
    expect(seen[2]?.url.endsWith('/auth/refresh')).toBe(true);
    expect(JSON.parse(String(seen[2]?.init.body))).toEqual({ refresh_token: 'rt-4' });
    expect(getSessionSnapshot().status).toBe('authenticated');
  });

  it('已登录态 /me 401 且 refresh 网络故障 → 保留会话（照抛原 401，不误清 token）', async () => {
    const seen = stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, { access_token: 'at-5', refresh_token: 'rt-5', roles: ['user'] });
      if (call === 1) return jsonResponse(200, ME); // verify 完成 → authenticated
      if (call === 2) return jsonResponse(401, { code: ErrorCode.Unauthorized, message: '未认证' });
      if (call === 3) return new Error('ECONNRESET'); // /auth/refresh 网络层瞬断
      throw new Error('不应有更多请求');
    });
    await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true });
    expect(getSessionSnapshot().status).toBe('authenticated');

    // 已登录态再拉 /me：401 → refresh 网络故障 → 照抛原 401，会话仍在（评审 I2）
    let thrown: unknown = null;
    try {
      await fetchMeWithRefresh();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as { code?: string }).code).toBe(ErrorCode.Unauthorized);
    expect(getSessionSnapshot()).toEqual({ status: 'authenticated', me: ME });
    expect(seen[3]?.url.endsWith('/auth/refresh')).toBe(true);
  });

  it('refresh 契约性失效（E_REFRESH_EXPIRED）→ 才清会话', async () => {
    stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, { access_token: 'at-6', refresh_token: 'rt-6', roles: ['user'] });
      if (call === 1) return jsonResponse(200, ME);
      if (call === 2) return jsonResponse(401, { code: ErrorCode.Unauthorized, message: '未认证' });
      if (call === 3)
        return jsonResponse(401, { code: ErrorCode.RefreshExpired, message: '登录已失效' });
      throw new Error('不应有更多请求');
    });
    await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true });
    await fetchMeWithRefresh().catch(() => null);
    expect(getSessionSnapshot()).toEqual({ status: 'anonymous', me: null });
  });

  it('两路并发 /me 双 401 → 单飞去重：/auth/refresh 恰发一次（T6 评审 S10）', async () => {
    let phase: 'login' | 'race' = 'login'; // login 期 at-old 的 /me 放行；race 期一律 401 逼出刷新
    let refreshCalls = 0;
    const seen = stubFetch((_call, c) => {
      if (c.url.endsWith('/auth/verify')) {
        return jsonResponse(200, {
          access_token: 'at-old',
          refresh_token: 'rt-8',
          roles: ['user'],
        });
      }
      if (c.url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return jsonResponse(200, { access_token: 'at-new' });
      }
      // /me：新 token 恒放行；旧 token 按 phase 分诊
      const headers = c.init.headers as Record<string, string>;
      if (headers.Authorization === 'Bearer at-old') {
        return phase === 'login'
          ? jsonResponse(200, ME)
          : jsonResponse(401, { code: ErrorCode.Unauthorized, message: '未认证' });
      }
      return jsonResponse(200, ME);
    });
    await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true });
    expect(refreshCalls).toBe(0); // 登录链自身无刷新

    phase = 'race';
    const [meA, meB] = await Promise.all([fetchMeWithRefresh(), fetchMeWithRefresh()]);
    expect(meA.id).toBe(7);
    expect(meB.id).toBe(7);
    // 单飞断言（锁 refreshInFlight 去重）：两路 401 只发一次 /auth/refresh
    expect(refreshCalls).toBe(1);
    expect(seen.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(getSessionSnapshot().status).toBe('authenticated');
  });
});
