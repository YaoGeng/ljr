/**
 * 登录会话（M3-W1 T1 建/W2 T1 扩，A1 契约消费）：
 *   POST /auth/sms {phone} → {ttl}
 *   POST /auth/verify {phone, code, age_declared?} → {access_token, refresh_token, roles}
 *   GET  /me（Bearer）→ {id, roles, status, phone_masked}
 *   POST /auth/logout {refresh_token}（幂等）
 *   POST /auth/switch-role {target_role} → {access_token}（M3-W2 T1：双角色同 App）
 *
 * 形态（W1-5）：token 内存态 + useSyncExternalStore 订阅；AsyncStorage 持久化后置
 * （零新依赖红线：不装 @react-native-async-storage，冷启动即匿名态）。
 * 401 自愈：认证面请求遇 E_UNAUTHORIZED 先单飞 POST /auth/refresh 换新 access 再重试一次；
 * refresh 仅契约性失效（E_REFRESH_EXPIRED/E_UNAUTHORIZED）才清会话，瞬时网络错保留会话
 * 并照抛原 401（R-W2-4 吊销即时生效不无限续，网络抖动不误杀有效 token）。
 *
 * 双角色（W2-1 决策：switch-role 真链）：snapshot.activeRole=当前激活角色（claims.role 的
 * 本地镜像）；登录/刷新默认 user（identity defaultRole 同口径：roles 含 user 先 user，否则
 * lawyer）；switchRole 换签**只换 access token——refresh token/登录态保留**（A1 R-02 双角色
 * 同账号，切换不产生新会话）。
 *
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { ErrorCode } from '@ljr/shared';
import { AppApiError, apiFetch, getAccessToken, isAppApiError, setAccessToken } from './client';
import { resolveApiErrorCopy } from './error-messages';
import type { AppRole } from '../navigation/navigation-state';

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
  /** 当前激活角色（switch-role 重签的 claims.role 镜像；匿名态回 user 缺省） */
  readonly activeRole: AppRole;
}

const INITIAL_SNAPSHOT: SessionSnapshot = { status: 'anonymous', me: null, activeRole: 'user' };

let snapshot: SessionSnapshot = INITIAL_SNAPSHOT;
let refreshToken: string | null = null;
let roles: readonly string[] = [];
const listeners = new Set<() => void>();

function publish(next: SessionSnapshot): SessionSnapshot {
  snapshot = next;
  for (const l of listeners) l();
  return snapshot;
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
    publish({ status: 'authenticated', me, activeRole: defaultActiveRole(me.roles) });
    return me;
  } catch (e) {
    clearSession();
    throw e;
  }
}

/**
 * POST /auth/switch-role {target_role}（A1 §5）：重签 claims.role=target 的 access token。
 * 换签后仅替换 access token——refresh token/登录态保留（R-02 双角色同账号，切换不清登录）；
 * /me 缓存随换签失效重取，失败分诊（评审 I1）：refresh 契约性失效时 fetchMeWithRefresh →
 * tryRefreshOnce **已 clearSession**（匿名态+token 全清）——本函数不得把会话复活回
 * authenticated（否则用户停在 token 全空的「假律师壳」）；仅瞬时网络错（会话仍在）保留
 * 旧缓存（/me 为账号级视图角色无关）并随换签更新 activeRole。switch 接口本身失败照抛
 * AppApiError（error-messages 单源映射，如 403 E_ROLE_NOT_HELD），零副作用。
 */
export async function switchRole(target: AppRole): Promise<SessionSnapshot> {
  if (getAccessToken() === null) {
    // 未登录调切换=会话缺失面（评审 N3）：本地拒绝走 E_UNAUTHORIZED 文案（「登录已失效，
    // 请重新登录」）而非 CLIENT_BAD_REQUEST——用户可见语义=需重新登录，非请求参数错
    throw new AppApiError({
      code: ErrorCode.Unauthorized,
      copy: resolveApiErrorCopy(ErrorCode.Unauthorized),
    });
  }
  const done = await apiFetch<{ access_token: string }>('/auth/switch-role', {
    method: 'POST',
    body: { target_role: target },
    auth: true,
  });
  setAccessToken(done.access_token); // 唯一写点：refresh token 不动
  let me = snapshot.me;
  try {
    me = await fetchMeWithRefresh();
  } catch {
    if (refreshToken === null) {
      // 评审 I1：/me 401 → refresh 契约性失效 → 会话已被清（匿名态）——原样回发布当前
      // 快照，不复活；调用方按快照渲染（RootGate 自回登录页）
      return publish(getSessionSnapshot());
    }
    // 瞬时网络错：会话仍在，保留旧缓存（账号级视图角色无关）
  }
  return publish({ status: 'authenticated', me, activeRole: target });
}

/**
 * 默认激活角色（identity.service defaultRole 同口径兜底序 user→lawyer→admin；
 * 评审 N1：admin-only 账号=V31 运营后台预置号，不经 App 消费——若触达 clamp 回 user
 * 保底用户壳+无切换入口，fail-safe 不误入律师壳）。
 */
function defaultActiveRole(accRoles: readonly string[]): AppRole {
  if (accRoles.includes('user')) return 'user';
  if (accRoles.includes('lawyer')) return 'lawyer';
  return 'user';
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
