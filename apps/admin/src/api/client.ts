/**
 * 统一 API client（M3-W3 T1，对照 apps/app/src/api/client.ts 先例、独立实现——admin 不
 * import apps/app 任何文件）：fetch 封装，admin 全部 HTTP 出口走本件。
 *
 * 契约对齐（core 实码）：
 *   - 响应体 = JSON；错误体 = {code, message}（AppHttpExceptionFilter 全仓唯一形态）；
 *   - token 注入 = 模块级 access token（session 层 set/clear，避免循环依赖）；
 *   - 401 统一拦截：**受保护面请求（auth:true）**收到 401 → 先触发 onUnauthorized 回调
 *     （壳层注册：清 token 回 #/login）再抛错。登录面自身（POST /auth/verify 错码也是 401）
 *     不触发——「验证码错误」与「会话失效」语义分离，登录页错误就地内联展示。
 *
 * 本模块保持无路由/DOM 依赖（错误回调由壳注入），bun test 直接可测。
 */
import { apiBaseUrl } from './config';
import { KNOWN_SERVER_CODES, resolveApiErrorCopy } from './error-messages';

/** 客户端本地错误码（非服务端契约码；前端层信号：网络不通/响应不可解析/本地入参拒绝） */
export const AdminClientErrorCode = {
  NetworkUnreachable: 'CLIENT_NETWORK',
  BadResponseBody: 'CLIENT_BAD_RESPONSE',
  BadRequest: 'CLIENT_BAD_REQUEST',
} as const;

export type AdminClientErrorCodeValue =
  (typeof AdminClientErrorCode)[keyof typeof AdminClientErrorCode];

/** 统一 API 错误：code + httpStatus + 用户可见 message（映射表解析）+ 服务端原始 message */
export class AdminApiError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly serverMessage: string | undefined;

  constructor(opts: { code: string; copy: string; httpStatus?: number; serverMessage?: string }) {
    super(opts.copy);
    this.name = 'AdminApiError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.serverMessage = opts.serverMessage;
  }
}

export function isAdminApiError(e: unknown): e is AdminApiError {
  return e instanceof AdminApiError;
}

/** 模块级 access token（session 层唯一写入点——与 localStorage 同步由 session 负责） */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** 401 回调（壳层注册：清会话+回登录页；client 本体保持无路由依赖） */
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT';
  /** 请求体（自动 JSON 序列化） */
  body?: unknown;
  /** true=注入 Authorization: Bearer 并启用 401 统一拦截（默认 false） */
  auth?: boolean;
}

interface ServerErrorBody {
  code?: unknown;
  message?: unknown;
}

/** 主路径请求超时：15s 兜底防 fetch 无限悬挂（app client.ts 同款 AbortController 形态） */
const FETCH_TIMEOUT_MS = 15000;

/** 服务端错误体 → AdminApiError（表外 code 原样透传，文案靠映射表/服务端 message 回退链） */
function toApiError(status: number, body: ServerErrorBody | null): AdminApiError {
  // code 非字符串=错误体形状错：本地码 + 固定文案（与成功体非 JSON 路径同口径——评审 NIT-1）
  if (typeof body?.code !== 'string') {
    return new AdminApiError({
      code: AdminClientErrorCode.BadResponseBody,
      httpStatus: status,
      copy: resolveApiErrorCopy(AdminClientErrorCode.BadResponseBody),
    });
  }
  const code = body.code;
  const serverMessage = typeof body.message === 'string' ? body.message : undefined;
  return new AdminApiError({
    code,
    httpStatus: status,
    serverMessage,
    copy: resolveApiErrorCopy(KNOWN_SERVER_CODES.has(code) ? code : '', serverMessage),
  });
}

/** fetch 封装：JSON 进出 + token 注入 + 错误统一 AdminApiError + 受保护面 401 拦截 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch {
    // 网络层失败（断网/拒连/DNS/超时 abort）：不带服务端语义，客户端本地码
    throw new AdminApiError({
      code: AdminClientErrorCode.NetworkUnreachable,
      copy: resolveApiErrorCopy(AdminClientErrorCode.NetworkUnreachable),
    });
  } finally {
    clearTimeout(timer); // 成功/失败/超时全路径清表针，防泄漏
  }
  if (!res.ok) {
    let body: ServerErrorBody | null = null;
    try {
      body = (await res.json()) as ServerErrorBody;
    } catch {
      body = null;
    }
    // 401 统一拦截：受保护面会话失效（过期/吊销）→ 回调先于抛错（壳层清 token 回登录页）
    if (res.status === 401 && opts.auth) {
      onUnauthorized?.();
    }
    throw toApiError(res.status, body);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new AdminApiError({
      code: AdminClientErrorCode.BadResponseBody,
      httpStatus: res.status,
      copy: resolveApiErrorCopy(AdminClientErrorCode.BadResponseBody),
    });
  }
}

/** 测试复位：清 token 与 401 回调（生产链路只用 session 层 API） */
export function __resetClientForTest(): void {
  accessToken = null;
  onUnauthorized = null;
}
