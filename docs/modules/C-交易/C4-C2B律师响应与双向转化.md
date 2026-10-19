# C4 C2B 律师响应与双向转化

> 域：C-交易 ｜ 架构模块：trade ｜ V1 ｜ P1 ｜ 阶段：②
> 上游：C2（PENDING_LAWYER）、I2（12h 超时 job） ｜ 下游：F2（退款）、G1（拒绝/超时 -5）、I1（通知）、C1（履约 Session）、H1（接单响应统计源） ｜ 技能：P0六件套 + lj-domain-rules

## 1. 职责与边界
- 做：律师 12h 确认/拒绝（超时自动拒绝）；确认后生成履约 Session（复用 C1 表）；认领转化 C2B→B2C。
- 不做：报名迁移的支付重算（快照沿用）；通知执行（I1）。

## 2. 功能点
- 接单大厅列表（已选定自己+时间段+子范围的 C2B 任务）
- 确认 → 生成 mode=C2B 的 Session + 新建 enrollment 行迁移
- 拒绝/超时 → 全额退款 + 律师信用 -5
- 认领转化：高需求 C2B → B2C 场次；原任务 CONVERTED；参与者快照价迁移；新加入按 B2C 价；24h 退款窗
- 接单响应统计查询面（12h 确认时长，口径=H4）供 H1 实力档案公开面聚合（2026-10-16 增量）

## 3. 领域模型
复用 sessions（mode=C2B）、group_buys（status=CONVERTED）、enrollments（新建行 + prev_enrollment_id 回链，旧行置 CONVERTED_OUT）。
转化迁移事务：GroupBuy→CONVERTED + 新 Session 创建 + B2 新段核验 + 每参与者新建 enrollment（复制快照）。

## 4. 状态机
见 C2 §4（PENDING_LAWYER 分支）+ CONVERTED 分支：转化后 24h 内被迁移用户可申请退款（F2 原因=CONVERT_REFUND）。

## 5. 接口契约
| GET  | /lawyer/group-buys?status=PENDING_LAWYER | - | 待确认列表（含子范围/标签/截止） | - | 否
| POST | /group-buys/{id}/confirm | - | {session_id} | 409 NOT_REACHED | 幂等键=gb
| POST | /group-buys/{id}/reject | {reason?} | {status} | 409 NOT_PENDING | 幂等键=gb
| POST | /group-buys/{id}/convert | {capacity?, price 覆盖?} | {session_id} | 409 NOT_CONVERTIBLE | 幂等键=gb
| GET  | /lawyer/response-stats?from=&to= | 内部（H1 实力档案聚合） | {samples, avg_confirm_minutes} | - | 否（2026-10-16 增量；口径=H4）

## 6. 领域事件
- 生产：LawyerConfirmed{gb_id, session_id}；LawyerRejected{gb_id, timeout:bool}（→G1 -5、F2 全额退款）；GroupBuyConverted{gb_id, session_id}（→I1 通知+24h 窗、F2 受理）。
- 消费：GroupBuyReached（I2 投 12h job）；ScheduleJobFired（超时 → 自动拒绝）。

## 7. 业务规则
- R-01 12h 未响应=自动拒绝；拒绝/超时全额退款+律师信用-5 ｜PRD §7.2.5
- R-02 转化：参与者维持快照价（新建行迁移，禁 UPDATE）；新加入按 B2C 定价 ｜PRD §6.4
- R-03 转化通知已参与用户，24h 内可申请退款 ｜PRD §6.4
- R-04 rooms.session_id 统一指向履约 Session（mode=C2B 也一样）｜架构 §4.1

## 8. 非功能要求
- 迁移事务原子（多参与者 enrollment 批量新建 + Session + GroupBuy 状态同事务；失败全回滚）。

## 9. AI 开发标准（本模块附加）
- TDD：12h 边界（job 提前/延迟）、迁移事务回滚注入、24h 窗边界；
- 禁止：UPDATE 已有 enrollment 行做迁移（审计链铁律）。

## 10. 验收清单
- [x] 超时自动拒绝 + G1 事件 + 全员退款（F2 桩）（**v1.x 勾账（M2-W2 T4）**：commit 39287c6，超时 executor 既有回归+reject API 显式路径同构（LAWYER_REJECTED timeout 双路）；G1 -5 真链已验；F2 全额退款消费=终审 I-1 登记（M1 遗留留位）列 M2-W3 批首项，巡检①类超 10min 告警兜底在位，task-4-report §6-5）
- [x] 转化后旧行 CONVERTED_OUT/新行 prev 回链完整（证据：commit 39287c6——旧行仅 pay_status 翻转（业务 11 列逐字不动用例）+新行快照逐字复制+prev_enrollment_id 回链；group-buy-response.service.spec）
- [x] 被迁移用户 24h 内退款成功、25h 被拒（证据：commit 39287c6——CONVERT_WINDOW 受理（SQL 侧单钟 now()-created_at<=24h）；25h 拒用例；修复环 M-1 双钟混用已消）
- [x] 转化事务中段失败全回滚（注入）（证据：commit 39287c6——session 型 INSERT BEFORE 触发器真注入，七面零残留断言+清除后重试成功，非 mock）

## 11. 待澄清点
- 无（B2C 转化场次的 capacity 由律师在 convert 时定，默认=sub_max）。