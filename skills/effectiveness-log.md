# 技能效果日志（effectiveness-log）

> 口径：技能指南 §9.3——agent 完成任务后标注该 skill 正/负效果（触发是否及时、规则是否被引用、是否误触发）。
> 首条为 M0-6 触发验收（docs/plans/M0-技能触发验收记录.md）；后续各自建技能按 §9.3 在本文件追加条目（或按需分技能目录维护），退役评估以本日志为准（连续 4 周零触发且任务域仍活跃 / 负效果修复两次未果 / 上游停更超 6 个月且无 fork 接管）。

## 2026-10-13 ｜ M0-6 技能体系就位（首次装载批次①）

| 技能 | 触发时机 | 效果 | 备注 |
|---|---|---|---|
| test-driven-development | 任务简报即要求 TDD 式作业；本次为文档/技能写作任务，无产品代码——专项验收任务中触发 | 正 | 验收任务以 RED→GREEN 循环执行并留证（验收记录 A-3） |
| systematic-debugging | 验收任务构造「两个候选根因」的 bug 场景触发 | 正 | 先产出假设清单并逐一证伪后才改代码（验收记录 A-1） |
| verification-before-completion | 本任务完成声明环节触发 | 正 | 完成声明附 lint/test 执行证据（验收记录 A-2 + task-5 报告 §7） |
| writing-plans | 本任务按 M0 计划 task-5-brief 施工（计划先于执行） | 正（被动引用） | 计划由上游 M0 计划文档承载，本次未新写计划 |
| requesting-code-review / receiving-code-review | M0 无 payment 域代码，交叉审查门自 M1 起（M0 计划口径） | 未评估 | 装载待用；行为签名待批次①交易域施工验证 |
| lj-domain-rules | 试金石：读 C3 守卫 SQL 节前装载 | 正 | 幂等键/守卫/竞态兜底三要点复述成功，规则带架构章节号被引用（验收记录试金石节） |
| lj-payment-invariants | 同上（与 lj-domain-rules 联合装载） | 正 | §7.2 五类资损不变量与 Inbox 双唯一被逐字引用 |
| lj-compliance-guards / lj-data-security / lj-test-matrix | 本次仅装载入仓，未在编码任务中触发 | 未评估 | 触发词已按模块域写全，待对应域施工验证 |

负效果与误触发：本次无。待澄清：agent-scan 本机源缺失未 vendor（manifest pending 项）。
