# A3a 律师资质审核

> 域：A-身份与账号 ｜ 架构模块：identity + ops（schema: identity，审核操作面在 H1） ｜ V1 ｜ P0 ｜ 阶段：①
> 上游：A1 ｜ 下游：C3（审核通过才可见）、A1（授予 lawyer role）、H1（审核工作台） ｜ 技能：P0六件套 + lj-data-security

## 1. 职责与边界
- 做：执业证/律所授权/基本信息提交；人工审核状态机（3 工作日 SLA）；补充材料重提；停用/恢复。
- 不做：律所进件（A3b，支付网关 schema）；保证金（A3b）。

## 2. 功能点
- 提交资质材料（执业证号、执业证照片、律所授权书→加密 OSS）
- 状态：DRAFT → SUBMITTED → IN_REVIEW → PASSED / REJECTED(可重提) / SUSPENDED
- PASSED 联动：授予 lawyer role（事件→A1）、用户端可见（事件→C3）
- **执业年限登记（2026-10-16 增量，随 H1 实力档案）：审核时依据执业证信息核验并登记执业年限，供 H1 实力档案资质字段带出（PRD §7.2.1——资质字段随审核核验）；≥3 年+劳动法经验是招募筛选口径（PRD §11.3），不作为入驻审核硬门禁**
- **执业城市登记（2026-10-17 增量，双维度框架 D-BP8 翻转）：审核时随执业证/律所信息核验登记执业城市（V1=北京），场次城市默认源 + 同城筛选数据基础（PRD §7.2.1）**

## 3. 领域模型
lawyer_profiles(
  id bigserial PK, user_id bigint UNIQUE NOT NULL,
  license_no_enc bytea NOT NULL,              -- 列加密
  license_no_blind_idx char(64) NOT NULL,     -- 防重复入驻检索
  firm_name varchar(128), firm_id bigint NULL,
  city varchar(32) NOT NULL DEFAULT '北京',     -- 执业城市（2026-10-17 双维度框架；城市码口径 ⚠ 默认中文名称，W3-10）
  audit_status varchar(16) NOT NULL,          -- 上述状态集
  submitted_at timestamptz, audited_at timestamptz, auditor_id bigint,
  reject_reason text NULL
)
qualification_files(id PK, lawyer_id, file_ref text, kind varchar(32))  -- 指向 I3 加密 OSS

## 4. 状态机
DRAFT→SUBMITTED（提交）/ SUBMITTED→IN_REVIEW（H1 领取）/ →PASSED｜REJECTED / PASSED→SUSPENDED（H1）/ SUSPENDED→PASSED（恢复）。
守卫：REJECTED 重提需新材料版本号；PASSED 后材料修改变更重新进 SUBMITTED。

## 5. 接口契约
| 方法 | 路径 | 入参 | 出参 | 错误码 | 幂等
|---|---|---|---|---|---
| POST | /lawyer/qualification | {license_no, firm_name, files[]} | {status} | 409 ALREADY_SUBMITTED | 幂等键=user
| GET  | /lawyer/audit-status | - | {status, reason?} | - | 否
审核操作（运营）：见 H1 契约（POST /admin/lawyers/{id}/audit）。

## 6. 领域事件
- 生产：LawyerAuditSubmitted{lawyer_user_id, submitted_at}（进入 SUBMITTED 时发布——首次提交/重提/材料变更重提同口径，→H1 审核队列刷新）；LawyerAuditPassed{lawyer_user_id, firm_id}；LawyerSuspended{lawyer_user_id, reason}。
- 消费：无。

## 7. 业务规则
- R-01 审核通过才出现在场次列表与接单大厅 ｜PRD §7.2.1
- R-02 3 个工作日 SLA（超时 H1 看板告警）｜PRD §7.2.1
- R-03 license_no 唯一（盲索引，防一人多号重复入驻）｜架构 §5.1
- R-04 律师账号默认同时具备用户身份 ｜PRD §3
- R-05 执业年限随审核核验登记，供 H1 实力档案资质字段带出（2026-10-16 增量）｜PRD §7.2.1
- R-06 执业城市随审核登记（V1=北京），场次城市默认源 + 同城筛选基础（2026-10-17 双维度框架）｜PRD §7.2.1

## 8. 非功能要求
- 材料文件仅加密 OSS（I3），库内只存引用；审核操作全审计（H9）。

## 9. AI 开发标准（本模块附加）
- TDD：状态机守卫全迁移矩阵、盲索引唯一、重提版本；
- 禁止：license_no 明文日志；审核自动化判断（人工审核是产品规则，不做 AI 自动过审）。

## 10. 验收清单
- [ ] 未 PASSED 律师在 C3 列表不可见（联调）（后续联调：W3——isAuditPassed(lawyerUserId) 查询面已交付并测（非 PASSED 全态=false、材料修改/停用即翻转），C3 列表接入=W3 联调，task-3-report §四）
- [x] 状态机非法迁移被守卫拒绝并告警（证据：commits bb809a3..dbd6453，task-3-report §四——409 E_STATE_ILLEGAL_TRANSITION+STL allowed=false 留痕（独立连接），6×6 矩阵封闭性断言）
- [x] 重复 license_no 提交被 409（证据：commits bb809a3..dbd6453，task-3-report §四——E_LICENSE_NO_TAKEN 预检+唯一索引 23505 DB 事实源+竞窗显式复检用例）
- [ ] 审核动作在 H9 审计可查（后续联调：M4——现形态=每动作一行 STL+应用日志（无 PII）可查，H9 正式审计存储=M4；auditor_id 回填随 H1 鉴权接线绑定（R-W2-G 前置门），task-3-report §四）
- [ ] 执业年限随 PASSED 登记且 H1 可带出（2026-10-16 增量，随 H1 实力档案施工=W3）
- [ ] city 字段随 V31 迁移落库且审核登记（2026-10-17 双维度增量，随 W3 双维度批）

## 11. 待澄清点
- ⚠04§8-4 保证金金额（A3b 承接，本模块仅在 PASSED 后触发 A3b 流程）。