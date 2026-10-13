# H9 PIA 与合规审计

> 域：H-运营后台 ｜ 架构模块：ops ｜ V1 ｜ P1 ｜ 阶段：④
> 上游：A2/A4/D7/F4（触发点）、全后台操作 ｜ 下游：发布流水线（PIA 门禁）、H4 ｜ 技能：P0六件套 + lj-compliance-guards

## 1. 职责与边界
- 做：PIA 触发清单+评估模板+报告归档 ≥3 年；发布门禁（涉个人信息新功能 PIA 通过才可上线）；操作审计中心；训练授权撤回链路监督。
- 不做：审计日志产生（各模块写，本模块查询/归档）；发布执行（流水线）。

## 2. 功能点
- PIA 清单：实名、录音录像、训练、LLM 委托处理、3 年留存、导出、积分资金（新增功能对照清单判断是否触发）
- 门禁：发布流水线查询 PIA 状态（API），未过即拒绝部署
- 审计查询：按人/对象/时间/动作检索；导出审计报告
- 撤回链路监督：TrainingDataPurged 回执核对（撤回→删除完成时效监控）

## 3. 领域模型
pia_reports(id PK, feature varchar(64), trigger_items jsonb, status varchar(12),  -- DRAFT|APPROVED|REJECTED
  approver_id, report_ref text, created_at, archived_until date)   -- ≥3 年
审计查询走 audit_logs（全域共表）。

## 4. 关键流程
新功能立项 → 对照触发清单 → 需要则评估（模板）→ 审批 → 流水线校验（feature→pia APPROVED）→ 可部署。

## 5. 接口契约
| GET/POST | /admin/pia[/{id}] | 管理/审批 | - | - | 幂等键=feature+version
| GET | /pia/status?feature= | 流水线查询（门禁） | {status} | - | 否
| GET | /admin/audit-logs?actor=&object=&from=&to= | 审计检索 | - | - | 否

## 6. 领域事件
- 生产：PIAApproved{feature}（→流水线）。
- 消费：TrainingConsentRevoked/TrainingDataPurged（时效监控告警）；全域审计事件（归档）。

## 7. 业务规则
- R-01 PIA 触发清单与报告归档 ≥3 年 ｜架构 §6 合规 R12、PIPL §55/§56
- R-02 发布门禁：涉个人信息新功能 PIA 未过不进 prod ｜架构 §6
- R-03 审计：实名解密/录音调取/导出/评价凭证 join 全记录 ｜架构 §5.2/§6
- R-04 证照门禁（ICP/等保 ⚠04§8-15）：未完成不进 prod（与 PIA 门禁并列）｜架构 §1.3-7

## 8. 非功能要求
- 门禁查询 ≤50ms（流水线同步调）；审计查询仅副本。

## 9. AI 开发标准（本模块附加）
- TDD：门禁拦截（无 APPROVED 拒绝）、审计检索权限（合规角色）、归档保留；
- 禁止：门禁可被绕过（旁路部署）；审计日志可修改。

## 10. 验收清单
- [ ] 无 PIA APPROVED 的 feature 部署被门禁拒绝（流水线联调）
- [ ] 证照缺失同样拦截（⚠决策项落地后）
- [ ] 审计四类操作可检索
- [ ] 撤回→删除回执超时告警

## 11. 待澄清点
- ⚠04§8-15 证照清单（门禁配置项）。