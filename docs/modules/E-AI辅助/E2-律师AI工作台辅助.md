# E2 律师 AI 工作台辅助

> 域：E-AI辅助 ｜ 架构模块：agent-assist ｜ V1（快捷回复/待办）+ V1.1（建议清单） ｜ P1 ｜ 阶段：④
> 上游：E1（drafts/管线旁路） ｜ 下游：律师端工作台 UI、H4 ｜ 技能：P0六件套

## 1. 职责与边界
- 做：快捷回复库（律师+专项维度，usage_count）；待办提示（未回应问题列表）；1对1 建议清单（V1.1）。
- 不做：草稿生成（E1）；知识库（E3）。

## 2. 功能点
- 快捷回复：增删改查、插入即计数、按专项过滤
- 待办：drafts.answered=false 的未回应问题列表 + 标记已处理
- 1对1 建议清单（V1.1）：E1 管线旁路识别深度需求意图 → one_on_one_suggestions（房间+用户+理由）→ 律师端列表

## 3. 领域模型
quick_replies(id PK, lawyer_id, specialty varchar(32), content text NOT NULL, usage_count int DEFAULT 0, enabled bool)
one_on_one_suggestions(id PK, room_id, user_id, reason text, status varchar(12), created_at)  -- V1.1

## 4. 关键流程
待办：E1 生成草稿（answered=false）→ 律师发送/丢弃 → true；列表按房间分组倒序。
建议清单（V1.1）：管线输出附加意图分类（深度服务信号：文书/合同/策略关键词）→ 写建议表 → 律师端列表可一键发起 1对1 邀请（I1 通知）。

## 5. 接口契约
| GET/POST/PUT/DELETE | /lawyer/quick-replies[/{id}] | CRUD | - | 400 EMPTY | 幂等键=id
| GET  | /rooms/{id}/pending-questions | - | [{target_user, question_digest, waited_ms}] | - | 否
| POST | /drafts/{id}/mark-answered | - | {answered} | - | 幂等键=draft
| GET  | /rooms/{id}/one-on-one-suggestions | - | 列表（V1.1） | - | 否

## 6. 领域事件
- 生产：QuickReplyUsed{id}（→H4 使用统计）。
- 消费：DraftGenerated/DraftActioned（待办状态维护）。

## 7. 业务规则
- R-01 高频问题快捷回复库 ｜PRD §7.2.7
- R-02 待办标记未回应用户问题 ｜PRD §7.2.7
- R-03 1对1 建议清单按提问记录生成 ｜PRD §7.2.7（V1.1 排期）

## 8. 非功能要求
- 待办列表 P95 ≤200ms；快捷回复插入计数异步（不阻塞输入）。

## 9. AI 开发标准（本模块附加）
- TDD：answered 状态机、计数并发、V1.1 意图规则表驱动；
- 禁止：建议清单直发用户（仅律师端列表+律师主动邀请）。

## 10. 验收清单
- [ ] 快捷回复 CRUD+计数正确
- [ ] 发送/丢弃后待办消失
- [ ] V1.1 建议只出现在律师端

## 11. 待澄清点
- V1.1 建议清单意图词表由 E3 配置（运营维护）。