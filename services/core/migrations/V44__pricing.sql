-- M2-W2 V44：pricing 模块追加（#39 收口）——改价补偿「应发」快照表 comp_snapshots
--
-- 事实源：docs/plans/M2-W2-执行计划.md T6 行与附录 A.3 V42 蓝图（**迁移号顺延勘误**：
--   V40~V42 已被 C4/C5 占用，本批 F4=V43__benefits+V44__pricing）+ 04 §8 #39（C6 补偿
--   「应发」事实源缺口：改价生效时点的补偿对象快照未持久化——巡检第⑤类「补偿应发未发
--   >24h」以 pricing_histories 行推算「应发」，在团零已支付/全取整为 0 的合法行仍会检出
--   CRITICAL 假阳——本表即「应发」的持久事实源，假阳收口）。
--
-- 表清单与蓝图对照（A.3 列级对齐，逐列）：
--   pricing-comp_snapshots   price_change_id/user_id/points/kind/granted + UNIQUE(price_change_
--                           id, user_id)（快照行幂等兜底——approve 重入/崩溃重放靠 grant 幂等
--                           +本 UNIQUE 收敛）。**写入口径（任务裁定，报告注明）**：C6 approve
--                           生效事务内持久化 computeCompensations 全量对象——**零发放用户也落
--                           行**（points=0、granted=true：零欠付即无未决，巡检⑤对照本表零假阳）；
--                           发放>0 用户=grant 与快照同事务化（granted=true 同事务写就，事务外
--                           不可见 granted=false 行——列保留 false 缺省为未来异步发放路径
--                           （COMPENSATION_DISPATCH 目录在册不装配）的判定位）。kind=COMPENSATION
--                           （积分流水 kind 词汇；varchar(24) 为蓝图宽度）。
--
-- 边界纪律：表归 pricing schema（C6 面自写自读——改价服务写入/pricing 巡检件
--   对照，域内闭环不跨 schema）；user_id 裸 bigint 引用（跨 schema 禁 FK）；points int
--   （积分域，金额换算不涉本表）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 pricing 表。
-- 幂等性：IF NOT EXISTS / ON CONFLICT，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（pricing-comp_snapshots），规避 check-schema-refs
--   的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- pricing.comp_snapshots：补偿应发快照（#39 收口；巡检⑤对照事实源） ----------
CREATE TABLE IF NOT EXISTS pricing.comp_snapshots (
    id               bigserial   PRIMARY KEY,
    price_change_id  bigint      NOT NULL,
                                 -- pricing.pricing_histories.id（同 schema 裸引用，蓝图无 FK）
    user_id          bigint      NOT NULL,
                                 -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    points           int         NOT NULL,
                                 -- 应发积分（0=零发放合法行：computeCompensations 取整为 0 的对象）
    kind             varchar(24) NOT NULL,
                                 -- 积分授予词汇（COMPENSATION；积分流水 kind 同源）
    granted          boolean     NOT NULL DEFAULT false,
                                 -- 已发标记（同事务写就=true；缺省 false 为未来异步发放路径判定位）
    created_at       timestamptz NOT NULL DEFAULT now(),
                                 -- 口径归一（V18 先例）
    CONSTRAINT ck_comp_snapshots_points CHECK (points >= 0),
    CONSTRAINT ux_comp_snapshots_change_user UNIQUE (price_change_id, user_id)
);

COMMENT ON TABLE pricing.comp_snapshots IS 'C6 补偿应发快照（#39 收口：approve 生效事务内全量持久化 computeCompensations 输出——零发放对象也落 granted=true 零分行；巡检⑤对照本表，快照零行=无补偿对象不告警）';
COMMENT ON COLUMN pricing.comp_snapshots.granted IS '已发标记（快照与 grant 同事务化——事务外不可见 false；列缺省 false 为 COMPENSATION_DISPATCH 异步路径（在册不装配）预留判定位）';

-- ---------- 权限（沿 V29/V30 口径：GRANT 收窄形态） ----------
GRANT SELECT, INSERT, UPDATE ON pricing.comp_snapshots TO ljr_pricing;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pricing TO ljr_pricing;
