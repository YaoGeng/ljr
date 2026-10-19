-- M2-W2 V43：benefits 模块追加（F4 权益②全量）——优惠券定义 / 券发放 / 备付金台账
--
-- 事实源：docs/modules/F-资金/F4-权益积分优惠券备付台账.md（§3 领域模型三表逐字 + §4 分成/
--   补偿/过期流程 + §7 R-04/R-05/R-07 + §8 日终对平）+ docs/plans/M2-W2-执行计划.md T6 行
--   与附录 A.3 V41 蓝图（**迁移号顺延勘误**：V40~V42 已被 C4/C5 占用，本批 F4=V43__benefits
--   +V44__pricing，周批 DoD flyway validate 至 V1~V44）+ 05 §11 D1 决策行（⚠W2-3：缺席费
--   30% 定性=备付台账实现）+ 04 §8 #1（积分到期作废后资金归属待决策——台账先按「净额记账
--   待决策」口径实现，EXPIRE_NET 即该口径承载）。
--
-- 表清单与蓝图对照（A.3 列级对齐，逐列）：
--   benefits-coupons          §3 原文列（face_value/validity_days/specialty）；A.3 蓝图含
--                             id bigserial PK。**seed 一行 PRICE_COMP 定义（id=1，面额 50.00/
--                             有效期 90 天）**：券面额 PRD §8.2 未定义（⚠04 §8 待产品拍板），
--                             计划口径=H7 配置 rule_key=coupon-price_comp（运行时键串）落值——本批先以
--                             本行 seed 默认值承载（发放时 H7 现行版存在则优先读配置），头注
--                             待拍板。
--   benefits-coupon_grants    §3 原文列（coupon_id/user_id/source/status/granted_at/used_at）
--                             + A.3 追加 source_ref varchar(64) NOT NULL + UNIQUE(source,
--                             source_ref)（C6 券指令事件 at-least-once 重放的幂等 DB 兜底；
--                             source_ref=price_change:{id}:u{user_id}，指令幂等锚=(price_
--                             change_id, user_id)——shared PriceCouponInstructedPayload 注释
--                             口径）+ expires_at timestamptz NOT NULL（=granted_at+validity_days，
--                             到期 EXPIRED 惰性+周期双路径的判定锚）。status 三值 ck
--                             （ACTIVE|USED|EXPIRED）——迁移经 coupon_grant 状态机守卫+STL
--                             （core 的 coupon-machine 状态机，entity_type='coupon_grant'），禁裸写。
--   benefits-reserve_ledgers  §3 原文列 + A.3 定型 ref_id varchar(64) NOT NULL（§3 裸 ref_id
--                             列型裁定=varchar，与积分流水 source_ref 列同宽）。entry 三值 ck
--                             （ACCRUE|REDEEM_NET|EXPIRE_NET）。**amount 符号口径（任务裁定，
--                             报告注明）**：有符号记账——ACCRUE=正（积分入账对应备付增记）、
--                             REDEEM_NET/EXPIRE_NET=负（核销/过期的净减记），Σamount×100 恒等
--                             未兑付积分余额（Σ账户 balance+frozen 两列）——R-05 1:1 对平的
--                             直接可比形态。period=上海日（日终对平 job 的轮次锚）。
--
-- 派生索引（超出 §3/A.3 清单，理由）：
--   ix_coupon_grants_user_status (user_id, status) —— GET /coupons/mine 按用户活跃券扫描
--     （A.3 蓝图含本索引）；
--   ix_reserve_ledgers_period (period, entry) —— 日终对平/按期审计的扫描面（全表 Σ 对平
--     亦可用，本索引服务按期下钻）。
--
-- 边界纪律：user_id/coupon_id 均裸 bigint 引用（跨 schema 禁 FK；同 schema FK 亦不建——
--   V21/V39/V42 蓝图逐列先例，A.3 未定义 REFERENCES）；台账与业务流水不混表（§9：
--   reserve_ledgers 与 points_txns 物理分表）；金额 NUMERIC(12,2) 禁 float——积分↔元换算
--   （100:1）在应用侧 int 分域显式进行，本表 amount 落 NUMERIC。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 benefits 表。
-- 幂等性：IF NOT EXISTS / ON CONFLICT，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（benefits-coupons），规避 check-schema-refs 的
--   点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- benefits.coupons：券定义（§3；PRICE_COMP 种子行=发放锚） ----------
CREATE TABLE IF NOT EXISTS benefits.coupons (
    id            bigserial     PRIMARY KEY,
    face_value    numeric(10,2) NOT NULL,
                                  -- 固定面额（§3 原文列；元，NUMERIC 禁 float）
    validity_days int           NOT NULL,
                                  -- 自发放日起的有效天数（§3 原文列；expires_at=granted_at+本值）
    specialty     varchar(32)   NULL,
                                  -- 适用专项（§3 原文列；NULL=不限）
    CONSTRAINT ck_coupons_face_value CHECK (face_value > 0),
    CONSTRAINT ck_coupons_validity_days CHECK (validity_days > 0)
);

COMMENT ON TABLE benefits.coupons IS 'F4 券定义（②全量；PRICE_COMP 种子行 id=1——面额 PRD 未定义 ⚠待产品拍板，H7 配置 coupon-price_comp 现行版优先）';
COMMENT ON COLUMN benefits.coupons.face_value IS '固定面额（元；发放快照进 CouponGranted 载荷，核销按面额抵扣）';

-- PRICE_COMP 定义种子（参照数据，不入测试清场清单——notification_templates/fee_versions 同款纪律）
INSERT INTO benefits.coupons (id, face_value, validity_days)
VALUES (1, 50.00, 90)
ON CONFLICT (id) DO NOTHING;

