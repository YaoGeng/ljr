-- M1-W3 V26：trade 模块（C3 报名与支付成团切片）——交易域第三表：enrollments 报名表
--
-- 施工规格：docs/modules/C-交易/C3-报名与支付成团（§3 领域模型 + §4 成团原子守卫 + §7 R-01~R-06；
-- 文档名以免点分词形误报不带后缀）。schema trade / role ljr_trade 已由 V1 建好（禁增删 schema/role，
-- 本文件不触碰）；V1~V25 冻结。本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走
-- 新迁移或在代码注释说明。
--
-- 表清单与文档对照（trade-enrollments §3 逐字 + 口径归一，沿 V23/V24/V25 对同款文档裸列的先例）：
--   ①pay_status 补 NOT NULL DEFAULT 'PENDING'（报名初始态=待支付，下单事务即插行）+ ck 值域
--     三态（§3 注释逐字 PENDING|PAID|REFUNDED；无第四态——R-W3-O 裁决：流标未付清场保持
--     PENDING+F4 解冻，晚到回调经自动退款分支 PENDING→REFUNDED，任务报告注明）；迁移
--     PENDING→PAID（成团守卫）/PENDING→REFUNDED（满员或终态自动退款）/PAID→REFUNDED
--     （退款完成收敛）全经守卫+state_transition_log 留痕（entity_type='enrollment'）；
--   ②created_at 补 NOT NULL DEFAULT now()（V20/V23/V24 口径归一）；
--   ③ref_type ck 值域（session|groupbuy，§5 两端点实体词汇=B2 占用锁 ref_type 同集）；
--   ④金额/积分非负 ck（unit_price/paid_amount/cash_amount numeric 非负 + points_amount/
--     credit_used int 非负，与 shared Money 非负口径一致；cash_amount 列缺省 0=§3 逐字，
--     R-04 积分抵扣 ≤50% 保证现金部分语义由应用层守卫）；
--   ⑤prev_enrollment_id 不设 FK（§3 裸列；同 schema 自引用但语义=转化/改期迁移链回链指针，
--     历史行永删——C4 转化=M2 落位，本批词汇保留不接线）；
--   ⑥state_transition_log 为平台横切表（V3 已建），非本模块新建——执行计划预检注记，本文件
--     不触碰该表；
--   ⑦price_snapshot jsonb 形状=§3 注释逐字六键 {price_mode, unit_price, share_price,
--     session_total, price_version, snapshot_at}（session_total=违约金基数单一来源，F3/D4
--     消费禁双端计算）；share_price 键在 B2C 场次报名行为 null（分摊额是 C2B 语义），
--     groupbuy 加入行为分摊额快照——jsonb 不设 schema 级校验，形状防御在应用层
--     （C3 服务出口径），M2 D4 接线时若有强校验诉求再走新迁移。
--
-- 派生索引（§3 逐字 + 一件补充，理由）：
--   ux_enroll_active (ref_type, ref_id, user_id) WHERE pay_status IN ('PENDING','PAID')
--                                     —— §3 逐字部分唯一索引：活跃态唯一=同场次同用户仅一条
--                                     活跃报名（取消/终态后可重报，历史行保留，§10 验收项）；
--                                     兼作成团守卫按 ref 维度计数与退款源清单的扫描面
--                                     （WHERE pay_status='PAID' 命中索引谓词）。
--   ix_enrollments_user (user_id, created_at)
--                                     —— GET /enrollments/mine 用户维度倒序列表扫描面
--                                     （§5 查询面；§3 裸列清单外补充，理由=mine 是契约端点）。
--
-- 边界纪律：ref_id/user_id/price_version_id/prev_enrollment_id 为裸引用（跨 schema 禁 FK，
--   W1/W2/W3 惯例；price_version_id=pricing 侧版本号数值锚，不校验存在性）；金额列应用侧
--   一律经 Money 字符串往返（禁 float）；与 F1 支付单的关联不落本表列——关联=F1 幂等键
--   enroll/e{id}/pay（服务口径，回查经 payment 导出只读面，禁跨 schema join）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 trade 表。
-- 幂等性：IF NOT EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（trade-enrollments），规避 check-schema-refs 的点分词形
--   扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- trade.enrollments：C3 报名（§3；pay_status 三态经守卫，状态禁裸写） ----------
CREATE TABLE IF NOT EXISTS trade.enrollments (
    id                 bigserial      PRIMARY KEY,
    ref_type           varchar(16)    NOT NULL,
                                      -- 报名实体类型：session|groupbuy（头注③）
    ref_id             bigint         NOT NULL,
                                      -- 业务实体 id（trade-sessions / trade-group-buys 的 id）
    user_id            bigint         NOT NULL,
                                      -- 报名人（identity 侧用户 id，bigint 裸引用口径）
    price_snapshot     jsonb          NOT NULL,
                                      -- R-03 快照价：六键形状见头注⑦（快照后改价不影响）
    unit_price         numeric(10,2)  NOT NULL,
                                      -- 本席单价（session_total 模式=seatPriceFor 本席位价，R-W3-I）
    paid_amount        numeric(12,2)  NOT NULL,
                                      -- 应付总额（cash+points/100 生成口径，R-04）
    cash_amount        numeric(12,2)  NOT NULL DEFAULT 0,
                                      -- 现金部分（F1 下单拆分快照；原路退回上限）
    points_amount      int            NOT NULL DEFAULT 0,
                                      -- 积分部分（100 积分=1 元；F4 FREEZE 冻结额）
    price_version_id   bigint         NOT NULL,
                                      -- B3 当前版本号（快照版本锚；报名时点取值）
    pay_status         varchar(16)    NOT NULL DEFAULT 'PENDING',
                                      -- PENDING|PAID|REFUNDED（§3 注释逐字，头注①）
    credit_used        int            NOT NULL DEFAULT 0,
                                      -- 本单积分抵扣（=points_amount 同源冗余列，§3 逐字保留）
    reschedule_used    boolean        NOT NULL DEFAULT false,
                                      -- 改期权已用（D 域消费位，本批词汇保留不接线）
    prev_enrollment_id bigint         NULL,
                                      -- 转化/改期迁移链回链（头注⑤；C4=M2）
    created_at         timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ck_enrollments_ref_type CHECK (ref_type IN ('session', 'groupbuy')),
    CONSTRAINT ck_enrollments_pay_status CHECK (pay_status IN ('PENDING', 'PAID', 'REFUNDED')),
    CONSTRAINT ck_enrollments_price_nonneg
        CHECK (unit_price >= 0 AND paid_amount >= 0 AND cash_amount >= 0),
    CONSTRAINT ck_enrollments_points_nonneg CHECK (points_amount >= 0 AND credit_used >= 0)
);

