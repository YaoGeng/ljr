/**
 * API 基址解析（M3-W3 T1，对照 apps/app/src/api/config.ts 先例、独立实现）：
 * `import.meta.env.VITE_API_BASE` 构建期注入；**缺省空串=同源相对路径**（Web SPA 同源形态
 * ——dev 走 vite.config.ts server.proxy，部署/E2E 构建轨注入绝对值）。密钥/凭据禁入源码——
 * base URL 是非敏感部署坐标，走 env（全局约束）。
 *
 * 读取形态：vite 直取 `import.meta.env.VITE_API_BASE`（可选链/间接形态会被构建期常量折叠，
 * app 侧 T6 评审 S9 已实证同坑）+ process.env 回退兜 bun test 运行态注入。
 * setApiBaseUrl：测试/E2E 注入用（避免依赖进程 env 写入顺序）；生产链路只读 env。
 */

let overrideBaseUrl: string | null = null;

function resolveFromEnv(): string {
  const fromVite = import.meta.env.VITE_API_BASE;
  if (typeof fromVite === 'string' && fromVite.length > 0) return fromVite;
  const fromProcess =
    typeof process !== 'undefined' ? (process.env?.VITE_API_BASE ?? undefined) : undefined;
  return typeof fromProcess === 'string' && fromProcess.length > 0 ? fromProcess : '';
}

/** 当前 API 基址（无尾斜杠；''=同源相对路径） */
export function apiBaseUrl(): string {
  return (overrideBaseUrl ?? resolveFromEnv()).replace(/\/+$/, '');
}

/** 测试/E2E 专用：注入基址；无参清除 */
export function setApiBaseUrl(url?: string): void {
  overrideBaseUrl = url && url.length > 0 ? url : null;
}