-- ---------- benefits.coupon_grants：券发放（§3；幂等键=UNIQUE(source, source_ref)） ----------
CREATE TABLE IF NOT EXISTS benefits.coupon_grants (
    id          bigserial     PRIMARY KEY,
    coupon_id   bigint        NOT NULL,
                                  -- benefits.coupons.id（同 schema 裸引用，蓝图无 FK）
    user_id     bigint        NOT NULL,
                                  -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    source      varchar(24)   NOT NULL,
                                  -- 发放来源词汇（§3：price_compensation）
    source_ref  varchar(64)   NOT NULL,
                                  -- 幂等引用（A.3 追加列）：price_compensation=price_change:{id}:u{user_id}
                                  -- （shared PriceCouponInstructedPayload 幂等锚=(price_change_id,user_id)）
    status      varchar(12)   NOT NULL,
                                  -- ACTIVE|USED|EXPIRED（ck 固化；迁移经守卫+STL，禁裸写）
    granted_at  timestamptz   NOT NULL DEFAULT now(),
                                  -- §3 原文列（expires_at 推导锚）
    used_at     timestamptz   NULL,
                                  -- §3 原文列（USED 时刻）
    expires_at  timestamptz   NOT NULL,
                                  -- =granted_at+validity_days（A.3 追加列；到期 EXPIRED 判定锚）
    CONSTRAINT ux_coupon_grants_source_ref UNIQUE (source, source_ref),
                                  -- C6 券指令 at-least-once 重放的幂等 DB 兜底（A.3 蓝图逐字）
    CONSTRAINT ck_coupon_grants_source CHECK (source IN ('price_compensation')),
    CONSTRAINT ck_coupon_grants_status CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED')),
    CONSTRAINT ck_coupon_grants_used_at CHECK (
        (status = 'USED' AND used_at IS NOT NULL) OR (status <> 'USED' AND used_at IS NULL)
    )
);

COMMENT ON TABLE benefits.coupon_grants IS 'F4 券发放（②全量；UNIQUE(source,source_ref)=券指令 at-least-once 幂等 DB 兜底；状态迁移经 coupon_grant 状态机守卫+STL）';
COMMENT ON COLUMN benefits.coupon_grants.source_ref IS '幂等引用：price_compensation=price_change:{改价id}:u{用户id}（C6 指令幂等锚=(price_change_id,user_id)）';

-- 按用户活跃券扫描（GET /coupons/mine；A.3 蓝图索引）
CREATE INDEX IF NOT EXISTS ix_coupon_grants_user_status
    ON benefits.coupon_grants (user_id, status);

-- ---------- benefits.reserve_ledgers：备付金台账（§3；R-05 1:1 对平事实源） ----------
CREATE TABLE IF NOT EXISTS benefits.reserve_ledgers (
    id          bigserial     PRIMARY KEY,
    period      date          NOT NULL,
                                  -- 上海日（日终对平 job 轮次锚；ACCRUE/REDEEM_NET/EXPIRE_NET 落账日）
    entry       varchar(24)   NOT NULL,
                                  -- ACCRUE（正）|REDEEM_NET（负）|EXPIRE_NET（负），ck 固化
    amount      numeric(12,2) NOT NULL,
                                  -- 元（有符号；|amount|×100=积分额，换算在应用侧 int 分域显式进行）
    ref_id      varchar(64)   NOT NULL,
                                  -- 记账引用：ACCRUE=points source_ref+u{user}、REDEEM_NET=order:{id}、
                                  -- EXPIRE_NET=expire:{yyyymmdd}:u{user}（任务裁定，报告注明）
    created_at  timestamptz   NOT NULL DEFAULT now(),
                                  -- 口径归一（V18 先例）
    CONSTRAINT ck_reserve_ledgers_entry CHECK (entry IN ('ACCRUE', 'REDEEM_NET', 'EXPIRE_NET')),
    CONSTRAINT ck_reserve_ledgers_amount_sign CHECK (
        (entry = 'ACCRUE' AND amount > 0)
        OR (entry IN ('REDEEM_NET', 'EXPIRE_NET') AND amount < 0)
    )
);

COMMENT ON TABLE benefits.reserve_ledgers IS 'F4 备付金台账（②全量；有符号净额记账：ACCRUE 正/REDEEM_NET+EXPIRE_NET 负，Σamount×100 恒等未兑付积分余额——R-05 日终 1:1 对平事实源；⚠04§8-1 到期资金归属待决策，EXPIRE_NET=净额记账口径承载）';
COMMENT ON COLUMN benefits.reserve_ledgers.ref_id IS '记账引用（对平 job 只比 Σ，ref 服务人工下钻：ACCRUE={points source_ref}:u{user}、REDEEM_NET=order:{支付单id}、EXPIRE_NET=expire:{上海日}:u{user}）';

-- 按期对平/审计扫描面
CREATE INDEX IF NOT EXISTS ix_reserve_ledgers_period
    ON benefits.reserve_ledgers (period, entry);

-- ---------- 权限（沿 V21 口径：GRANT 收窄形态；台账与券均需 UPDATE 状态/无 DELETE） ----------
GRANT SELECT, INSERT, UPDATE ON benefits.coupons TO ljr_benefits;
GRANT SELECT, INSERT, UPDATE ON benefits.coupon_grants TO ljr_benefits;
GRANT SELECT, INSERT ON benefits.reserve_ledgers TO ljr_benefits;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA benefits TO ljr_benefits;
