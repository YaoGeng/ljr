# A3b 律所进件

> 域：A-身份与账号 ｜ 架构模块：支付网关（进件子域，schema: payment——firm_merchants 状态机归支付网关持有，identity 只读） ｜ V1 ｜ P0 ｜ 阶段：①
> 上游：A3a（PASSED 触发）、F1（机构 API） ｜ 下游：F3（分账前置/暂停）、I2（年度复验 job）、H1（状态视图） ｜ 技能：P0六件套 + lj-payment-invariants

## 1. 职责与边界
- 做：律所在持牌机构的二级商户进件状态机；生效才可下发分账；对公账户变更→重新进件+变更期暂停分账；保证金专户冻结指令；年度复验。
- 不做：资质审核（A3a）；分账执行（F3）；保证金账务（F3/F4 台账，本模块只发冻结指令）。

## 2. 功能点
- 进件材料收集（对公账户、开户许可等）→ 机构提交 → 状态机跟踪
- 变更流程：账户变更 → SUSPENDED（分账暂停）→ 重新进件 → ACTIVE
- 年度复验（电商法 §27 核验义务）：I2 job 触发 → 复验 → 到期未复验 SUSPENDED

## 3. 领域模型（payment schema）
firm_merchants(
  id bigserial PK, firm_id bigint NOT NULL, channel varchar(16) NOT NULL,  -- wechat_ecom|alipay
  sub_mchid varchar(64), status varchar(24) NOT NULL,   -- SUBMITTING|IN_REVIEW|ACTIVE|CHANGING|SUSPENDED|STOPPED
  materials jsonb NOT NULL, verified_at timestamptz, reverify_due timestamptz,
  UNIQUE(firm_id, channel)
)
lawyer_deposits(id PK, lawyer_id, channel, escrow_amount numeric(12,2) NOT NULL, status varchar(16))  -- 专户台账（指令由 F1 通道）

## 4. 状态机
SUBMITTING→IN_REVIEW→ACTIVE→(CHANGING→ACTIVE | SUSPENDED | STOPPED)；SUSPENDED→ACTIVE（复验/变更完成）。
守卫：仅 ACTIVE 可作为分账接收方（F3 校验）；进入 SUSPENDED 即发事件（F3 暂停 + 挂起待结算）。

## 5. 接口契约
| 方法 | 路径 | 入参 | 出参 | 错误码 | 幂等
|---|---|---|---|---|---
| POST | /firms/{id}/merchant/submit | {channel, materials} | {status} | 409 DUPLICATE | 幂等键=firm+channel
| POST | /firms/{id}/merchant/change | {materials} | {status: CHANGING} | - | 否
| POST | /firms/{id}/deposit/freeze | {amount} | {escrow_status} | 400 INSUFFICIENT | 幂等键=firm+batch
机构回调（F1 承接转投）：进件审核结果 → 状态机推进。

## 6. 领域事件
- 生产：FirmMerchantActivated{firm_id, channel}；FirmMerchantSuspended{firm_id, channel, reason}；FirmMerchantReverifiedDue{firm_id, due_at}。
- 消费：LawyerAuditPassed（启动进件流程）；I2 复验 job 回调。

## 7. 业务规则
- R-01 分账前置：firm_merchants.status=ACTIVE 才可下发分账指令 ｜架构 §3.3-3/§4.4
- R-02 账户变更→重新进件+变更期暂停分账（SUSPENDED）｜架构 §3.3-3
- R-03 年度复验：每年 ≥1 次；到期未完成 → SUSPENDED ｜架构 §4.5、电商法 §27
- R-04 保证金托管：持牌机构侧专户，平台仅指令+台账，不自收 ｜架构 §1.3-1/§4.4、⚠04§8-4 金额

## 8. 非功能要求
- 进件状态变更实时通知律所（I1）；SUSPENDED 期间 F3 待结算挂起可见（H3 工单提醒处置）。

## 9. AI 开发标准（本模块附加）
- 交叉审查强制：本模块 PR 必须由持有 lj-payment-invariants 的 agent 交叉审；
- TDD：状态机矩阵、R-01 前置校验、R-03 到期停用；
- 禁止：materials 中明文账户密钥落日志；绕过状态机直改 status。

## 10. 验收清单
- [ ] 非 ACTIVE 状态分账指令被 F3 拒绝（联调）
- [ ] 账户变更触发 SUSPENDED 事件且 F3 收到（联调桩）
- [ ] 复验到期 job 触发事件（I2 联调）
- [ ] 保证金冻结指令幂等

## 11. 待澄清点
- ⚠04§8-4 保证金金额与缴纳时点。