# C2 C2B 发起拼团

> 域：C-交易 ｜ 架构模块：trade ｜ V1 ｜ P0 ｜ 阶段：①
> 上游：B1/B2（选段+PENDING_PAYMENT 锁）、B3（默认总价+接受范围）、E3（问题树）、G1（限制校验） ｜ 下游：C3（加入支付）、C4（律师确认）、F1（发起人支付单） ｜ 技能：P0六件套 + lj-domain-rules + lj-test-matrix

## 1. 职责与边界
- 做：C2B 拼团任务发布全流程（选段→子范围→分摊额→问题标签→截止→发布锁快照）；一键重新发起；取消重发。
- 不做：成团支付（C3）；律师响应（C4）；问题树内容（E3 提供）。

## 2. 功能点
- 子范围选择（accept_min..accept_max 内）；分摊额实时计算展示
- 结构化问题标签引导（消费 E3 GET /specialty/question-tree，内置引导 UI 多选+补充）
- 截止时间（默认开始前 24h ⚠）；发布即锁价格快照
- 一键重新发起（复制原任务参数为新任务；原任务不可修改）

## 3. 领域模型
group_buys(
  id bigserial PK, initiator_id bigint NOT NULL, lawyer_id bigint NOT NULL,
  specialty varchar(32) NOT NULL, slot_start timestamptz NOT NULL,
  sub_min smallint NOT NULL, sub_max smallint NOT NULL,
  share_price numeric(10,2) NOT NULL,          -- = session_total_default ÷ sub_min（发布时固化）
  question_tags jsonb NOT NULL, deadline timestamptz NOT NULL,
  status varchar(20) NOT NULL, lawyer_confirm_by timestamptz NULL,
  CHECK (sub_min <= sub_max)
)

## 4. 状态机（C2B）
PUBLISHED(拼团中) → REACHED(达 sub_min 锁人) → PENDING_LAWYER(12h) → CONFIRMED（生成履约 Session）
PUBLISHED → EXPIRED(截止未成) → REFUNDED
PENDING_LAWYER → REJECTED(拒绝/超时=自动拒) → REFUNDED
PUBLISHED/REACHED → CONVERTED（C4 认领转化）
守卫：发起人取消仅 PUBLISHED 且 joined<sub_min（有他人加入后不可单方取消，走协商/客服 ⚠未定义——列待澄清）。

## 5. 接口契约
| POST | /group-buys | {lawyer_id, specialty, slot_start, sub_min, sub_max, question_tags, deadline?} | {group_buy, share_price, payment_order} | 409 SLOT_TAKEN / 400 OUT_OF_RANGE / 403 RESTRICTED | 幂等键=user+slot_start
| GET  | /group-buys?specialty= | - | 列表（已加入数/倒计时/分摊额） | - | 否
| POST | /group-buys/{id}/cancel | - | {status} | 409 HAS_JOINED | 否
| POST | /group-buys/{id}/recreate | - | 新任务 ID | - | 幂等键=source_id

## 6. 领域事件
- 生产：GroupBuyPublished{id, lawyer_id, slot_start, sub_min, share_price}（→I2 截止 job + B2 PENDING_PAYMENT）；GroupBuyReached{id}（→I2 12h 确认 job）。
- 消费：EnrollmentPaid 计数达 sub_min → REACHED；LawyerConfirmed/Rejected（C4）。

## 7. 业务规则
- R-01 子范围必须在律师默认接受范围内 ｜PRD §6.3
- R-02 分摊额 = 默认场次总价 ÷ sub_min（发布时固化，律师改价不影响）｜PRD §6.3/§9.2
- R-03 快照锁定：加入用户按发布时 share_price 支付 ｜PRD §8.2
- R-04 子范围人数不可修改，只能取消后重新发起 ｜PRD §6.3/§9.2
- R-05 达 sub_min 即锁人；成团后不补不退 ｜PRD §8.1

## 8. 非功能要求
- 发布事务（B2 PENDING_PAYMENT 锁+插入+支付单创建）P95 ≤150ms；列表含倒计时（客户端计算+服务端 deadline）。

## 9. AI 开发标准（本模块附加）
- TDD：R-01 越界矩阵、R-02 分摊额精度（NUMERIC 除法保留 2 位、银行家舍入 ⚠舍入规则实现前确认）、R-04 不可变；
- 禁止：share_price 用 float；发布后 UPDATE 子范围字段。

## 10. 验收清单
- [ ] 子范围越界被拒（含边界 min/max）
- [ ] 发布后律师改价不影响 share_price（B3 联调）
- [ ] 未支付 10min 锁释放后他人可发布同段（B2 联调）
- [ ] 一键重新发起复制参数且原任务状态不变
- [ ] 达 sub_min 后新加入被拒（守卫）

## 11. 待澄清点
- ⚠04§8-14 截止延长；发起人在他人加入后的取消路径未定义（新增待澄清，建议走客服工单）。