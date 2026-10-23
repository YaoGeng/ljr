import { beforeEach, describe, expect, it } from 'bun:test';
import { getAccessToken, __resetClientForTest } from './client';
import { resolveRoute } from '../navigation/router-state';
import {
  __resetSessionForTest,
  hasAdminRole,
  restoreSession,
  signIn,
  signOut,
  STORAGE_KEYS,
  getAdminSessionSnapshot,
} from './session';

/** 内存 localStorage 桩（bun 宿行为不假定——session 以全局 localStorage 为存储宿） */
function installMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length(): number {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  });
  return store;
}

/** POST /auth/verify 成功响应桩（identity.controller 实码形状） */
function stubVerifyResponse(roles: string[]): void {
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(
      JSON.stringify({ access_token: `jwt-${roles.join('-')}`, refresh_token: 'rt-x', roles }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
}

let store: Map<string, string>;

beforeEach(() => {
  __resetClientForTest();
  __resetSessionForTest();
  store = installMemoryStorage();
});

describe('admin 会话（M3-W3 T1：admin 旗标判定 + localStorage 驻留）', () => {
  it('hasAdminRole：roles 成员判定（user+admin=true；user-only/空=false）', () => {
    expect(hasAdminRole(['user', 'admin'])).toBe(true);
    expect(hasAdminRole(['user'])).toBe(false);
    expect(hasAdminRole([])).toBe(false);
  });

  it('signIn：roles 含 admin → 存 token/roles/尾号 + authenticated 快照', async () => {
    stubVerifyResponse(['user', 'admin']);
    const result = await signIn('13700000001', '222222');
    expect(result).toEqual({ status: 'ok' });
    const snap = getAdminSessionSnapshot();
    expect(snap.status).toBe('authenticated');
    expect(hasAdminRole(snap.roles)).toBe(true);
    expect(snap.phoneTail).toBe('0001');
    expect(store.get(STORAGE_KEYS.token)).toBe('jwt-user-admin');
    expect(JSON.parse(store.get(STORAGE_KEYS.roles) ?? '[]')).toEqual(['user', 'admin']);
    expect(getAccessToken()).toBe('jwt-user-admin');
  });

  it('signIn：roles 不含 admin → forbidden，不存任何会话（登录页显式态可重输）', async () => {
    stubVerifyResponse(['user']);
    const result = await signIn('13800000000', '123456');
    expect(result).toEqual({ status: 'forbidden' });
    expect(getAdminSessionSnapshot().status).toBe('anonymous');
    expect(store.size).toBe(0);
    expect(getAccessToken()).toBeNull();
  });

  it('restoreSession：有效存储恢复 authenticated；无 admin 旗标/残缺存储清空按匿名', () => {
    store.set(STORAGE_KEYS.token, 'jwt-restored');
    store.set(STORAGE_KEYS.roles, JSON.stringify(['user', 'admin']));
    store.set(STORAGE_KEYS.phoneTail, '0001');
    expect(restoreSession().status).toBe('authenticated');
    expect(getAccessToken()).toBe('jwt-restored');

    __resetSessionForTest();
    store.set(STORAGE_KEYS.token, 'jwt-stale');
    store.set(STORAGE_KEYS.roles, JSON.stringify(['user'])); // 无 admin 旗标=脏数据
    expect(restoreSession().status).toBe('anonymous');
    expect(store.has(STORAGE_KEYS.token)).toBe(false); // 清空不复活

    __resetSessionForTest();
    store.set(STORAGE_KEYS.roles, JSON.stringify(['user', 'admin'])); // 缺 token 行
    expect(restoreSession().status).toBe('anonymous');
  });

  it('signOut：清存储+内存态（token/client 同步复位）', async () => {
    stubVerifyResponse(['admin']);
    await signIn('13700000001', '222222');
    signOut();
    expect(getAdminSessionSnapshot()).toEqual({ status: 'anonymous', roles: [], phoneTail: null });
    expect(store.size).toBe(0);
    expect(getAccessToken()).toBeNull();
  });

  it('boot 不变量（评审 IMPORTANT-1）：restore 先于路由解析——已登录深层 hash 不被 login 重定向', () => {
    // 启动序契约 = main.tsx 在 createRoot().render 前同步 restoreSession()，路由首解析
    // 用恢复后的快照判 authed。此处按该序组合断言：若恢复退回 effect（首帧后）执行，
    // 首解析将拿 anonymous 快照 → #/lawyers 被 login 重定向丢失（本用例钉住的目标缺陷）。
    store.set(STORAGE_KEYS.token, 'jwt-boot');
    store.set(STORAGE_KEYS.roles, JSON.stringify(['user', 'admin']));
    store.set(STORAGE_KEYS.phoneTail, '0001');
    const snap = restoreSession(); // ① 先恢复（启动序）
    const resolved = resolveRoute({ hash: '#/lawyers', authed: snap.status === 'authenticated' }); // ② 后解析
    expect(resolved.route.key).toBe('lawyers');
    expect(resolved.redirected).toBe(false);
    // 反面钉：anonymous 快照下同 hash 必落 login（门的语义不被本修复破坏）
    __resetSessionForTest();
    expect(resolveRoute({ hash: '#/lawyers', authed: false }).route.key).toBe('login');
  });
});
