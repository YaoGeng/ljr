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
  switchRole,
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
const ME_DUAL = { id: 7, roles: ['user', 'lawyer'], status: 'ACTIVE', phone_masked: '139****0001' };

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
    expect(getSessionSnapshot()).toEqual({ status: 'authenticated', me: ME, activeRole: 'user' });
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
    expect(getSessionSnapshot()).toEqual({ status: 'anonymous', me: null, activeRole: 'user' });
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
    expect(getSessionSnapshot()).toEqual({ status: 'anonymous', me: null, activeRole: 'user' });
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
    expect(getSessionSnapshot()).toEqual({ status: 'authenticated', me: ME, activeRole: 'user' });
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
    expect(getSessionSnapshot()).toEqual({ status: 'anonymous', me: null, activeRole: 'user' });
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

describe('双角色切换（A1 R-02：POST /auth/switch-role 换签不换登录态）', () => {
  it('登录默认激活角色 user（roles 含 user 先 user——identity defaultRole 同口径）', async () => {
    stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, {
          access_token: 'at-u',
          refresh_token: 'rt-dual',
          roles: ['user', 'lawyer'],
        });
      return jsonResponse(200, ME_DUAL);
    });
    await verifyAndLogin({ phone: '13900000001', code: '123456', ageDeclared: true });
    expect(getSessionSnapshot().activeRole).toBe('user');
  });

  it('lawyer-only 账号登录 → activeRole=lawyer（无 user 行的兜底序）', async () => {
    stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, {
          access_token: 'at-l',
          refresh_token: 'rt-l',
          roles: ['lawyer'],
        });
      return jsonResponse(200, {
        id: 9,
        roles: ['lawyer'],
        status: 'ACTIVE',
        phone_masked: '139****0002',
      });
    });
    await verifyAndLogin({ phone: '13900000002', code: '123456', ageDeclared: true });
    expect(getSessionSnapshot().activeRole).toBe('lawyer');
  });

  it('admin-only 账号（权限旗标非激活角色）→ activeRole 兜底回 user（评审 N1：不误入律师壳）', async () => {
    stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, {
          access_token: 'at-a',
          refresh_token: 'rt-a',
          roles: ['admin'],
        });
      return jsonResponse(200, {
        id: 11,
        roles: ['admin'],
        status: 'ACTIVE',
        phone_masked: '139****0003',
      });
    });
    await verifyAndLogin({ phone: '13900000003', code: '123456', ageDeclared: true });
    expect(getSessionSnapshot().activeRole).toBe('user'); // clamp 兜底：保底用户壳+无切换入口
  });

  it('switchRole(lawyer)：POST /auth/switch-role {target_role} → 换 access token（refresh 保留）→ /me 重取 → activeRole=lawyer', async () => {
    const seen = stubFetch((call, c) => {
      if (c.url.endsWith('/auth/verify'))
        return jsonResponse(200, {
          access_token: 'at-user',
          refresh_token: 'rt-keep',
          roles: ['user', 'lawyer'],
        });
      if (c.url.endsWith('/auth/switch-role'))
        return jsonResponse(200, { access_token: 'at-lawyer' });
      const headers = c.init.headers as Record<string, string>;
      if (headers.Authorization === 'Bearer at-lawyer') return jsonResponse(200, ME_DUAL);
      return jsonResponse(200, ME_DUAL);
    });
    await verifyAndLogin({ phone: '13900000001', code: '123456', ageDeclared: true });
    expect(seen.length).toBe(2); // verify + /me

    await switchRole('lawyer');
    // 契约词汇 snake_case：body={target_role:'lawyer'}，Bearer 注入
    expect(seen[2]?.url.endsWith('/auth/switch-role')).toBe(true);
    expect(JSON.parse(String(seen[2]?.init.body))).toEqual({ target_role: 'lawyer' });
    expect((seen[2]?.init.headers as Record<string, string>).Authorization).toBe('Bearer at-user');
    // 换签后 /me 缓存失效重取，且带新 token
    expect(seen[3]?.url.endsWith('/me')).toBe(true);
    expect((seen[3]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer at-lawyer',
    );

    const snap = getSessionSnapshot();
    expect(snap.status).toBe('authenticated');
    expect(snap.activeRole).toBe('lawyer');

    // refresh token 保留：后续 /me 401 时仍用 rt-keep 走单飞刷新（登录态不清）
    expect(seen.some((c) => c.url.endsWith('/auth/refresh'))).toBe(false);
  });

  it('switchRole 后 401 自愈仍用原 refresh_token（换签不换登录态实证）', async () => {
    stubFetch((_call, c) => {
      if (c.url.endsWith('/auth/verify'))
        return jsonResponse(200, {
          access_token: 'at-user2',
          refresh_token: 'rt-keep2',
          roles: ['user', 'lawyer'],
        });
      if (c.url.endsWith('/auth/switch-role'))
        return jsonResponse(200, { access_token: 'at-lawyer2' });
      if (c.url.endsWith('/auth/refresh')) return jsonResponse(200, { access_token: 'at-lawyer3' });
      const headers = c.init.headers as Record<string, string>;
      if (headers.Authorization === 'Bearer at-lawyer2')
        return jsonResponse(401, { code: ErrorCode.Unauthorized, message: '未认证' });
      return jsonResponse(200, ME_DUAL);
    });
    await verifyAndLogin({ phone: '13900000001', code: '123456', ageDeclared: true });
    await switchRole('lawyer');
    // 已登录态拉 /me：at-lawyer2 401 → refresh 带 rt-keep2 → at-lawyer3 放行
    const me = await fetchMeWithRefresh();
    expect(me.id).toBe(7);
    expect(getSessionSnapshot().status).toBe('authenticated');
    expect(getSessionSnapshot().activeRole).toBe('lawyer');
  });

  it('switchRole 失败（403 E_ROLE_NOT_HELD）→ 照抛 AppApiError、token/activeRole 不变', async () => {
    const seen = stubFetch((call, c) => {
      if (c.url.endsWith('/auth/verify'))
        return jsonResponse(200, {
          access_token: 'at-hold',
          refresh_token: 'rt-hold',
          roles: ['user'],
        });
      if (c.url.endsWith('/auth/switch-role'))
        return jsonResponse(403, {
          code: ErrorCode.RoleNotHeld,
          message: '目标角色未授予：lawyer',
        });
      return jsonResponse(200, ME);
    });
    await verifyAndLogin({ phone: '13800000000', code: '123456', ageDeclared: true });

    let thrown: unknown = null;
    try {
      await switchRole('lawyer');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as { code?: string }).code).toBe(ErrorCode.RoleNotHeld);
    expect((thrown as { message?: string }).message).toBe('当前账号未持有该角色'); // error-messages 单源映射
    // 失败零副作用：恰三请求（verify+/me+switch-role，失败后不补发 /me），快照保持 user 激活
    expect(seen.length).toBe(3);
    expect(getSessionSnapshot().activeRole).toBe('user');
  });

  it('switchRole 成功但 /me 重取网络失败 → 登录态保留、activeRole 仍随换签更新（token 已换是事实）', async () => {
    stubFetch((call, c) => {
      if (c.url.endsWith('/auth/verify'))
        return jsonResponse(200, {
          access_token: 'at-u3',
          refresh_token: 'rt-3',
          roles: ['user', 'lawyer'],
        });
      if (c.url.endsWith('/auth/switch-role')) return jsonResponse(200, { access_token: 'at-l3' });
      if (call === 1) return jsonResponse(200, ME_DUAL);
      return new Error('ECONNRESET');
    });
    await verifyAndLogin({ phone: '13900000001', code: '123456', ageDeclared: true });
    await switchRole('lawyer');
    const snap = getSessionSnapshot();
    expect(snap.status).toBe('authenticated'); // 不误杀登录态
    expect(snap.activeRole).toBe('lawyer');
    expect(snap.me).toEqual(ME_DUAL); // /me 为账号级视图（角色无关），旧缓存保留
  });

  it('switchRole 后 /me 401 且 refresh 契约性失效 → 会话已被清：快照=anonymous（评审 I1：不复活假律师壳）', async () => {
    stubFetch((call, c) => {
      if (c.url.endsWith('/auth/verify'))
        return jsonResponse(200, {
          access_token: 'at-u5',
          refresh_token: 'rt-5',
          roles: ['user', 'lawyer'],
        });
      if (c.url.endsWith('/auth/switch-role')) return jsonResponse(200, { access_token: 'at-l5' });
      if (call === 1) return jsonResponse(200, ME_DUAL); // 登录期 /me 放行
      // 换签后 /me 重取：401 → refresh 契约性失效（E_REFRESH_EXPIRED）→ fetchMeWithRefresh
      // 内 tryRefreshOnce 已 clearSession（匿名态+token 全清）——switchRole 不得再复活
      if (c.url.endsWith('/auth/refresh'))
        return jsonResponse(401, { code: ErrorCode.RefreshExpired, message: '登录已失效' });
      return jsonResponse(401, { code: ErrorCode.Unauthorized, message: '未认证' });
    });
    await verifyAndLogin({ phone: '13900000001', code: '123456', ageDeclared: true });
    await switchRole('lawyer');
    expect(getSessionSnapshot()).toEqual({
      status: 'anonymous',
      me: null,
      activeRole: 'user',
    }); // 匿名回 user 缺省激活——不得停在 token 全空的「假律师壳」
  });

  it('switchRole(user)：律师态回切同面（R-02 双角色同账号）', async () => {
    stubFetch((call, c) => {
      if (c.url.endsWith('/auth/verify'))
        return jsonResponse(200, {
          access_token: 'at-l4',
          refresh_token: 'rt-4',
          roles: ['user', 'lawyer'],
        });
      if (c.url.endsWith('/auth/switch-role')) return jsonResponse(200, { access_token: 'at-u4' });
      return jsonResponse(200, ME_DUAL);
    });
    await verifyAndLogin({ phone: '13900000001', code: '123456', ageDeclared: true });
    await switchRole('lawyer');
    await switchRole('user');
    expect(getSessionSnapshot().activeRole).toBe('user');
  });

  it('logout 清 activeRole（回匿名态=回 user 缺省激活）', async () => {
    stubFetch((call) => {
      if (call === 0)
        return jsonResponse(200, {
          access_token: 'at-9',
          refresh_token: 'rt-9',
          roles: ['user', 'lawyer'],
        });
      if (call === 1) return jsonResponse(200, ME_DUAL);
      return jsonResponse(200, { ok: true, revoked: true });
    });
    await verifyAndLogin({ phone: '13900000001', code: '123456', ageDeclared: true });
    await switchRole('lawyer');
    await logout();
    expect(getSessionSnapshot().status).toBe('anonymous');
    expect(getSessionSnapshot().activeRole).toBe('user');
  });

  it('未登录 switchRole → 本地拒绝 E_UNAUTHORIZED（评审 N3：无 access token 不发请求，语义=登录失效面）', async () => {
    const seen = stubFetch(() => new Error('不应发出任何请求'));
    let thrown: unknown = null;
    try {
      await switchRole('lawyer');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as { code?: string }).code).toBe(ErrorCode.Unauthorized);
    expect((thrown as { message?: string }).message).toBe('登录已失效，请重新登录'); // 单源映射
    expect(seen.length).toBe(0);
  });
});
