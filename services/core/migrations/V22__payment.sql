-- M1-W3 V22：payment 模块（A3b 律所进件①切片）——律所二级商户 / 保证金指令台账
--
-- 施工规格：docs/modules/A-身份与账号/A3b-律所进件（§3 领域模型 + §4 状态机 + §7 R-01~R-04；
-- 文档名以免点分词形误报不带 .md 后缀）。schema=payment 明定（进件状态机归支付网关持有，
-- identity 只读，架构 §3.3-3）——两表落 payment schema，代码同域（modules/payment 进件子域）。
-- schema payment / role ljr_payment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V21 冻结。
-- 本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或在代码注释说明。
--
-- 表清单与文档对照（两表 §3 逐字 + 口径归一，沿 V13/V16~V21 对同款文档裸列的先例）：
--   payment-firm_merchants   §3 原文列 + ①status 补 NOT NULL DEFAULT 'SUBMITTING'（进件初始态）
--                            + ck 值域六态（§3 注释逐字：SUBMITTING|IN_REVIEW|ACTIVE|CHANGING|
--                            SUSPENDED|STOPPED；迁移矩阵=core 进件状态机件（firm_merchant），
--                            全用例钉住，经守卫+state_transition_log 留痕，
--                            entity_type='firm_merchant'）；
--                            ②channel 值域 ck（wechat_ecom|alipay，§3 注释）；③created_at 补
--                            NOT NULL DEFAULT now()（V20 口径归一）；materials jsonb NOT NULL 照
--                            §3 原文（对公账户等敏感材料，应用侧禁落日志——PII 红线）；
--                            ④reverify_due 可空（仅 ACTIVE 语义有效：生效时写 now()+复验期，
--                            R-03 年度复验锚点，FIRM_REVERIFY job 回查锚点照 I2 §4 对照表）。
--   payment-lawyer_deposits  §3 原文列（lawyer_id/channel/escrow_amount/status）+ 指令台账口径
--                            归一（Task 3 简报「幂等键=firm+batch」裁量，沿 V20 split_ledgers
--                            指令台账同形）：⑤status 补 NOT NULL DEFAULT 'ISSUED' + ck 两态
--                            （ISSUED|FROZEN——指令下发→通道确认；mock 同步确认，本批恒当场
--                            FROZEN，ISSUED 留给崩溃窗口/真实异步通道；迁移经守卫+STL，
--                            entity_type='lawyer_deposit'，简报「按表结构择一」裁量=指令状态机
--                            形态而非流水不可变——status 是状态字段，禁裸写硬约束要求经守卫；
--                            台账行仍无 DELETE）；⑥escrow_amount 非负 ck + numeric(12,2)（Money
--                            字符串往返，禁 float）；⑦batch_no varchar(64) NOT NULL：调用方批次
--                            引用（幂等键=firm+batch 的 batch 半边事实源，detail 可查但入列便于
--                            等值定位）；⑧idempotency_key varchar(160) NOT NULL UNIQUE：
--                            确定性复合键 deposit:firm:{firm_id}:batch:{batch_no}（§5 幂等键=
--                            firm+batch 的 DB 真兜底；160 照 V20 inbox 列宽先例，容纳 19 位
--                            bigint+64 位 batch）；⑨detail jsonb NULL：指令上下文（firm_id/
--                            lawyer_id/batch/channel_txn_no——§3 模型无 channel_txn_no 列，照
--                            V20 ⑩先例随 detail 承载，firm_id 必载由 ck 固化——幂等键含 firm
--                            而表无 firm_id 列的最小承载）；⑩created_at NOT NULL DEFAULT now()。
--
-- 派生索引（超出 §3 清单，理由）：
--   ix_firm_merchants_status (status, reverify_due) —— FIRM_REVERIFY 执行器/H1 状态视图扫描面
--     （ACTIVE 且到期未复验候选）；UNIQUE(firm_id, channel) 已覆盖按律所等值定位，不另建。
--
-- 边界纪律：firm_id/lawyer_id 为他域 bigint 裸引用（跨 schema 禁 FK，W1/W2 惯例）；
--   金额列 numeric(12,2)，应用侧一律经 @ljr/shared Money 字符串往返（禁 float）；
--   R-04 资金红线：保证金专户在持牌机构侧，本表只是指令+台账，无资金账户、不自收。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 payment 表。
-- 幂等性：IF NOT EXISTS / DROP TRIGGER IF EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（payment-firm_merchants），规避 check-schema-refs
-- 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- payment.firm_merchants：律所二级商户进件状态机（§3；迁移经守卫，状态禁裸写） ----------
CREATE TABLE IF NOT EXISTS payment.firm_merchants (
    id           bigserial    PRIMARY KEY,
    firm_id      bigint       NOT NULL,
                              -- 律所 id（trade/pricing 域引用；跨 schema 禁 FK，W1/W2 惯例）
    channel      varchar(16)  NOT NULL,
                              -- wechat_ecom（主）|alipay（备）（§3 注释；ck 值域）
    sub_mchid    varchar(64)  NULL,
                              -- 持牌机构二级商户号（进件生效后回填）
    status       varchar(24)  NOT NULL DEFAULT 'SUBMITTING',
                              -- SUBMITTING|IN_REVIEW|ACTIVE|CHANGING|SUSPENDED|STOPPED（§3 注释；
                              -- 生命周期经守卫+state_transition_log，entity_type='firm_merchant'）
    materials    jsonb        NOT NULL,
                              -- 进件材料（对公账户/开户许可等；PII 红线：应用侧禁落日志）
    verified_at  timestamptz  NULL,
                              -- 最近一次生效核验时点（→ACTIVE 时刷新）
    reverify_due timestamptz  NULL,
                              -- R-03 年度复验到期（→ACTIVE 时写 now()+复验期；FIRM_REVERIFY 回查锚点）
    created_at   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ux_firm_merchants_firm_channel UNIQUE (firm_id, channel),
    CONSTRAINT ck_firm_merchants_channel CHECK (channel IN ('wechat_ecom', 'alipay')),
    CONSTRAINT ck_firm_merchants_status
        CHECK (status IN ('SUBMITTING', 'IN_REVIEW', 'ACTIVE', 'CHANGING', 'SUSPENDED', 'STOPPED'))
);

