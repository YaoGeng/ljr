/**
 * 统一 API client（M3-W1 T1 建/T4 扩 PUT）：fetch 封装，App 内全部 HTTP 出口走本件。
 *
 * 契约对齐：
 *   - core 响应体 = JSON；错误体 = {code, message}（AppHttpExceptionFilter 全仓唯一形态）；
 *   - 错误码消费 @ljr/shared ErrorCode 表（本文件只做映射收窄，不改契约）；
 *   - token 注入 = 模块级 access token（session 层 set/clear，避免循环依赖）。
 *
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { ErrorCode } from '@ljr/shared';
import { apiBaseUrl } from './config';
import { resolveApiErrorCopy } from './error-messages';

/** 客户端本地错误码（非 shared 契约码；前端层信号：网络不通/响应不可解析/本地入参拒绝） */
export const AppClientErrorCode = {
  NetworkUnreachable: 'CLIENT_NETWORK',
  BadResponseBody: 'CLIENT_BAD_RESPONSE',
  /** 本地请求参数非法（评审 S6：与「服务响应形状错」分离——请求没发出就拒绝） */
  BadRequest: 'CLIENT_BAD_REQUEST',
} as const;

export type AppClientErrorCodeValue = (typeof AppClientErrorCode)[keyof typeof AppClientErrorCode];

/** shared 契约码白名单（服务端响应 code 是否表内值） */
const KNOWN_SERVER_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

/** 统一 API 错误：code + httpStatus + 用户可见 message（映射表解析，见 error-messages.ts） */
export class AppApiError extends Error {
  /** 错误码：shared ErrorCode 值（server）或 AppClientErrorCode 值（client） */
  readonly code: string;
  readonly httpStatus: number | undefined;
  /** 服务端原始 message（未映射前；无则为 undefined） */
  readonly serverMessage: string | undefined;

  constructor(opts: { code: string; copy: string; httpStatus?: number; serverMessage?: string }) {
    super(opts.copy);
    this.name = 'AppApiError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.serverMessage = opts.serverMessage;
  }
}

export function isAppApiError(e: unknown): e is AppApiError {
  return e instanceof AppApiError;
}

/** 模块级 access token（session 层唯一写入点） */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT';
  /** 请求体（自动 JSON 序列化） */
  body?: unknown;
  /** true=注入 Authorization: Bearer（默认 false） */
  auth?: boolean;
}

interface ServerErrorBody {
  code?: unknown;
  message?: unknown;
}

/** 主路径请求超时（T6 评审 I1）：15s 兜底防 fetch 无限悬挂——AbortController+setTimeout
 *  形态同 dev-pay-sim.ts（禁 AbortSignal.timeout：RN/Hermes 无该 API）；超时 abort 与断网/
 *  拒连同走网络错误分支（CLIENT_NETWORK，无服务端语义）。 */
const FETCH_TIMEOUT_MS = 15000;

/** 服务端错误体 → AppApiError（表外 code 原样透传，靠 KNOWN_SERVER_CODES 区分日志可读性） */
function toApiError(status: number, body: ServerErrorBody | null): AppApiError {
  const code = typeof body?.code === 'string' ? body.code : AppClientErrorCode.BadResponseBody;
  const serverMessage = typeof body?.message === 'string' ? body.message : undefined;
  return new AppApiError({
    code,
    httpStatus: status,
    serverMessage,
    copy: resolveApiErrorCopy(KNOWN_SERVER_CODES.has(code) ? code : '', serverMessage),
  });
}

/** fetch 封装：JSON 进出 + token 注入 + 错误统一 AppApiError */
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
    throw new AppApiError({
      code: AppClientErrorCode.NetworkUnreachable,
      copy: resolveApiErrorCopy(AppClientErrorCode.NetworkUnreachable),
    });
  } finally {
    clearTimeout(timer); // 成功/失败/超时全路径清表针，防泄漏（T6 评审 I1）
  }
  if (!res.ok) {
    let body: ServerErrorBody | null = null;
    try {
      body = (await res.json()) as ServerErrorBody;
    } catch {
      body = null;
    }
    throw toApiError(res.status, body);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new AppApiError({
      code: AppClientErrorCode.BadResponseBody,
      httpStatus: res.status,
      copy: resolveApiErrorCopy(AppClientErrorCode.BadResponseBody),
    });
  }
}

/** 测试复位：清 token（生产链路只用 session 层 API） */
export function __resetClientForTest(): void {
  accessToken = null;
}
