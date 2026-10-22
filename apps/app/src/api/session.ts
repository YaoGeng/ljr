/**
 * 登录会话（M3-W1 T1，A1 契约消费）：
 *   POST /auth/sms {phone} → {ttl}
 *   POST /auth/verify {phone, code, age_declared?} → {access_token, refresh_token, roles}
 *   GET  /me（Bearer）→ {id, roles, status, phone_masked}
 *   POST /auth/logout {refresh_token}（幂等）
 *
 * 形态（W1-5）：token 内存态 + useSyncExternalStore 订阅；AsyncStorage 持久化后置
 * （零新依赖红线：不装 @react-native-async-storage，冷启动即匿名态）。
 * 401 自愈：认证面请求遇 E_UNAUTHORIZED 先单飞 POST /auth/refresh 换新 access 再重试一次；
 * refresh 仅契约性失效（E_REFRESH_EXPIRED/E_UNAUTHORIZED）才清会话，瞬时网络错保留会话
 * 并照抛原 401（R-W2-4 吊销即时生效不无限续，网络抖动不误杀有效 token）。
 *
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { ErrorCode } from '@ljr/shared';
import { apiFetch, isAppApiError, setAccessToken } from './client';

/** A1 §5 /me 视图（契约无昵称字段——展示用 phone_masked，缺口见设计决策文档 triage） */
export interface MeView {
  readonly id: number;
  readonly roles: readonly string[];
  readonly status: string;
  readonly phone_masked: string;
}

export interface VerifyResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly roles: readonly string[];
}

export type SessionStatus = 'anonymous' | 'authenticated';

export interface SessionSnapshot {
  readonly status: SessionStatus;
  readonly me: MeView | null;
}

const INITIAL_SNAPSHOT: SessionSnapshot = { status: 'anonymous', me: null };

let snapshot: SessionSnapshot = INITIAL_SNAPSHOT;
let refreshToken: string | null = null;
let roles: readonly string[] = [];
const listeners = new Set<() => void>();

function publish(next: SessionSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

/** useSyncExternalStore 订阅口 */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSessionSnapshot(): SessionSnapshot {
  return snapshot;
}

/** 发送验证码（限频 429 语义由服务端给，客户端只映射文案） */
export async function requestSmsCode(phone: string): Promise<{ ttl: number }> {
  return apiFetch<{ ttl: number }>('/auth/sms', { method: 'POST', body: { phone } });
}

/**
 * 验证码登录/注册：verify → 存 token → GET /me。
 * /me 失败视为登录未完成：清 token 回匿名态并抛错（不装「已登录但无资料」的中间态）。
 */
export async function verifyAndLogin(input: {
  phone: string;
  code: string;
  /** 新建号必填 true（R-04/R-W2-C）；勾选才随请求发送 */
  ageDeclared: boolean;
}): Promise<MeView> {
  const verified = await apiFetch<VerifyResponse>('/auth/verify', {
    method: 'POST',
    body: {
      phone: input.phone,
      code: input.code,
      age_declared: input.ageDeclared ? true : undefined,
    },
  });
  refreshToken = verified.refresh_token;
  roles = verified.roles;
  setAccessToken(verified.access_token);
  try {
    const me = await fetchMeWithRefresh();
    publish({ status: 'authenticated', me });
    return me;
  } catch (e) {
    clearSession();
    throw e;
  }
}

/** GET /me（带 401 单飞刷新自愈） */
export async function fetchMeWithRefresh(): Promise<MeView> {
  try {
    return await apiFetch<MeView>('/me', { auth: true });
  } catch (e) {
    if (isAppApiError(e) && e.code === ErrorCode.Unauthorized && refreshToken) {
      const refreshed = await tryRefreshOnce();
      if (refreshed) {
        return apiFetch<MeView>('/me', { auth: true });
      }
    }
    throw e;
  }
}

/** 单飞 refresh：并发 401 只发一次 /auth/refresh；成功换新 access。
 *  失败分诊（评审 I2）：仅契约性失效（E_REFRESH_EXPIRED / E_UNAUTHORIZED）才清会话；
 *  瞬时网络错/5xx 保留会话（access/refresh 仍有效）return false，上层照抛原 401——
 *  不因一次网络抖动丢弃有效 refresh_token 强制重登。 */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefreshOnce(): Promise<boolean> {
  if (!refreshToken) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const r = await apiFetch<{ access_token: string }>('/auth/refresh', {
          method: 'POST',
          body: { refresh_token: refreshToken },
        });
        setAccessToken(r.access_token);
        return true;
      } catch (e) {
        if (
          isAppApiError(e) &&
          (e.code === ErrorCode.RefreshExpired || e.code === ErrorCode.Unauthorized)
        ) {
          clearSession();
        }
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** 登出：POST /auth/logout（服务端吊销 refresh，幂等；网络失败不阻塞本地清态） */
export async function logout(): Promise<void> {
  const tokenToRevoke = refreshToken;
  clearSession();
  if (tokenToRevoke) {
    try {
      await apiFetch<{ ok: true; revoked: boolean }>('/auth/logout', {
        method: 'POST',
        body: { refresh_token: tokenToRevoke },
      });
    } catch {
      // 幂等面：本地已清态即可，服务端 token 自然过期兜底
    }
  }
}

function clearSession(): void {
  refreshToken = null;
  roles = [];
  setAccessToken(null);
  publish(INITIAL_SNAPSHOT);
}

/** 只读访问（展示层用 snapshot 优先；roles 供后续角色切换用） */
export function currentRoles(): readonly string[] {
  return roles;
}

/** 测试复位 */
export function __resetSessionForTest(): void {
  clearSession();
  refreshInFlight = null;
}