COMMENT ON TABLE payment.firm_merchants IS 'A3b 律所二级商户进件状态机（R-01 仅 ACTIVE 可作分账接收方；生命周期经守卫+state_transition_log；identity 只读——状态事实源在本 schema）';
COMMENT ON COLUMN payment.firm_merchants.materials IS '进件材料（对公账户/开户许可等；敏感字段禁落日志/事件载荷——PII 红线）';
COMMENT ON COLUMN payment.firm_merchants.reverify_due IS 'R-03 年度复验到期（→ACTIVE 写 now()+复验期；FIRM_REVERIFY job 回查锚点；到期未复验→SUSPENDED）';

-- FIRM_REVERIFY 执行器/H1 视图扫描面（ACTIVE 且到期未复验候选）
CREATE INDEX IF NOT EXISTS ix_firm_merchants_status
    ON payment.firm_merchants (status, reverify_due);

-- ---------- payment.lawyer_deposits：保证金指令台账（§3；R-04 持牌机构侧专户，平台仅指令+台账） ----------
CREATE TABLE IF NOT EXISTS payment.lawyer_deposits (
    id              bigserial      PRIMARY KEY,
    lawyer_id       bigint         NOT NULL,
                                   -- 律师 id（identity 侧引用；跨 schema 禁 FK，W1/W2 惯例）
    channel         varchar(16)    NOT NULL,
                                   -- 指令实际发生通道（主通道下发，失败切备后回填实际方）
    escrow_amount   numeric(12,2)  NOT NULL,
                                   -- 冻结指令金额（Money 字符串往返，禁 float；非负 ck）
    status          varchar(16)    NOT NULL DEFAULT 'ISSUED',
                                   -- ISSUED|FROZEN（⑤指令下发→通道确认；经守卫+STL，
                                   -- entity_type='lawyer_deposit'；台账行无 DELETE）
    batch_no        varchar(64)    NOT NULL,
                                   -- 调用方批次引用（幂等键=firm+batch 的 batch 半边）
    idempotency_key varchar(160)   NOT NULL,
                                   -- ⑧确定性复合键 deposit:firm:{firm_id}:batch:{batch_no}
                                   -- （§5 幂等键=firm+batch；UNIQUE 为 DB 真兜底）
    detail          jsonb          NULL,
                                   -- ⑨指令上下文（firm_id 必载/lawyer_id/batch/channel_txn_no）
    created_at      timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ux_lawyer_deposits_idem UNIQUE (idempotency_key),
    CONSTRAINT ck_lawyer_deposits_channel CHECK (channel IN ('wechat_ecom', 'alipay')),
    CONSTRAINT ck_lawyer_deposits_status CHECK (status IN ('ISSUED', 'FROZEN')),
    CONSTRAINT ck_lawyer_deposits_amount CHECK (escrow_amount >= 0),
    CONSTRAINT ck_lawyer_deposits_batch CHECK (batch_no <> ''),
    CONSTRAINT ck_lawyer_deposits_detail_firm CHECK (detail ->> 'firm_id' IS NOT NULL)
);

COMMENT ON TABLE payment.lawyer_deposits IS 'A3b 保证金冻结指令台账（R-04：专户在持牌机构侧，平台仅指令+台账不自收；幂等键=firm+batch 确定性复合键唯一兜底；指令经 F1 通道原语与台账同事务）';
COMMENT ON COLUMN payment.lawyer_deposits.idempotency_key IS '确定性复合键 deposit:firm:{firm_id}:batch:{batch_no}（§5 幂等键=firm+batch）；同键同载荷幂等重放、异载荷 409 E_DUP_KEY（F1 台账同口径）';
COMMENT ON COLUMN payment.lawyer_deposits.detail IS '指令上下文（firm_id 必载由 ck 固化/lawyer_id/batch/channel_txn_no——对账核对锚点照 V20 detail 承载先例）';

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V21：只授不验，GRANT 收窄形态照 V20/V21） ----------
-- 两表均需 UPDATE（firm_merchants 生命周期推进 / lawyer_deposits ISSUED→FROZEN 通道确认）；
-- 一律无 DELETE（进件与保证金指令留痕是 R-01/R-04 审计事实源）。
GRANT SELECT, INSERT, UPDATE ON payment.firm_merchants TO ljr_payment;
GRANT SELECT, INSERT, UPDATE ON payment.lawyer_deposits TO ljr_payment;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA payment TO ljr_payment;
