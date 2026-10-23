/**
 * admin 登录会话（M3-W3 T1，W3-2）：手机验证码登录（POST /auth/verify 同 App 端链路），
 * 会话=access token + roles **驻留 localStorage**（运营后台刷新常驻形态——App 端内存态
 * 不适用于 Web 后台；refresh_token 不落盘，过期即 401 回登录重登）。
 *
 * 登录门收口（计划 T1 ②）：
 *   - verify 返回 roles **含 admin** → 存会话进壳（admin=权限旗标语义，identity.guards
 *     @RequireRole('admin') 同口径——判 roles 成员，不要求激活角色）；
 *   - roles 不含 admin → **不存任何会话**，signIn 返回 'forbidden'——登录页显式
 *     「无后台权限」态可重输，不进壳。
 * 不变量：snapshot.status='authenticated' ⇒ roles 含 admin（restore 对无 admin 旗标的
 * 陈旧/残缺存储按无效清空——壳层据此可信任 authed 判定）。
 *
 * 401 回调与路由解耦：壳层把「清会话」注册进 client.setOnUnauthorized（hash 重定向由
 * 路由 resolveRoute 对 anonymous 态自动收口，无需命令式导航）。
 *
 * 本模块无 react import，bun test 直接可测（storage 以全局 localStorage 为宿，测试注桩）。
 */
import { setAccessToken } from './client';
import { verifyLogin } from './auth';

/** localStorage 键（ljr_admin_* 命名空间；token 仅运行态驻留，禁入源码/日志） */
export const STORAGE_KEYS = {
  token: 'ljr_admin_token',
  roles: 'ljr_admin_roles',
  phoneTail: 'ljr_admin_phone_tail',
} as const;

export type AdminSessionStatus = 'anonymous' | 'authenticated';

export interface AdminSessionSnapshot {
  readonly status: AdminSessionStatus;
  readonly roles: readonly string[];
  /** 登录手机号尾号（顶栏展示；anonymous=null） */
  readonly phoneTail: string | null;
}

const INITIAL_SNAPSHOT: AdminSessionSnapshot = { status: 'anonymous', roles: [], phoneTail: null };

let snapshot: AdminSessionSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();

/** roles 含 admin 旗标判定（登录门与 restore 校验共用单源） */
export function hasAdminRole(roles: readonly string[]): boolean {
  return roles.includes('admin');
}

function publish(next: AdminSessionSnapshot): AdminSessionSnapshot {
  snapshot = next;
  for (const l of listeners) l();
  return snapshot;
}

/** useSyncExternalStore 订阅口 */
export function subscribeAdminSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAdminSessionSnapshot(): AdminSessionSnapshot {
  return snapshot;
}

/** storage 宿（缺 localStorage 的环境按无持久化处理，不抛错） */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 解析存储的 roles（非法形态=null） */
function readStoredRoles(): readonly string[] | null {
  const s = storage();
  if (s === null) return null;
  try {
    const parsed: unknown = JSON.parse(s.getItem(STORAGE_KEYS.roles) ?? '');
    if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== 'string')) return null;
    return parsed as readonly string[];
  } catch {
    return null;
  }
}

function persistSession(token: string, roles: readonly string[], phoneTail: string): void {
  const s = storage();
  if (s === null) return;
  s.setItem(STORAGE_KEYS.token, token);
  s.setItem(STORAGE_KEYS.roles, JSON.stringify(roles));
  s.setItem(STORAGE_KEYS.phoneTail, phoneTail);
}

function clearPersistedSession(): void {
  const s = storage();
  if (s === null) return;
  for (const key of Object.values(STORAGE_KEYS)) {
    s.removeItem(key);
  }
}

function clearSession(): void {
  setAccessToken(null);
  publish(INITIAL_SNAPSHOT);
}

/**
 * 冷启动恢复：token 在 + roles 含 admin → authenticated（同步 client token）；
 * 残缺/无 admin 旗标（陈旧脏数据）→ 清空按匿名（不变量收口）。
 */
export function restoreSession(): AdminSessionSnapshot {
  const s = storage();
  if (s === null) return snapshot;
  const token = s.getItem(STORAGE_KEYS.token);
  const roles = readStoredRoles();
  if (token !== null && token !== '' && roles !== null && hasAdminRole(roles)) {
    setAccessToken(token);
    const phoneTail = s.getItem(STORAGE_KEYS.phoneTail);
    return publish({
      status: 'authenticated',
      roles,
      phoneTail: phoneTail !== null && phoneTail !== '' ? phoneTail : null,
    });
  }
  clearPersistedSession();
  clearSession();
  return snapshot;
}

export type SignInResult = { status: 'ok' } | { status: 'forbidden' };

/**
 * 验证码登录：verify → admin 旗标判定。
 * forbidden=登录成功但无后台权限（不存会话，登录页显式态可重输）；
 * 验证码错/限频等错误照抛 AdminApiError（文案走 error-messages 单源）。
 */
export async function signIn(phone: string, code: string): Promise<SignInResult> {
  const login = await verifyLogin(phone, code);
  if (!hasAdminRole(login.roles)) return { status: 'forbidden' };
  const phoneTail = phone.slice(-4);
  persistSession(login.accessToken, [...login.roles], phoneTail);
  setAccessToken(login.accessToken);
  publish({ status: 'authenticated', roles: [...login.roles], phoneTail });
  return { status: 'ok' };
}

/**
 * 退出：本地清会话即可（access token 服务端自然过期；refresh_token 未存储故无 /auth/logout
 * 吊销面——不发明不在册的会话管理）。
 */
export function signOut(): void {
  clearPersistedSession();
  clearSession();
}

/** 测试复位（清存储+内存态） */
export function __resetSessionForTest(): void {
  clearPersistedSession();
  clearSession();
}
