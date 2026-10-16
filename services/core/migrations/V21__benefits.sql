-- M1-W3 V21：benefits 模块（F4 权益①切片）——积分账户 / 不可变积分流水
--
-- 施工规格：docs/modules/F-资金/F4-权益积分优惠券备付台账.md（§3 领域模型 + §7 R-01/R-02/R-06；
-- ①切片=两表：points_accounts + points_txns；coupons/coupon_grants/reserve_ledgers 三表与券/
-- 备付全部逻辑=②全量（M2-W2），本文件坚决不建——Task 2 简报硬边界）。
-- schema benefits / role ljr_benefits 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V20 冻结。
-- 本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或在代码注释说明。
--
-- 表清单与文档对照（两表 §3 逐字 + 口径归一，沿 V13/V16~V20 对同款文档裸列的先例）：
--   benefits-points_accounts  §3 原文列（user_id PK / balance / frozen / updated_at）+ ①balance/
--                             frozen 补 ck >= 0——§9「禁止：负余额」的 DB 兜底层（应用侧行锁+
--                             可用余额预检为第一层）；frozen 冻结中不过期（EXPIRE 扣减只动
--                             balance，与 ck 无联动——「frozen 冻结中不过期」最小裁决，见下）。
--   benefits-points_txns      §3 原文列 + ②kind 值域 ck 固化词汇表：§3 注释逐字 5 值
--                             （COMPENSATION|ABSENCE_SHARE|REDEEM|REFUND_RESTORE|EXPIRE）+ ①切片
--                             口径归一追加 FREEZE|UNFREEZE 两值：§5「FREEZE/SETTLE/UNFREEZE_POINTS
--                             幂等键=order」在两表模型下若无冻结/解冻留痕行则重放不可判定（重复
--                             FREEZE 无法识别→重复挪账），故冻结/解冻各留一行 delta=∓冻结额 的
--                             流水行（幂等锚点 + 逐单审计）。余额不变量求和口径只计五种「记账
--                             kind」（COMPENSATION/ABSENCE_SHARE/REFUND_RESTORE/REDEEM/EXPIRE），
--                             FREEZE/UNFREEZE 行是账户列移动（balance↔frozen）的留痕，不重复计
--                             入任一列（core 的 points 服务头注同口径）。③delta 符号 ck 按kind
--                             分组固化（授予/解冻 >0；核销/过期/冻结 <0）。④source_ref 可空 +
--                             ck 要求非 EXPIRE 行必填（V20 ck_split_ledgers_idem_required 同形）：
--                             uq(kind, source_ref)=§5 幂等键 DB 真兜底（冻结/核销/解冻=order、
--                             授予/退款还原=调用方 ref）；EXPIRE 聚合行无业务键 → source_ref NULL
--                             （PG 唯一约束 NULLS DISTINCT 天然豁免），重放防护由账户行锁串行化
--                             「算未处理过期额→扣减」临界区承担。⑤expires_at 与 kind 联动 ck：
--                             仅正向授予三 kind 可带（§3「只对正向 delta 行有意义」），且授予行
--                             必带（R-02 时钟是过期扣减的唯一依据）；R-06 退款还原图新鲜时钟
--                             （新 expires_at=restore 时刻+TTL，应用侧写入口径）。
--
-- 过期语义（R-02/R-06 + Task 2 简报最小裁决，报告同口径）：
--   ①180 天有效期（应用侧 LJR_BENEFITS_POINTS_TTL_DAYS 可覆，默认 180；授予/还原行写入时
--     expires_at=DB now()+TTL）；②惰性过期=读时把「已过期未扣减」部分从可用余额剔除（纯计算
--     不落行）；③POINTS_EXPIRE job（I2 目录在册，执行器=F4）每日物理扣减：按用户聚合
--     未处理过期额（已过期正向授予额 - 已消耗额，FIFO 口径），扣减额=min(未处理, balance)
--     ——frozen 冻结中不过期：不足以扣的部分留在「未处理」待解冻/核销失败回 balance 后由
--     下一轮惰性/job 路径按原 expires_at 扫走（已过期即扫，无宽限）；④EXPIRE 行逐用户聚合
--     一条（delta<0，expires_at NULL）。
--
-- 派生索引（超出 §3 清单，理由）：
--   ix_points_txns_user_created (user_id, created_at DESC) —— 按用户流水审计/（mine 不出流水，
--     预留）扫描面；
--   ix_points_txns_expiry (expires_at) WHERE expires_at IS NOT NULL —— POINTS_EXPIRE job 候选
--     用户扫描（部分索引：只有授予行带时钟）。
--
-- 边界纪律：user_id 为 identity 侧 bigint 裸引用（跨 schema 禁 FK，W1/W2 惯例）；
--   积分一律 int（100 积分=1 元，金额换算只在调用方 int 分域进行，本 schema 无金额列——
--   Money 纪律不涉）；R-04 分摊取整为纯函数（core 的 share-split 模块件），不落表。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 benefits 表。
-- 幂等性：IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（benefits-points_accounts），规避 check-schema-refs
-- 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- benefits.points_accounts：积分账户（§3；余额行锁防并发超用 §8） ----------
CREATE TABLE IF NOT EXISTS benefits.points_accounts (
    user_id    bigint      PRIMARY KEY,
                             -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    balance    int         NOT NULL DEFAULT 0,
                             -- 可用余额（§3 原文列；ck >= 0 负余额禁令兜底层）
    frozen     int         NOT NULL DEFAULT 0,
                             -- 冻结中（下单抵扣在途；§3 原文列；冻结中不过期）
    updated_at timestamptz NOT NULL DEFAULT now(),
                             -- §3 原文列 + NOT NULL DEFAULT now() 口径归一
    CONSTRAINT ck_points_accounts_balance CHECK (balance >= 0),
    CONSTRAINT ck_points_accounts_frozen CHECK (frozen >= 0)
);

