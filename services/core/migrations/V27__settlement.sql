-- M1-W3 V27：settlement 模块（F3 分账结算）——settlement-settlements + settlement-fee_versions 两表
--
-- 施工规格：docs/modules/F-资金/F3-分账结算.md（§3 领域模型逐字 + §4 状态机 + §7 R-01~R-07）。
-- schema settlement / role ljr_settlement 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V26 冻结。本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或代码注释说明。
--
-- 表清单与文档对照（§3 逐字 + 口径归一，沿 V20/V22/V25 对同款文档裸列的先例）：
--   settlement-settlements  §3 原文列 + ①status 补 NOT NULL DEFAULT 'PENDING'（创建初始态）+
--                     ck 值域五态（PENDING|HOLD|READY|SETTLED|SUSPENDED，§4 状态机逐字；
--                     迁移矩阵=core 侧 settlement 状态机件全用例钉住，经守卫+
--                     state_transition_log 留痕，entity_type='settlement'；
--                     唯一解冻分账节点=READY→SETTLED，R-01 硬规则）；
--                     ②created_at 补 NOT NULL DEFAULT now()（V20/V22/V25 口径归一；R-02
--                     24h 冻结期锚点=DB 钟，应用钟不参与到期判定）；
--                     ③lawyer_id/firm_id 补 NOT NULL：结算归属事实源——R-04 待结算余额按
--                     lawyer 定位、R-07 进件前置按 firm 断言、§5 GET /lawyer/settlements
--                     本人过滤三者必需；§3 裸列无空值语义（结算无归属不可成立），文档缺口增补。
--                     ④share_mode varchar(16) NOT NULL DEFAULT 'FULL_TO_LAWYER' + ck 两值
--                     （FULL_TO_LAWYER|ABSENCE_7030）：R-03 缺席 70/30 分成的触发位——
--                     AttendanceAdjudicated(user,absent) 消费置 ABSENCE_7030；§3 无列，
--                     分账构成（§2）必需，文档缺口增补。
--                     ⑤payment_order_id bigint NULL：F1 /pay/split 分账指令定位（§5 RUN_SETTLEMENT
--                     内部指令），进件挂起恢复（R-07）重驱动需持久绑定（事件不可重放）；
--                     §3 缺口增补（载荷自带→落行）。NULL=尚未绑定（W3 消费载荷即绑）。
--                     ⑥escrow_status：F1 支付单冻结状态快照（进结算='PAID'、分账完成='SPLIT'，
--                     对账钩子锚点，§8）；§3 原文列，语义注记。
--                     ⑦金额非负 ck（gross/penalty/platform_fee/net ≥ 0，Money 字符串往返禁
--                     float）；⑧ref_type ck 两值（session|one_on_one，§3 注释逐字）。
--
--   settlement-fee_versions §3 逐字两列（id PK / rate numeric(5,4) NOT NULL / effective_at）+
--                     ⑨rate ck 0..1（R-06 平台服务费版本化；D20 ⚠W3 默认 30% 上限内先律师
--                     分成、服务费后置——种子 0.0000，升级 5-10% 走 H7/运营配置）；
--                     ⑩种子行：R-06「0% 起步」版本（WHERE NOT EXISTS 幂等，reset 重放不重复）。
--                     fee_versions 不入 core 测试清场清单（TEST_DB_TABLES）：种子 0% 版本是
--                     R-06 的参照数据（notify.notification_templates 不入清单同款先例），
--                     清场会把它一并抹掉；插入自定义费率版本的 spec 必须自行清理。
--
-- 派生索引（超出 §3 清单，理由）：
--   ix_settlements_lawyer (lawyer_id, status)     ——R-04 待结算余额求和 / §5 lawyer 列表扫描面；
--   ix_settlements_firm (firm_id, status)         ——R-07 进件挂起/恢复重驱动扫描面；
--   ix_settlements_hold (created_at) WHERE status='HOLD'
--                                                 ——SETTLE_HOLD_RELEASE 到期释放扫描面（R-02）。
--
-- 边界纪律：ref_id/fee_version_id/payment_order_id/lawyer_id/firm_id 均裸引用（fee_version_id
--   同 schema 同模块 fee_versions；其余跨域 trade/identity/payment——均禁 FK，W1/W2 惯例）；
--   金额列 numeric(12,2)，应用侧一律经 Money 字符串往返（禁 float）；资金不过平台账户（R-01）：
--   本表只是分账触发与构成的事实源，通道执行在 F1（/pay/split、/pay/deduct 指令面），无资金账户表。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 settlement 表。
-- 幂等性：IF NOT EXISTS / 种子 WHERE NOT EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（settlement-settlements），规避 check-schema-refs
--   的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- settlement.settlements：分账结算单（§3；UNIQUE(ref_type,ref_id) 幂等锚；
-- ---------- 状态迁移经守卫+state_transition_log，entity_type='settlement'，状态禁裸写） ----------
CREATE TABLE IF NOT EXISTS settlement.settlements (
    id               bigserial      PRIMARY KEY,
    ref_type         varchar(16)    NOT NULL,
                                    -- ⑧结算实体类型：session（B2C 场次）|one_on_one（1对1 订单）
    ref_id           bigint         NOT NULL,
                                    -- 结算实体 id（场次 id / 1对1 订单 id；R-01 履约完成链头）
    lawyer_id        bigint         NOT NULL,
                                    -- ③归属律师（identity 侧用户 id；R-04 待结算余额定位）
    firm_id          bigint         NOT NULL,
                                    -- ③归属律所（R-07 assertSplittable 前置 / 分账接收方）
    gross            numeric(12,2)  NOT NULL,
                                    -- 入账总额快照（F1 冻结额口径；Money 字符串往返禁 float）
    penalty          numeric(12,2)  NOT NULL DEFAULT 0,
                                    -- 违约扣减累计（R-04/R-05：全额补偿用户、平台不抽佣）
    platform_fee     numeric(12,2)  NOT NULL DEFAULT 0,
                                    -- 平台服务费（R-06 fee_versions 版本化，0% 起步；建行时按
                                    -- 当时生效版本计并固化）
    fee_version_id   bigint         NOT NULL,
                                    -- 计费版本（settlement-fee_versions 行 id 裸引用；费率口径审计锚）
    net              numeric(12,2)  NOT NULL,
                                    -- 可分配净额 = gross − penalty − platform_fee（=Σsplits）
    share_mode       varchar(16)    NOT NULL DEFAULT 'FULL_TO_LAWYER',
                                    -- ④分账构成模式：FULL_TO_LAWYER（正常全额）|
                                    -- ABSENCE_7030（R-03 缺席 70/30：70% 律师、30% 平台备付）
    payment_order_id bigint         NULL,
                                    -- ⑤F1 支付单 id（/pay/split 指令定位；恢复重驱动持久绑定）
    escrow_status    varchar(16)    NULL,
                                    -- ⑥F1 支付单冻结状态快照（'PAID'→'SPLIT'；§8 对账钩子锚点）
    deduction_detail jsonb          NULL,
                                    -- 违约扣减留痕 {items:[{leg, amount, idempotency_key,
                                    -- ledger_id, status}], debt, idempotency_key, applied_at}
                                    --（R-04 扣减顺序与欠款挂账 §10 验收锚点）
    status           varchar(16)    NOT NULL DEFAULT 'PENDING',
                                    -- ①PENDING|HOLD|READY|SETTLED|SUSPENDED（§4 逐字；经守卫+STL）
    hold_reason      varchar(32)    NULL,
                                    -- 挂起/冻结事由（HOLD_24H|OPEN_TICKETS|MERCHANT_NOT_ACTIVE）
    created_at       timestamptz    NOT NULL DEFAULT now(),
                                    -- ②创建时点（24h 冻结期 DB 钟锚点，R-02）
    settled_at       timestamptz    NULL,
                                    -- 分账完成时点（READY→SETTLED，唯一解冻节点）
    CONSTRAINT ux_settlements_ref UNIQUE (ref_type, ref_id),
    CONSTRAINT ck_settlements_ref_type CHECK (ref_type IN ('session', 'one_on_one')),
    CONSTRAINT ck_settlements_share_mode CHECK (share_mode IN ('FULL_TO_LAWYER', 'ABSENCE_7030')),
    CONSTRAINT ck_settlements_status CHECK (status IN ('PENDING', 'HOLD', 'READY', 'SETTLED', 'SUSPENDED')),
    CONSTRAINT ck_settlements_nonneg CHECK (gross >= 0 AND penalty >= 0 AND platform_fee >= 0 AND net >= 0)
);

