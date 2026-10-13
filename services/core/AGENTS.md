# AGENTS.md — services/core（@ljr/core，NestJS 模块化单体）

M0 基座就位；**13 个业务 schema/DB role 已在 V1 迁移落库，但代码模块自 M1 起才逐个落位**（现仅 demo 样板）。模块清单与边界：docs/02-架构设计.md §3.2（identity/schedule/pricing/trade/fulfillment/payment/settlement/credit/review/notify/benefits/agent-assist/ops）；每模块施工规格：docs/modules/<域>/<ID>-*.md（R-xx 规则表 + TDD 先行，模板约定在 docs/modules/README.md）。上位规则见根 AGENTS.md「架构硬约束」。

## 结构

```
src/main.ts             bootstrap：TraceLogger、enableShutdownHooks、OutboxRelayService.start()、按 port 监听
src/app.module.ts       AppModule 现仅注册 4 模块：AppConfig / Observability / Infrastructure / Demo + HealthController
src/config/             env 优先级=进程 env > config/<LJR_ENV>/app.env > 代码默认；密钥禁入文件层（E_CONFIG_INVALID）
src/observability/      OTel + TraceLogger；OTLP 端点只认标准键 OTEL_EXPORTER_OTLP_ENDPOINT（不走 app.env）
src/infrastructure/
  outbox/               OutboxService（同事务写事件）+ OutboxRelayService（at-least-once：event_id 唯一约束防重，非恰好一次）
  state-machine/        StateTransitionGuard + StateTransitionLogService（「状态禁裸写」执行层；拒绝留痕走独立连接，不随业务回滚）
  sql.ts                pgConfigFromEnv（与 scripts/db/lib.mjs 同口径，默认端口 5435）
  testing/db.ts         ensureTestDatabase：不自动起库/迁移；TRUNCATE ... RESTART IDENTITY 清场，表清单=TEST_DB_TABLES 硬编码
src/modules/demo/       样板形态：module + service + machine + consumer + spec——新业务模块照此
migrations/             V1__schemas_roles（13 schema/14 role）/ V2__outbox / V3__state_transition_log + table-manifest.json
flyway.conf             双轨共用；凭据经 FLYWAY_URL/FLYWAY_USER/FLYWAY_PASSWORD 注入禁落盘；locations=filesystem:migrations 相对 CWD
vitest.config.mts       只收 src/**/*.spec.ts；fileParallelism=false（DB spec 共享一个 PG 靠 TRUNCATE 隔离，必须串行）；testTimeout=15s
```

## WHERE TO LOOK

| 任务 | 起点 |
|---|---|
| 新建业务模块 | docs/02 §3.2 定边界 → docs/modules/<域>/<ID>-*.md 规格 → 抄 modules/demo 形态（对应 schema 已在 V1 建好） |
| 加表/改表 | migrations/ 新增 V<n>__*.sql（全限定 schema 名）→ 仓库根 `pnpm gen:table-manifest` → **同步 testing/db.ts 的 TEST_DB_TABLES** |
| 配置排查 | src/config/app.config.ts（键：LJR_ENV/PORT/LJR_PG_*/LJR_REDIS_*/LJR_ROCKETMQ_NAMESRV_ADDR/LJR_NACOS_SERVER_ADDR/LJR_OBS_ENABLED） |
| 跨 schema 引用疑虑 | `node scripts/check-schema-refs.mjs`：横切基座直连业务表 = exit 1 |

## 跑测试前置（顺序敏感）

1. `node scripts/db/start.mjs && node scripts/db/migrate.mjs`
2. `pnpm --filter @ljr/shared build`（源外消费，dist 不入库）
3. 本目录 `pnpm test`（vitest）

## ANTI-PATTERNS

- 禁增删 schema/role（V1 头部注释明示）——模块增删是架构变更，先改 docs 走 ADR
- DDL 一律全限定 schema 名（flyway 历史表在独立 `flyway` schema，业务 schema 不入 flyway.schemas）
- 迁移按 V<n> 数值排序（V10 禁落 V2 前；gen-table-manifest 有断言）
- 金额一律经 @ljr/shared 的 Money（字符串）往返，禁 number（outbox.spec 有断言）
