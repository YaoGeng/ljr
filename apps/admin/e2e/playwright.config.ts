/**
 * Playwright 配置（M3-W3 T7，W3-8）：对 `vite build` 产物（同源静态宿+core 反代，见
 * lib/serve-e2e.mjs）+ 本地真实 core（PG 5435）跑 admin 六旅程（admin-journeys.spec.ts，
 * J13~J18——05 §7.1 W3 验收判据载体）。
 *
 * - 单 worker 串行：旅程有状态依赖（J14 的 SUBMITTED 夹具行经 claim→approve 流转、J16 词库
 *   版本递增、J18 审批后版本链前移——并发会互踩服务端状态）；
 * - baseURL/坐标经编排器 env 注入（run-admin-e2e.mjs），零硬编码端口耦合；
 * - 本文件不进 tsconfig include（apps/admin/tsconfig.json 只圈 src），typecheck 面不受影响
 *   （apps/app/e2e/playwright.config.ts 同款注记）。
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_APP_BASE ?? 'http://127.0.0.1:8795',
    viewport: { width: 1440, height: 900 }, // Web 运营后台桌面口径（App 端 390 手机框不适用）
    actionTimeout: 10_000,
    headless: true,
  },
});