COMMENT ON TABLE trade.enrollments IS 'C3 报名（交易域第三表；pay_status 三态经守卫+state_transition_log，entity_type=enrollment；成团原子守卫=先席位计数后报名 PAID 的顺序铁律）';
COMMENT ON COLUMN trade.enrollments.price_snapshot IS 'R-03 快照价六键（头注⑦）：session_total=违约金基数单一来源（F3/D4 消费禁双端计算）';
COMMENT ON COLUMN trade.enrollments.credit_used IS '本单积分抵扣额（与 points_amount 同源：R-04 单次 ≤ 应付 50%，F4 FREEZE 幂等键=支付单）';

-- ---------- 派生索引（见头注理由） ----------
CREATE UNIQUE INDEX IF NOT EXISTS ux_enroll_active
    ON trade.enrollments (ref_type, ref_id, user_id)
    WHERE pay_status IN ('PENDING', 'PAID');
CREATE INDEX IF NOT EXISTS ix_enrollments_user
    ON trade.enrollments (user_id, created_at);

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V25：只授不验，GRANT 收窄形态照 V23/V24） ----------
-- enrollments 需要 UPDATE（pay_status 经守卫推进）；无 DELETE（交易记录法定留存，电商法 §31
-- 锚定，架构 §1.3）。
GRANT SELECT, INSERT, UPDATE ON trade.enrollments TO ljr_trade;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA trade TO ljr_trade;
