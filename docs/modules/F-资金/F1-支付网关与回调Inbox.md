# F1 支付网关与回调 Inbox

> 域：F-资金 ｜ 架构模块：payment（独立服务） ｜ V1 ｜ P0 ｜ 阶段：①
> 上游：C3/C2/D6（下单）、F2/F3（退款/分账指令）、A3b（进件/保证金指令） ｜ 下游：C3（状态推进）、F2/F3、H3（死信/对账差异工单）、H4 ｜ 技能：P0六件套 + lj-payment-invariants（交叉审查强制）

## 1. 职责与边界
- 做：最薄协议适配（验签/证书/报文转换）；双通道抽象（微信电商收付通主+支付宝直联备）；支付单生命周期指令（下单/冻结/续冻/解冻分账/退款/部分退款）；回调验签→Inbox 投递；金额 cash/points 拆分；对账文件拉取。
- 不做：业务状态机（Core 推进）；退款规则（F2）；分账构成（F3）。

## 2. 功能点
- 统一支付接口（通道无关）；通道健康与切换
- Inbox：渠道流水号+业务幂等号双唯一；乱序容忍；死信工单
- 支付单金额模型：cash_amount + points_amount = 应付（积分部分下单时 F4 冻结核销）
- 保证金/待结算账户指令接口（A3b/F3 用）
- T+1 对账文件拉取与本地 SplitLedger 核对

## 3. 领域模型
payment_orders(
  id bigserial PK, biz_type varchar(20) NOT NULL,  -- enroll|ooo|ooo_diff|deposit
  biz_id bigint NOT NULL, channel varchar(16) NOT NULL,
  cash_amount numeric(12,2) NOT NULL DEFAULT 0, points_amount int NOT NULL DEFAULT 0,
  total numeric(12,2) GENERATED ALWAYS AS (cash_amount + points_amount/100.0) STORED,
  status varchar(16) NOT NULL,                -- CREATED|FROZEN|PAID|REFUNDING|REFUNDED|SPLIT|CLOSED
  idempotency_key varchar(64) NOT NULL UNIQUE, channel_txn_no varchar(64) NULL,
  split_detail jsonb NULL, created_at, paid_at
)
inbox(id PK, channel_txn_no varchar(64) NOT NULL UNIQUE, biz_idempotency_key varchar(80) NOT NULL UNIQUE,
  -- 幂等号构成 = {业务幂等号}:{channel_event_type}（如 enroll-123:PAY_SUCCESS / enroll-123:REFUND_SUCCESS）
  -- 同一支付单的不同类型回调（支付成功/退款成功）互不误杀，同类型重复回调去重
  payload jsonb NOT NULL, status varchar(12),  -- RECEIVED|CONSUMED|DEAD
  received_at, consumed_at)
split_ledgers(id PK, period date, channel, direction, amount numeric(12,2), status, diff_reason text NULL)

## 4. 关键流程
下单：Core 提交（含幂等号/金额拆分）→ 通道预下单/冻结 → 返回支付参数。
回调：通道回调 → 验签 → Inbox 插入（双唯一去重）→ MQ → Core 消费推进（非法迁移守卫拒绝+告警→死信工单 H3）。
对账：T+1 拉账单 → 与 payment_orders/split_ledgers 双向核对 → 差异工单（SLA 24h）。

## 5. 接口契约（对 Core）
| POST | /pay/orders | {biz_type, biz_id, cash_amount, points_amount, idempotency_key} | {payment_order, pay_params} | 409 DUP_KEY | 幂等键=idempotency_key
| POST | /pay/refund | {order_id, cash_refund, points_refund, reason, idempotency_key} | {refund} | 409 DUP | 幂等键
| POST | /pay/split | {order_id, splits[], idempotency_key} | {result} | 409 DUP | 幂等键
| POST | /pay/deduct | {lawyer_id, amount, from: settlement|deposit, idempotency_key} | {result} | 400 INSUFFICIENT | 幂等键
| POST | /callbacks/{channel} | 通道报文（验签） | 200/403 SIGN_FAIL | - | Inbox 去重

## 6. 领域事件
- 生产：PaymentCallbackInboxed{biz_idempotency_key, event}（→Core/C3）；ReconciliationDiffFound{period, detail}（→H3）；ChannelDegraded{channel}（→告警/切换）。
- 消费：无（指令型服务）。

## 7. 业务规则
- R-01 资金不过平台账户：仅指令+对账 ｜PRD §9.5/§14.2、架构 §1.3-1
- R-02 幂等：idempotency_key 唯一约束；回调 Inbox 双唯一去重 ｜架构 §4.4
- R-03 退款还原：现金原路退；积分部分还原积分（F4 核销回冲）⚠04§8-1 联动 ｜架构 §4.4、本文档新增口径
- R-04 对账 T+1，差异工单 SLA 24h ｜架构 §4.4
- R-05 沙箱限定：仅测试商户号可封装 agent 工具；生产通道永不封装 ｜技能指南 §4.3

## 8. 非功能要求
- 回调处理 P95 ≤500ms；验签失败率告警；单通道故障 5min 内切换（双通道抽象）。

## 9. AI 开发标准（本模块附加）
- 交叉审查强制 + lj-payment-invariants 全清单核对；
- TDD：幂等（同键重复回调一次生效）、**同单多事件（支付成功+退款成功两条回调均入箱不误杀）**、乱序（退款先到被守卫拒）、cash/points 拆分不变量（cash+points/100=total）、验签失败 403；
- 禁止：生产证书/密钥入代码或 skill；金额 float；绕过 Inbox 直推业务。

## 10. 验收清单
- [ ] 同幂等键重复下单/重复回调恰一次生效
- [ ] 乱序回调被守卫拒绝并死信工单（H3 桩）
- [ ] 拆分不变量在所有接口成立
- [ ] 对账差异生成 24h SLA 工单
- [ ] 通道切换演练（模拟主通道 5xx）

## 11. 待澄清点
- ⚠04§8-1 备付金定性影响积分退款口径（R-03 已按"还原积分"设计，若产品选 30% 现金退款需回改）。