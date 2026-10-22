/**
 * API 基址解析（M3-W1 T1）：EXPO_PUBLIC_API_BASE env 注入，dev 默认本地 core（PORT=3000，
 * config/dev/app.env）。密钥/凭据禁入源码——base URL 是非敏感部署坐标，走 env（全局约束）。
 *
 * setApiBaseUrl：测试/E2E 注入用（避免依赖进程 env 的写入顺序）；生产链路只读 env。
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

function resolveFromEnv(): string {
  const fromEnv =
    typeof process !== 'undefined' ? (process.env?.EXPO_PUBLIC_API_BASE ?? undefined) : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL;
}

let overrideBaseUrl: string | null = null;

/** 当前 API 基址（无尾斜杠） */
export function apiBaseUrl(): string {
  const raw = overrideBaseUrl ?? resolveFromEnv();
  return raw.replace(/\/+$/, '');
}

/** 测试/E2E 专用：注入基址；无参清除 */
export function setApiBaseUrl(url?: string): void {
  overrideBaseUrl = url && url.length > 0 ? url : null;
}
