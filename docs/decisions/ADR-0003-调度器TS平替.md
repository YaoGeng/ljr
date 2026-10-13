# ADR-0003 调度器 TS 平替（弃用 XXL-Job）

> 状态：**用户指示弃用 XXL-Job（2026-10-14，"XXL-Job 是 Java，直接 TS 技术栈找平替"）+ 选型为 AI 推荐决策（用户授权自主推荐，可翻转）**——平替路线=自研轻量调度器（TS）
> 关联：架构 §2.2/§2.3/§4.5（调度选型与机制）；`docs/modules/I-平台支撑/I2-调度中心.md`（schedule_jobs 表设计/19 种 job/抢占与回查语义，机制事实源）；ADR-0001（风险与待办 XXL-Job 注记）；04 §8-18 / 05 §11 D18 / I2 §11（触发通路待裁决点）
> 效力：关闭 D18（XXL-Job 与 NestJS 触发通路）——议题随 XXL-Job 弃用整体消解；05 §5.1 W1 行 I2 裁决门解除；**调度机制红线不变**：DB 到期任务表事实源、`FOR UPDATE SKIP LOCKED` 抢占、执行器幂等回查、宽限期/缺席判定锚定约定开始时刻、log 可重放——平替只换执行器/触发节拍/可见性承载层

## 决策

| 项 | 定版 |
|---|---|
| 调度执行层（原 XXL-Job 位） | **自研轻量调度器（TS）**：NestJS 进程内 interval 轮询 `schedule_jobs` 到期任务表（常规 10–15s；ROOM_OPEN ≤5s 独立高优先级队列）+ `FOR UPDATE SKIP LOCKED` 多节点抢占 + 执行器幂等回查 + 重试退避（3 次后 FAILED+告警工单）+ `schedule_job_log` 可重放——即 I2 模块文档 §3/§4 已完整设计的机制；本决策仅确认执行器/节拍层以 TS 自研承载，**机制与 DDL 零变更** |
| 触发节拍器 | 官方 `@nestjs/schedule`（@Interval/@Cron + SchedulerRegistry + 优雅停机）或等价进程内 interval——**仅内存态节拍，非事实源**；实现细节 I2 施工定。多实例安全由 SKIP LOCKED 承担，节拍器每实例独立运行不冲突 |
| 触发通路（原 D18 议题） | 随 XXL-Job 弃用**消解**：调度器与 Core API 同进程（NestJS 模块内聚于 I2），无跨进程 HTTP 回调/Java shim 需求；I2 §5 运维视图接口（GET /admin/scheduler/jobs）保留 |
| 弃用项 | **XXL-Job 整体退出**（架构 §2.2 分层图 / §2.3 选型表 / §4.5 触发描述）；ADR-0001「XXL-Job 与 TS 后端异构」风险项关闭 |
| 控制台可见性（XXL-Job console 的平替） | 不建独立调度控制台：I2 §5 运维视图（admin Web 页面消费 GET /admin/scheduler/jobs）+ `schedule_job_log` 重放/全历史追溯 + H4 巡检（积压 >60s 告警）+ FAILED 告警工单（H3 dead_letter）+ M0-9 观测基座（积压/逾期/失败率指标入 Prometheus/Grafana，架构 §7.2） |

## 候选对比（调研摘要，2026-10-14）

