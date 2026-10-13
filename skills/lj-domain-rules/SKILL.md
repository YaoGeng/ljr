---
name: lj-domain-rules
description: 律聚人领域规则技能。写 trade/schedule/pricing/fulfillment/identity 模块代码、设计表结构或状态迁移前必读。触发词：状态机、守卫、Outbox、发件箱、幂等、时间段锁、slot_lock、价格快照、金额 NUMERIC、schedule_jobs、成团、报名、改期、改价。含四大机制（状态机守卫/Outbox/幂等/B2 时间段锁）与 M0-4 横切基座 API 对齐。
---

# LJ 领域规则（lj-domain-rules）

> 事实源：docs/02-架构设计.md（v2.1）§2.1/§4/§5.1；基座 API：services/core/src/infrastructure/、packages/shared/src/。
> 每条规则标注架构章节号。本技能与架构文档修订**同 PR 更新**（docs/modules/README.md 同步机制）。

## 触发时机

agent 开始写以下任一模块的代码/DDL/测试时自动装载：trade、schedule、pricing、fulfillment、identity（含注销/进件）。做跨模块事件设计或写守卫 SQL 时同样装载。对应模块文档头部的「必载技能」引用本技能。

## 四大机制（发现缺失即 BLOCKER）

### 1. 状态机守卫（架构 §4.1、§9）

- 所有状态迁移必须经守卫并写 `state_transition_log` 落库，供审计、对账与指标计算——**禁止散写 status 字段**（架构 §9「状态机膨胀」行、AGENTS.md 硬约束）。
- 架构 §4.1 定义的状态机全集（迁移表以架构原文为准，不得自行增删状态）：
  - B2C 场次：CREATED→FULL→CONFIRMED→OPEN→IN_SERVICE→FINISHED→HOLD→SETTLED；CREATED→FAILED→REFUNDED；任意→CANCELLED→REFUNDED（+违约金）
  - C2B 拼团：PUBLISHED→REACHED→PENDING_LAWYER(12h)→CONFIRMED（生成履约 Session）；PUBLISHED→EXPIRED→REFUNDED；PENDING_LAWYER→REJECTED→REFUNDED(+律师信用-5)
  - 改期：申请(开始前≥2h)→律师确认(12h)→同一事务完成迁移
  - 1对1 订单：PAID→ACCEPTED→IN_SERVICE→FINISHED→SETTLING→SETTLED；PAID→LAWYER_TIMEOUT→REFUNDED
  - 账号注销：申请→冷静期→资产清算→执行删除
  - 律所进件：提交→机构审核→生效→变更→停用（架构 §3.3-3）
- 基座 API（M0-4 已实现，直接用，勿重造）：
  - `createStateMachine(def)`：`services/core/src/infrastructure/state-machine/state-machine.ts` —— `assertTransition(from, to)` 纯校验，非法迁移抛 `AppError(StateIllegalTransition, 409)`；def 防呆（未声明状态/重复迁移声明构造即抛）。
  - `StateTransitionGuardService.assertTransition(machine, {entityId, from, to, uow})`：`state-transition-guard.service.ts` —— 合法迁移经 uow 同事务写 `allowed=true` 留痕（业务回滚则留痕一并消失）；非法迁移先用**独立连接**写 `allowed=false` 留痕再抛（拒绝审计不随业务回滚消失）。
- 标准事务模板（见 state-transition-guard.service.ts 头注释与 demo 模块示例）：
  `BEGIN; SELECT ... FOR UPDATE; guard.assertTransition(...); UPDATE ... WHERE status = from RETURNING *; recordOutbox(uow, evt); COMMIT;`
  条件更新（WHERE status = from RETURNING）兜底乐观并发：竞态以「先到者生效、后到者幂等无操作」收尾（架构 §9）。
- 迁移产生新事实时**新建行**，禁止 UPDATE 迁移历史：C2B CONFIRMED/C2B→B2C 转化/改期一律新建 enrollment 行并回链（`prev_enrollment_id`），原行置 CONVERTED_OUT/RESCHEDULED_OUT——保住支付↔报名审计链（架构 §4.1、§5.1 enrollments 注释）。

### 2. 事务性发件箱 Outbox（架构 §2.1）

- 领域事件与业务状态**在同一 DB 事务**写入 `outbox` 表；relay 进程投递 MQ（at-least-once）；消费者按事件 ID 幂等；投递失败进死信工单。
- 基座 API：`OutboxService.recordOutbox(uow, evt)` —— `services/core/src/infrastructure/outbox/outbox.service.ts`，写入 platform.outbox，事件类型即 topic，eventId 默认 randomUUID()（消费侧幂等键的事实源）。relay 见 `OutboxRelayService`（独立轮询）。
- 检查点：任何「先写业务表、再发 MQ」或「先发 MQ、再写库」的两步实现都是 BLOCKER——必须走 recordOutbox 同事务。

### 3. 幂等（架构 §2.1、§4.4、§6）

