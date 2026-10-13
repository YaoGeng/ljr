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

## 3. 领域模型
lawyer_profiles(
  id bigserial PK, user_id bigint UNIQUE NOT NULL,
  license_no_enc bytea NOT NULL,              -- 列加密
  license_no_blind_idx char(64) NOT NULL,     -- 防重复入驻检索
  firm_name varchar(128), firm_id bigint NULL,
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
- 生产：LawyerAuditPassed{lawyer_user_id, firm_id}；LawyerSuspended{lawyer_user_id, reason}。
- 消费：无。

## 7. 业务规则
- R-01 审核通过才出现在场次列表与接单大厅 ｜PRD §7.2.1
- R-02 3 个工作日 SLA（超时 H1 看板告警）｜PRD §7.2.1
- R-03 license_no 唯一（盲索引，防一人多号重复入驻）｜架构 §5.1
- R-04 律师账号默认同时具备用户身份 ｜PRD §3

## 8. 非功能要求
- 材料文件仅加密 OSS（I3），库内只存引用；审核操作全审计（H9）。

## 9. AI 开发标准（本模块附加）
- TDD：状态机守卫全迁移矩阵、盲索引唯一、重提版本；
- 禁止：license_no 明文日志；审核自动化判断（人工审核是产品规则，不做 AI 自动过审）。

## 10. 验收清单
- [ ] 未 PASSED 律师在 C3 列表不可见（联调）
- [ ] 状态机非法迁移被守卫拒绝并告警
- [ ] 重复 license_no 提交被 409
- [ ] 审核动作在 H9 审计可查

## 11. 待澄清点
- ⚠04§8-4 保证金金额（A3b 承接，本模块仅在 PASSED 后触发 A3b 流程）。