| 维度 | 自研轻量调度器（@nestjs/schedule + 自研 SKIP LOCKED 轮询） | pg-boss v12 | BullMQ v6（PG 后端） | Temporal（自托管） |
|---|---|---|---|---|
| 与 §4.5 契合度（schedule_jobs 事实源；DDL 以模块文档为准） | **完全一致**：表=I2 §3 自有 DDL，Flyway `.sql` 管理（ADR-0002 SQL-first），13 模块=13 schema 纪律不变；无外部存储模型 | **schema 冲突**：自建 `pgboss` schema（`pgboss.job` v10 起分区表、`pgboss.schedule`、`pgboss.version` 迁移账本，当前 schema v44），`boss.start()` 自动迁移——以其为事实源则 I2 的 DDL/status 枚举/version 作废/job_type 全集设计被架空；保留 schedule_jobs 再叠加则双事实源/影子拷贝 | **schema 冲突**：自建 `bullmq` schema（表+SQL 函数+ledger 迁移表），显式 `runMigrations` 初始化；**schema 降级不支持**；同样架空或双源 | **整体替代**：自有 DB+事件溯源工作流模型接管调度语义，schedule_jobs 事实源设计需整体重写，§4.5 机制红线被替换 |
| 19 种 job 触发形态（延时 + 周期） | 延时=`due_at` 一次性行；周期（SLOT_REAPER/SLOT_TTL/POINTS_EXPIRE/RETENTION_PURGE）=执行 DONE 后同表自投下一周期——I2 §2 语义直接承载 | 原生 cron/RRULE schedule + 延迟任务 | Job Scheduler API（`upsertJobScheduler`，cron/间隔；`repeat` 选项已弃用）+ 延迟任务 | 原生 timer/schedule activity，能力最强 |
| misfire 补偿（错过任务） | 扫描自然捞取逾期 PENDING（`due_at ≤ now`）+ 幂等回查兜底；实例全宕重启后自愈；ROOM_OPEN >30s 电话告警 | 内建维护（maintenance/archive 清理与过期处理）；job 落库，停机恢复自然补 | job 落库表，恢复后继续；细节语义库内部 | 持久执行（durable execution），最强 |
| 多实例抢占安全 | SKIP LOCKED（I2 §10 验收：双执行器并发抢占无重复，100 job 压测） | SKIP LOCKED，自称 multi-master 兼容 | PG 后端以事务内 SQL 函数抢占（对应 Redis 端 Lua） | 服务端集群统一调度 |
| 与业务同 PG 事务写 job（I2 §2 刚需） | **天然**：业务状态迁移与 job 写入/作废（version 比对）同一 PG 事务 | 支持（adapters 可在业务事务内建 job："the job exists if, and only if, the change commits"），但作废/version 语义需绕行其 API | 同库但「与业务同事务写」非一等能力（**待核实**；Redis 版结构上不可能） | 工作流模型外置，非同事务 |
| 新依赖 / 运维面 | **0 新外部依赖**（@nestjs/schedule 为 NestJS 官方包，MIT，无存储模型）或等价 interval；无新进程 | +pg-boss 运行时依赖（MIT，**单人维护**——作者自述 "It is maintained by one person"；活跃：文档 2026-10-01 更新、近期持续发版） | +bullmq 依赖（MIT）；**PG 后端 2026 年 7 月末随 v6 发布、2026-09-27 才官宣**，官方自述 "Redis remains the default and the most battle-tested option" | +Go 服务集群（Frontend/History/Matching/Worker）+ 专用数据库 +（可选）Elasticsearch——重运维，V1 团队规模不匹配 |
| 控制台/可见性 | admin 运维视图 + log 重放 + M0-9 指标（见决策表末行） | 可选 `@pg-boss/dashboard` 监控面板 | Taskforce.sh 商业面板/托管 | 自带 Web UI（Temporal 强项） |

## 理由

1. **机制零变更（首要）**：I2 模块文档已完整设计 schedule_jobs 表、抢占 SQL、幂等回查、重试退避、ROOM_OPEN 高优先级队列、log 重放——自研只是把「执行器+节拍器」落成 TS 代码，文档驱动纪律（DDL 以模块文档为准）完整保留。四个候选中只有自研不动 I2 的 DDL 主导权。
2. **零新依赖、零 schema 冲突**：pg-boss/BullMQ 均自带 schema 与迁移机制（pg-boss 在 `start()` 自动迁移、BullMQ 显式 `runMigrations` 且不支持降级），与 ADR-0002 定下的 Flyway SQL-first + CI validate 产线纪律直接摩擦——schema 演进主导权让渡给外部库，「DB 表设计以模块文档为准」被架空。
3. **PG 事务一致性是 I2 语义刚需**：job 必须与业务状态迁移同事务写/作废（version 比对作废）——自研天然成立；pg-boss 虽支持事务内建 job，但其存储模型仍要求以 `pgboss.*` 表为执行事实源；BullMQ Redis 版结构上不可能同事务，PG 版未宣传该能力（待核实）；引入 Redis 承载调度语义直接违反架构 §4.5「DB 到期任务表为事实源」。
4. **同进程消解 D18**：调度器进 NestJS 进程后，原「HTTP 回调端点鉴权+内网隔离 vs Java shim executor」跨进程触发通路议题不复存在；多实例部署下 SKIP LOCKED 天然多节点安全（架构 §7.1「调度执行器多节点」表述无需改动）。
5. **可见性不依赖调度器自带 console**：XXL-Job 控制台的功能面（任务列表/状态/手动重跑）由 I2 §5 运维视图接口 + admin 页面、schedule_job_log 重放、H3/H4 告警工单与 M0-9 观测指标覆盖——V1 规模（日活千级、19 种 job、吞吐 ≥500 job/s 指标）不需要独立调度控制台进程。
6. **弃用 XXL-Job 的理由**：Java 系平台（ADR-0001 已注记异构风险），保留意味着 JVM 进程、独立部署、跨进程触发通路三项长期成本；经 DB 到期任务表解耦虽无代码耦合，但既然执行器层必须 TS 化，解耦层价值随平替消失。
7. **未选库的附带理由**（非主因）：pg-boss 单人维护（bus factor）；BullMQ PG 后端过新（官宣约 2.5 个月，battle-tested 程度低、处理吞吐官方自测低 Redis 约 1.5–2 倍）；Temporal 为重编排平台，V1 无 saga/长工作流诉求，运维面与团队规模错配。

## 影响与回写