- 报名/支付接口幂等靠**唯一约束**（架构 §6「接口安全」行：报名/支付接口幂等（唯一约束））。
- Inbox（支付回调专用）：渠道流水号 + 业务幂等号**双唯一约束**，消费幂等、乱序容忍（非法状态迁移被守卫拒绝并告警）、死信入工单（架构 §2.1、§4.4）。
- `payment_orders.idempotency_key` 唯一约束（架构 §4.4）。
- 基座 API：`withIdempotency(key, fn)`（`packages/shared/src/idempotency.ts`）仅是**进程内**同键短路；跨进程/重启的幂等必须落 DB 唯一约束，进程内缓存只是防抖层，不得作为正确性依据（见 demo-order.consumer.ts 注释）。
- MQ 消费者必须按 eventId 幂等（at-least-once 语义下重复投递是常态）。

### 4. B2 时间段占用锁（架构 §4.2）

- **时间语义**：`time_slot_templates` 仅是按周重复模板（weekday+start）；被选择时物化为具体场次的**绝对时刻（timestamptz）**写入 `slot_locks.slot_start`。全局时区 Asia/Shanghai 单时区。部分唯一索引锁的是具体那一场，不是模板。
- **数据层**：`slot_locks(lawyer_id, slot_start, status)` 上 `(lawyer_id, slot_start)` 部分唯一索引覆盖 `status IN ('PENDING_PAYMENT','LOCKED','OCCUPIED')`——同一律师同一时间段物理上不可双写。DB 唯一约束是**唯一事实源**，Redis 锁仅作性能前置。
- **状态语义**：PENDING_PAYMENT（待支付）→ LOCKED（已锁定待履约）→ OCCUPIED（履约中）→ 释放。
- **同事务纪律**：B2C 创建/C2B 发布时在同一事务内插入 slot_lock + session/groupbuy；锁释放（流标/拒绝/超时/取消）与业务状态迁移在**同一 DB 事务**内同步 UPDATE，领域事件只用于通知下游——禁止「先终态业务、靠异步事件释放锁」。
- **reaper 兜底**：扫描「活跃锁 + 关联实体已终态」超阈值即释放并告警。
- **锁滥用防护**：C2B 发布即锁但绑定支付单——支付未完成为 PENDING_PAYMENT 并纳入唯一索引 + 10min TTL 自动释放；每用户对同一律师进行中锁 ≤1、全局 ≤3。

## 编码硬规则（逐条可执行）

| 规则 | 出处 | 违反级别 |
|---|---|---|
| 金额一律 NUMERIC(12,2) 物化列，发现 float/double/number 直存金额即 BLOCKER；JSONB 只存完整原文快照 | 架构 §4.3、AGENTS.md | BLOCKER |
| 时间一律 timestamptz（Asia/Shanghai），场次时刻存绝对时刻 | 架构 §4.2 | BLOCKER |
| 快照固化：支付下单时 unit_price/share_price/price_version 固化进 enrollments；改价只产生新 PriceVersion，不回写快照；group_buys.snapshot 为展示冗余，事实源是 enrollments 行 | 架构 §4.3 | BLOCKER |
| 调度事实源=DB 到期任务表 schedule_jobs，业务状态迁移同事务写入/作废 job；宽限期/缺席判定锚定**约定开始时刻**而非 opened_at | 架构 §4.5 | BLOCKER |
| credit_accounts 是信用唯一事实源（CreditEvent 不可变流水）；lawyer_profiles.credit_score 仅为读缓存，禁止在缓存上做判定 | 架构 §4.7 | BLOCKER |
| 一个功能模块只写一个架构 schema 的表；跨模块取数走接口或事件，发现要跨表 join 即停下在 PR 提出 | 架构 §2.1/§3.2 | BLOCKER |
| B2C 截止前 30s 停止新建支付单；回调到达时实体已终态（FAILED/FULL/EXPIRED）→「已支付→自动退款→通知」兜底分支并写 state_transition_log | 架构 §4.1 | BLOCKER |

## 验收判据（可观察）

- 代码中出现裸写 `UPDATE x SET status = ?`（不经守卫、不写迁移日志）→ 审查不通过。
- 金额字段出现 float/real/double/未定精度 numeric → 审查不通过。
- 锁/报名/支付的并发正确性仅靠应用层判重（无 DB 唯一约束/条件更新）→ 审查不通过。
- 事件发送不在业务事务内（无 recordOutbox）→ 审查不通过。

## 与模块文档的联动

- 施工规格在 `docs/modules/<域>/<ID>-*.md`：本技能给机制与红线，模块文档给 DDL/接口/事件/R-xx 细则；冲突时以架构文档与模块文档为准并回写本技能。
- 模块文档头部「必载技能」列出本技能的，其 §9 AI 开发标准按本技能红线执行；模块 §10 验收清单的并发/幂等用例按 §四机制设计。
- 架构 §4/§5 修订 → 同 PR 更新本技能（技能指南 §6 同步机制）。

## 待澄清

无（架构未覆盖且重要的点，按纪律记入 docs/04 §8，不在本技能内发明）。
