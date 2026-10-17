import { defineConfig } from 'vitest/config';

// 约定（ADR-0001/0002）：core 用 vitest，测试文件 *.spec.ts；其余包走 bun test / *.test.ts。
//
// fileParallelism=false：DB spec（outbox/relay/demo e2e）共享同一个 portable PG 实例，
// 用 TRUNCATE 清场隔离用例——文件必须串行，否则并行 spec 互相清掉对方的数据。
// testTimeout 放宽：Windows 下冷启动连接池 + 并发事务用例余量。
// hookTimeout 放宽（M1-W4 T0 flaky 收敛）：credit.spec afterAll（app.close+pool.end）在
// 系统高负载时偶发超 vitest 默认 10s hookTimeout——全仓统一 30s，与 testTimeout 同理由先例。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