COMMENT ON TABLE settlement.settlements IS 'F3 分账结算单（R-01 唯一解冻节点=READY→SETTLED；UNIQUE(ref_type,ref_id) 幂等锚；状态迁移经守卫+state_transition_log entity_type=settlement）';
COMMENT ON COLUMN settlement.settlements.penalty IS '违约扣减累计（R-04 待结算余额优先→保证金专户补足；R-05 全额补偿用户平台不抽佣，不进 platform_fee）';
COMMENT ON COLUMN settlement.settlements.share_mode IS '④分账构成模式（文档缺口增补）：AttendanceAdjudicated(user,absent) 置 ABSENCE_7030，R-03 缺席 70/30 触发位';
COMMENT ON COLUMN settlement.settlements.payment_order_id IS '⑤F1 支付单 id（文档缺口增补）：/pay/split 指令定位，进件恢复重驱动需持久绑定';
COMMENT ON COLUMN settlement.settlements.net IS '可分配净额=gross−penalty−platform_fee（恒等式 Σsplits=net，构成校验锚点）';
COMMENT ON COLUMN settlement.settlements.deduction_detail IS '违约扣减留痕（R-04 顺序两档+欠款挂账）：{items:[{leg,amount,idempotency_key,ledger_id,status}],debt,idempotency_key,applied_at}';