COMMENT ON TABLE benefits.points_accounts IS 'F4 积分账户（①切片；负余额禁令 ck 兜底；全部变更走「流水不可变+余额行锁」纪律，无独立状态列不涉 STL——G1 流水先例）';
COMMENT ON COLUMN benefits.points_accounts.balance IS '可用余额（物理口径含「已过期未扣减」部分：读时惰性剔除；POINTS_EXPIRE job 物理扣减后收敛）';
COMMENT ON COLUMN benefits.points_accounts.frozen IS '冻结中积分（下单 FREEZE→SETTLE 核销/UNFREEZE 解冻；冻结中不过期——EXPIRE 只扣 balance）';

-- ---------- benefits.points_txns：不可变积分流水（§3；幂等键真兜底 + 过期时钟承载） ----------
CREATE TABLE IF NOT EXISTS benefits.points_txns (
    id          bigserial    PRIMARY KEY,
    user_id     bigint       NOT NULL,
                             -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    delta       int          NOT NULL,
                             -- 正负（§3 原文列；符号按 kind 分组固化 ck）
    kind        varchar(20)  NOT NULL,
                             -- 词汇表非状态机（§3 注释 5 值 + ①切片 FREEZE/UNFREEZE 口径归一，
                             -- 见头注②；ck 值域固化）
    source_ref  varchar(64)  NULL,
                             -- ④幂等引用：FREEZE/REDEEM/UNFREEZE=order:{支付单id}（§5 幂等键=order）、
                             -- 授予/退款还原=调用方 ref（1-64 字符）；EXPIRE 聚合行 NULL
    expires_at  timestamptz  NULL,
                             -- R-02 过期时钟：仅正向授予三 kind 携带（⑤），R-06 退款还原写新鲜时钟
    created_at  timestamptz  NOT NULL DEFAULT now(),
                             -- 口径归一（V18 先例）
    CONSTRAINT ux_points_txns_kind_ref UNIQUE (kind, source_ref),
    CONSTRAINT ck_points_txns_kind CHECK (
        kind IN ('COMPENSATION', 'ABSENCE_SHARE', 'REDEEM', 'REFUND_RESTORE', 'EXPIRE', 'FREEZE', 'UNFREEZE')
    ),
    CONSTRAINT ck_points_txns_delta_sign CHECK (
        (kind IN ('COMPENSATION', 'ABSENCE_SHARE', 'REFUND_RESTORE', 'UNFREEZE') AND delta > 0)
        OR (kind IN ('REDEEM', 'EXPIRE', 'FREEZE') AND delta < 0)
    ),
    CONSTRAINT ck_points_txns_ref CHECK (kind = 'EXPIRE' OR (source_ref IS NOT NULL AND source_ref <> '')),
    CONSTRAINT ck_points_txns_expires_kind CHECK (
        (kind IN ('COMPENSATION', 'ABSENCE_SHARE', 'REFUND_RESTORE') OR expires_at IS NULL)
        AND (kind NOT IN ('COMPENSATION', 'ABSENCE_SHARE', 'REFUND_RESTORE') OR expires_at IS NOT NULL)
    )
);

COMMENT ON TABLE benefits.points_txns IS 'F4 积分流水（R-03「流水不可变」纪律：触发器硬禁 UPDATE/DELETE；uq(kind,source_ref)=幂等键 DB 真兜底）；FREEZE/UNFREEZE 为①切片口径归一追加的冻结/解冻留痕行';
COMMENT ON COLUMN benefits.points_txns.source_ref IS '幂等引用（§5：冻结/核销/解冻=order:{支付单id}；授予/退款还原=调用方 ref）；EXPIRE 聚合行 NULL（重放防护由账户行锁承担）';
COMMENT ON COLUMN benefits.points_txns.expires_at IS 'R-02 过期时钟（仅授予行携带；R-06 退款还原=restore 时刻+TTL 新鲜时钟；frozen 冻结中不过期）';

-- 按用户流水审计扫描面
CREATE INDEX IF NOT EXISTS ix_points_txns_user_created
    ON benefits.points_txns (user_id, created_at DESC);

-- POINTS_EXPIRE job 候选扫描（部分索引：仅授予行带时钟）
CREATE INDEX IF NOT EXISTS ix_points_txns_expiry
    ON benefits.points_txns (expires_at) WHERE expires_at IS NOT NULL;

-- ---------- 流水不可变触发器（禁 UPDATE/DELETE；TRUNCATE 不经行触发器，清场不受影响） ----------
CREATE OR REPLACE FUNCTION benefits.fn_points_txns_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'benefits.points_txns 流水不可变（R-03 纪律）：禁止 %，积分流水仅 INSERT', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_points_txns_immutable ON benefits.points_txns;
CREATE TRIGGER tg_points_txns_immutable
    BEFORE UPDATE OR DELETE ON benefits.points_txns
    FOR EACH ROW EXECUTE FUNCTION benefits.fn_points_txns_immutable();

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V20：只授不验，GRANT 收窄形态照 V18/V20） ----------
-- accounts 需 UPDATE（余额/冻结列移动）；txns 无 UPDATE/DELETE（不可变双保险：触发器+权限位）。
GRANT SELECT, INSERT, UPDATE ON benefits.points_accounts TO ljr_benefits;
GRANT SELECT, INSERT ON benefits.points_txns TO ljr_benefits;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA benefits TO ljr_benefits;
