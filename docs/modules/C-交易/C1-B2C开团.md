# C1 B2C 开团（含律师场次看板）

> 域：C-交易 ｜ 架构模块：trade ｜ V1 ｜ P0 ｜ 阶段：①
> 上游：B1（选段）、B2（加锁）、B3（默认价）、G1（停接限制校验） ｜ 下游：C3（报名）、D1-D4（履约）、H4（看板数据源）、H1（实力档案成团率聚合源） ｜ 技能：P0六件套 + lj-domain-rules + lj-test-matrix

## 1. 职责与边界
- 做：律师开团全流程（选段→配置→创建）；场次列表与详情（用户端）；B2C 状态机；律师侧场次数据看板接口。
- 不做：报名与支付（C3）；履约（D 域）；改价（C6 只管默认价变更）。

## 2. 功能点
- 开团配置页：自动填入默认价格与人数，律师可修改本次价格与人数（仅本次有效）
- enroll_deadline 设置（默认开始前 24h ⚠，律师可改）
- 用户端列表：律师、时间、计价方式、单价、已报名/还差几人、沟通形式（仅审核通过律师）；**卡片附律师实力摘要（执业年限/专长/信用分/成团率——批量调 H1 GET /lawyers/{id}/profile/summary，禁直查 identity/ops schema，2026-10-16 PRD §7.1.2 增量）**
- 律师场次看板：GET /lawyer/sessions/stats（报名率/成团率/到场率/1对1转化率；统计面同步供 H1 实力档案公开面聚合，口径=H4，2026-10-16 增量）

## 3. 领域模型
sessions(
  id bigserial PK, lawyer_id bigint NOT NULL,
  mode varchar(8) NOT NULL DEFAULT 'B2C',     -- B2C（C2B 确认后生成履约 Session 亦复用本表，mode=C2B）
  slot_start timestamptz NOT NULL,
  price_mode varchar(14) NOT NULL,             -- per_head|session_total
  unit_price numeric(10,2) NOT NULL,           -- 快照：per_head 单价 或 total÷capacity 分摊
  session_total numeric(12,2) NOT NULL,        -- 场次总价基数（违约金计算用）
  capacity smallint NOT NULL, joined smallint NOT NULL DEFAULT 0,
  enroll_deadline timestamptz NOT NULL, room_mode varchar(32) NOT NULL,
  status varchar(20) NOT NULL,                 -- 见状态机
  created_at timestamptz, CHECK (joined <= capacity), CHECK (capacity BETWEEN 2 AND 50)
)
CREATE INDEX ix_sessions_list ON sessions(status, slot_start);

## 4. 状态机（B2C）
CREATED(报名中) → FULL(满员锁人) → CONFIRMED → OPEN(到点) → IN_SERVICE → FINISHED → HOLD → SETTLED
CREATED → FAILED(截止未满) → REFUNDED
任意（受限）→ CANCELLED → REFUNDED（违约金流程 D4）
守卫：joined==capacity → FULL（原子守卫见 C3）；FAILED 仅由截止 job 判定；CANCELLED 走 D4 规则。

## 5. 接口契约
| POST | /sessions | {slot_start, price_mode, unit_price?, capacity, enroll_deadline?, room_mode} | {session} | 409 SLOT_TAKEN / 403 RESTRICTED(停接) | 幂等键=lawyer+slot_start
| GET  | /sessions?specialty=&lawyer=&from=&to= | 筛选 | 列表（仅 lawyer 审核 PASSED） | - | 否
| GET  | /sessions/{id} | - | 详情+剩余席位 | - | 否
| GET  | /lawyer/sessions/stats?from=&to= | - | {enroll_rate, group_rate, attendance_rate, ooo_rate} | - | 否（读 H4 聚合/读副本）

## 6. 领域事件
- 生产：SessionCreated{id, lawyer_id, slot_start, enroll_deadline}（→I2 预写截止/提醒 job）；SessionFull{id}；SessionFailed{id}（→F2 批量退款）。
- 消费：EnrollmentPaid（C3 守卫推进 FULL）；RoomClosed/D4 终态事件（推进 FINISHED 等）；ReviewSubmitted（G2——评分入列表排序因子）；LawyerProfileTakedown（H1——档案下架时卡片实力摘要隐藏/缓存失效，H1 R-07 缓存 TTL ≤5min）。

## 7. 业务规则
- R-01 开团配置仅本次有效，不改默认值 ｜PRD §6.2/§7.2.4
- R-02 满员即成团、成团后不收新报名 ｜PRD §8.1
- R-03 截止未满 → 流标 → 全额退款（F2）｜PRD §8.1
- R-04 session_total 基数：per_head 模式 = 单价×选定人数；total 模式 = 开团时总价 ｜PRD §8.6
- R-05 开团入口校验 G1 限制令（停接/连续违规）｜PRD §8.8

## 8. 非功能要求
- 列表 P95 ≤300ms（缓存 30s）；开团事务（B2 加锁+插入）P95 ≤100ms。

## 9. AI 开发标准（本模块附加）
- TDD（lj-test-matrix）：状态机全迁移矩阵、R-02 并发满员、截止边界；
- 禁止：joined 字段裸 UPDATE（仅 C3 守卫 SQL 路径）；状态绕过守卫直写。

## 10. 验收清单
- [ ] 并发开团同段仅一胜（B2 联调）
- [ ] 本次价格修改不影响 B3 默认值
- [ ] 截止 job 流标 + 全员退款指令（F2 桩）
- [ ] 停接律师开团被 403
- [ ] stats 四率出数（H4 数据源联调）
- [ ] takedown 后列表卡片摘要同步隐藏（LawyerProfileTakedown 消费，H1 联调=W3）

## 11. 待澄清点
- ⚠04§8-3 B2C 截止时间默认规则。