- **架构（docs/02）**：§2.2 分层图（XXL-Job → 自研TS调度器）、§2.3 调度行（选型改自研 + 裁决注记）、§4.5 前两条（执行层改自研口径；「触发通路待裁决」条改已裁决消解）；版本 v2.1→v2.2（修订记录）。
- **docs/04**：§8-18 改已裁决注记；版本 v1.3→v1.4；输入引用架构 v2.2。
- **docs/05**：§5.1 W1 行 I2 裁决门改「已裁决（ADR-0003）」；§11 D18 行关闭（参照 D17 已裁决格式）；版本 v1.4→v1.5；输入引用架构 v2.2 / 04 v1.4。
- **I2 模块文档**：§11 待澄清点改已裁决注记（R-01~R-04 与 §3/§4 设计不变）。
- **ADR-0001**：风险与待办 XXL-Job 注记补「已由 ADR-0003 关闭」。
- **docs/modules/README.md 与 docs/03 头部**：对架构文档的版本引用同步 v2.2（README 同时把 04 引用同步 v1.4）。
- **docs/plans/（M0 复审报告、M0 执行计划）**：其中 D18 提醒按 M0 时点历史快照保留，不回改。
- **代码零改动**：services/core 尚无调度实现（migrations V1–V3 无 schedule_jobs 表），I2 未开工——裁决落在文档层恰逢其时（M1-W1 施工前），无代码迁移成本。

## 风险与翻转代价

- ⚠ 选型为 AI 推荐决策（用户授权自主推荐，可翻转）；翻转窗口最好在 I2 施工验收前（M1-W1）。
- 自研调度器无社区库的现成 battle-tested 面（重试退避/监控面板）——缓解：I2 §9 TDD 清单已覆盖（抢占并发/回查幂等/作废生效/开房优先级/重试退避五项），§10 验收含双执行器 100 job 压测；实现面收敛在 I2 单模块（scheduler provider + 执行器注册表 + 19 种 job 映射）。
- 节拍器为进程内存态：实例全部宕机则扫描停摆——事实源在 DB，重启后逾期 PENDING 自然被捞取补执行（misfire 自愈）；配合架构 §7.2「schedule_jobs 积压/逾期 >60s 告警」与多副本部署，单实例故障不停摆。
- 若 V2+ 出现跨服务工作流编排/saga 诉求，再评估 Temporal（重编排）或 pg-boss（PG 同库队列生态）——翻转代价：调度器内聚于 I2 单模块，替换时 job 写入/作废语义需重映射（type+ref 幂等键 → 库 API），属单模块重构，不外溢其他 12 模块。
- @nestjs/schedule 若被弃用换等价 interval，或直接用原生 setInterval + 优雅停机——均为 I2 内部实现细节变化，不构成决策翻转。

## 来源

- pg-boss 仓库（MIT、"maintained by one person"、SKIP LOCKED、事务内建 job、Node 22.12+/PG 13+）：https://github.com/timgit/pg-boss
- pg-boss 官方文档（首次 start() 建自有 schema、"the job exists if, and only if, the change commits"、多进程+SKIP LOCKED、instance table）：https://pgboss.io/introduction
- pg-boss schema 结构（`pgboss.job` 分区表 / `pgboss.schedule` / `pgboss.version`、schema v44、start() 自动迁移）：https://github.com/timgit/pg-boss/releases ；https://nerdleveltech.com/drizzle-orm-pg-boss-atomic-transactions-tutorial ；https://agledger.ai/blog/pg-boss-production-lessons
- pg-boss npm（latest=12.37.1、MIT）：https://registry.npmjs.org/pg-boss
- BullMQ v6 PostgreSQL 官宣（v6 2026 年 7 月末发布、2026-09-27 官宣、开源 `pg` 驱动可选安装）：https://bullmq.io/news/260927/bullmq-v6-postgresql
- BullMQ PG 后端文档（默认 `bullmq` schema、表+SQL 函数、`runMigrations`、**schema 降级不支持**、"The Redis backend remains the default and the most battle-tested option"、处理吞吐约低 1.5–2×）：https://docs.bullmq.io/guide/postgresql
- BullMQ Job Scheduler（`upsertJobScheduler` 替代弃用的 `repeat`）：https://docs.bullmq.io/guide/jobs/repeatable ；https://sevic.dev/notes/bullmq-cronjobs-nodejs
- BullMQ npm（latest=6.3.14、MIT、可选 peerDeps pg/redis/ioredis）：https://registry.npmjs.org/bullmq/latest
- @nestjs/schedule（NestJS 官方任务调度、动态 API、无持久化——动态任务重启即失、多实例各自执行）：https://docs.nestjs.com/application/task-scheduling ；https://stackoverflow.com/questions/73130008/will-nest-js-dynamic-cron-jobs-be-deleted-after-restart-shutdown ；npm（v12.0.2、MIT、peerDeps @nestjs/core ^11||^12）：https://registry.npmjs.org/@nestjs/schedule/latest
- Temporal 自托管复杂度（Frontend/History/Matching/Worker 服务集群+数据库+可选 ES、HA 需专门投入）：https://kestra.io/resources/infrastructure/temporal-alternatives ；https://temporal.io/resources/on-demand/mastering-self-hosted-temporal-clusters ； practitioner 体验：https://www.reddit.com/r/ExperiencedDevs/comments/1eoor5o/have_you_used_temporalio_if_so_what_were_your
- Temporal vs BullMQ 定位（重编排 vs 轻队列）：https://www.booleanbeyond.com/insights/temporal-vs-bullmq-ai-workflow-orchestration