-- ---------- 派生索引（见头注理由） ----------
CREATE INDEX IF NOT EXISTS ix_settlements_lawyer
    ON settlement.settlements (lawyer_id, status);
CREATE INDEX IF NOT EXISTS ix_settlements_firm
    ON settlement.settlements (firm_id, status);
CREATE INDEX IF NOT EXISTS ix_settlements_hold
    ON settlement.settlements (created_at)
    WHERE status = 'HOLD';

-- ---------- settlement.fee_versions：平台服务费版本（R-06 版本化只追加，0% 起步） ----------
CREATE TABLE IF NOT EXISTS settlement.fee_versions (
    id            bigserial     PRIMARY KEY,
    rate          numeric(5,4)  NOT NULL,
                                -- ⑨费率（小数；ck 0..1；应用侧按基点整数整化计算，禁 float）
    effective_at  timestamptz   NOT NULL DEFAULT now(),
                                -- 生效时刻（生效版本=effective_at<=now() 中最新一条）
    CONSTRAINT ck_fee_versions_rate CHECK (rate >= 0 AND rate <= 1)
);

COMMENT ON TABLE settlement.fee_versions IS 'F3 平台服务费版本（R-06 版本化只 INSERT 不 UPDATE/DELETE；0% 起步，升级 5-10% 走 H7/运营配置；D20 ⚠W3 默认先律师分成、服务费后置）';

-- ⑩种子：R-06「0% 起步」参照版本（幂等防重放重复；不入 TEST_DB_TABLES 清单，见头注）
INSERT INTO settlement.fee_versions (rate, effective_at)
SELECT 0.0000, now()
WHERE NOT EXISTS (SELECT 1 FROM settlement.fee_versions WHERE rate = 0.0000);

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V26：只授不验） ----------
-- settlements：需 UPDATE（状态迁移经守卫推进 / 违约扣减回写 penalty,net / hold_reason 与
--   escrow_status 快照）；无 DELETE（分账触发与扣减留痕是审计事实源）。
GRANT SELECT, INSERT, UPDATE ON settlement.settlements TO ljr_settlement;
-- fee_versions：版本化只追加（R-06）——SELECT/INSERT，无 UPDATE/DELETE。
GRANT SELECT, INSERT ON settlement.fee_versions TO ljr_settlement;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA settlement TO ljr_settlement;
