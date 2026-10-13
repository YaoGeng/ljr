import { defineConfig } from 'vitest/config';

// 约定（ADR-0001/0002）：core 用 vitest，测试文件 *.spec.ts；其余包走 bun test / *.test.ts。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
