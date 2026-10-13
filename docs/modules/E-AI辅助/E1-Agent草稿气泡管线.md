# E1 Agent 草稿气泡管线

> 域：E-AI辅助 ｜ 架构模块：agent-assist（独立服务） ｜ V1 ｜ P0 ｜ 阶段：②（脱敏层①并行）
> 上游：D5（房间消息 MQ）、E3（知识库/RAG） ｜ 下游：律师端（WSS 气泡推送）、H4（采用率指标）、E2（待办） ｜ 技能：P0六件套 + lj-data-security + lj-compliance-guards

## 1. 职责与边界
- 做：草稿生成管线（脱敏→意图→RAG→LLM→气泡）；律师动作记录（AgentReviewLog）；多用户并行；敏感话术硬拦；降级显式态。
- 不做：消息发送（发送走 D5 律师消息链路，物理隔离）；知识库管理（E3）。

## 2. 功能点
- 消费房间用户消息（MQ，按 room_id 分区有序）→ 每用户最新问题去重合并
- 管线：实时脱敏层（≤1s）→ 意图识别/聚类（≤1s）→ RAG 检索（≤2s）→ LLM 草稿（≤4s）→ WSS 推律师端气泡（总 P95 ≤8s）
- 律师动作：直接发送（内容作为律师消息提交 D5）/修改后发送/丢弃
- 降级：LLM 故障 → 律师端显式"AI 辅助不可用"，不阻塞手打

## 3. 领域模型
drafts(
  id bigserial PK, room_id bigint NOT NULL, target_user_id bigint NOT NULL,
  question_digest text NOT NULL,               -- 脱敏后问题摘要
  content text NOT NULL,                       -- 草稿（含"AI 辅助，仅供参考"标记）
  placeholders jsonb,                          -- 占位符→原文映射（仅律师端展示用，不入 LLM）
  status varchar(12) NOT NULL,                 -- PENDING|SENT|EDITED_SENT|DISCARDED|EXPIRED
  answered boolean NOT NULL DEFAULT false,     -- 待办标记（E2）
  created_at, replied_at
)
agent_review_logs(id PK, draft_id, action varchar(12), edited_content text NULL, review_ms int, sent_at)

## 4. 管线流程
MQ 消息 → 脱敏层（NER+规则：姓名/证件/电话/地址→占位符，同训练管线同源）→ 敏感话术硬拦（承诺结果/包赢类词表 H5：命中即不生成、返回拦截提示）→ 意图/聚类 → RAG（pgvector，E3 知识库）→ LLM（境内供应商 ⚠）→ 气泡推送（占位符在律师端还原显示）→ 律师动作 → AgentReviewLog。

## 5. 接口契约
| POST | /drafts/{id}/action | {action: send|edit_send|discard, edited_content?} | {status} | 409 EXPIRED | 幂等键=draft+action
| WSS  | lawyer/drafts | 推送 | {draft_id, target_user, question_digest, content, placeholders} | - | -
健康检查：GET /agent/health（降级态透出）。

## 6. 领域事件
- 生产：DraftGenerated{room_id, draft_id, latency_ms}；DraftActioned{action, review_ms}（→H4 采用率、E2 待办）。
- 消费：MessageSent（D5）。

## 7. 业务规则
- R-01 隔离铁律：草稿写路径与消息发送路径无共享写入点；发送=律师消息提交（经 H5 风控）｜PRD §7.2.7/§11.1、架构 §4.6
- R-02 实时脱敏：原文（含 PII）不得进 RAG/LLM；占位符技术 ｜架构 §4.6 合规 R4
- R-03 敏感话术硬拦：承诺结果/包赢不生成 ｜PRD §14.2、架构 §4.6
- R-04 草稿标注"AI 辅助，仅供参考"仅律师端可见 ｜PRD §7.2.7
- R-05 审查不可省略：Agent 输出永不直接进公屏 ｜PRD §7.2.7
- R-06 多用户并行：按 room 分区 + 最新问题去重合并 ｜PRD §7.2.7
- R-07 LLM 供应商硬约束：境内/不出境/输入不留存不训练/DPA ｜架构 §1.3-5

## 8. 非功能要求
- 总延迟 P95 ≤8s（各段打点：脱敏/意图/检索/生成）；LLM 故障率告警；降级态 UI 明确。

## 9. AI 开发标准（本模块附加）
- TDD：脱敏层单测（PII 词表全命中/漏杀回归集）、硬拦词表、隔离验证（草稿路径无法写 messages 表——架构级断言）、延迟预算各段打点断言；
- 禁止：原文进提示词；Agent 直发消息；境外 LLM SDK 引入（合规红线）。

## 10. 验收清单
- [ ] 脱敏层：PII 回归集 0 漏杀（进入 LLM 的载荷抽检断言）
- [ ] 敏感话术命中不生成
- [ ] 发送动作走 D5 律师链路（隔离断言通过）
- [ ] 降级态律师端可见且手打不受阻
- [ ] P95 ≤8s（压测：10 房间×5 用户并发提问）
- [ ] AgentReviewLog 三动作+耗时落库（H4 可算采用率）

## 11. 待澄清点
- ⚠04§8-11 LLM 供应商选型（管线以适配器隔离，切换不改主流程）。