/**
 * Playwright 配置（M3-W1 T5，A-5 webapp-testing 补验载体）：
 * 对 `expo export --platform web --clear` 产物（同源静态宿+core 反代，见 lib/serve-e2e.mjs）
 + 本地真实 core（PG 5435）跑六条核心旅程（journeys.spec.ts）。
 *
 * - 单 worker 串行：旅程间有数据序（J5 依赖 J4 用户已发布拼团；J6 依赖 J3 后场次余 1 席）；
 * - baseURL/坐标经编排器 env 注入（run-e2e.mjs），零硬编码密钥/端口耦合；
 * - 本文件不进 tsconfig include（apps/app/tsconfig.json 只圈 App/index/src），typecheck 面不受影响。
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
    baseURL: process.env.E2E_APP_BASE ?? 'http://127.0.0.1:8792',
    viewport: { width: 390, height: 844 }, // 原型 App 端手机框宽度口径
    actionTimeout: 10_000,
    headless: true,
  },
});
