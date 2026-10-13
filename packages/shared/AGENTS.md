# AGENTS.md — packages/shared（@ljr/shared 跨端契约包）

唯一跨 workspace 契约包（当前消费方仅 services/core：10 个源文件 import）。CONTRACT_VERSION 在 src/index.ts。金额 NUMERIC 禁 float 等全仓口径见根 AGENTS.md。

## 结构

```
src/index.ts         re-export 以下四模块 + CONTRACT_VERSION（'0.2.0'）
src/error-codes.ts   ErrorCode 全表（E_ 前缀全表唯一）+ AppError/isAppError
src/events.ts        DomainEvent 事件契约
src/money.ts         Money（字符串金额）+ isValidMoney/assertMoney
src/idempotency.ts   isValidIdempotencyKey/withIdempotency
```

## CONVENTIONS

- 测试 = bun test（co-located `*.test.ts`），禁用 vitest
- main 指向 dist/index.js 且 dist 不入库（源外消费）：**改完必须 `pnpm --filter @ljr/shared build`，消费方才能 typecheck/测试**；CI 中该顺序被 ci.yml 钉死并有 scripts/check-ci-workflow.test.mjs 断言
- 新错误码只进 error-codes.ts 全表，业务代码禁散落裸字符串错误码

## ANTI-PATTERNS

- Money 禁 number 入参（money.test 有拒收断言）
- E_UNCLASSIFIED 仅兜底，业务路径禁主动抛
- withIdempotency 是进程级短路、重启即失效——持久幂等必须由 DB 唯一约束承担（idempotency.ts 头注释）
