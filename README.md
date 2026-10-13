# 律聚人（LJR）monorepo

AI 增强型法律服务交易平台（首发专项：劳动仲裁）。需求与设计的唯一事实源在 `docs/`，本仓产品代码自 M0-2（monorepo 骨架）起建。

## 布局（七包）

| 目录                       | 包名                   | 说明                                                     |
| -------------------------- | ---------------------- | -------------------------------------------------------- |
| `services/core`            | `@ljr/core`            | Core API（NestJS 模块化单体，13 模块=13 schema+DB role） |
| `services/rtc-im`          | `@ljr/rtc-im`          | RTC/IM 独立服务（实现栈随施工裁决，ADR-0001）            |
| `services/agent-assist`    | `@ljr/agent-assist`    | AI agent-assist 独立服务（同上，不选型）                 |
| `services/payment-gateway` | `@ljr/payment-gateway` | 支付网关独立服务（同上，不选型）                         |
| `apps/app`                 | `@ljr/app`             | App 用户端+律师端（Expo / React Native）                 |
| `apps/admin`               | `@ljr/admin`           | Web 运营后台（React + Vite）                             |
| `packages/shared`          | `@ljr/shared`          | 跨包契约：错误码 / 金额 / 领域事件                       |

## 常用命令

```bash
pnpm build   # = pnpm -r build（各包空壳构建）
pnpm test    # = pnpm -r test（core=vitest，其余包=bun test）
pnpm lint    # eslint . + prettier --check .
pnpm format  # prettier --write .
```

## 硬约定

- 测试文件命名（防双运行器互捞）：`services/core` 用 `*.spec.ts`（vitest），其余包与 Node 脚本用 `*.test.ts`（bun test）。
- 依赖零提升（`.npmrc shamefully-hoist=false`）：各包只能 import 自己声明的依赖。
- 工具链版本以 `pnpm-lock.yaml` 为可复现事实源。
