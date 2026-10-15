-- M1-W2 V17：pricing 模块（B3 默认价格与1对1价格配置）——价格配置版本表
--
-- 施工规格：docs/modules/B-律师配置/B3-默认价格与1对1价格配置.md（§3 领域模型 + §7 R-01~R-04）。
-- schema pricing / role ljr_pricing 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V16 冻结。
--
-- 表清单与文档对照：
--   pricing.price_versions  §3 逐字 + 五处口径归一（沿 V13/V16 对同款文档裸列的先例）：
--     ① created_at 补 NOT NULL DEFAULT now()（§3 为裸列名）
--     ② ck_price_versions_pricing_mode 固化 R-01 二选一字面：(per_head IS NOT NULL) <> (session_total IS NOT NULL)
--     ③ ck_price_versions_accept / ck_price_versions_group_size 固化 R-W2 简报裁决：
--        group_size/accept_min/accept_max 正数；accept_min ≤ accept_max（NULL 通行=列本身可空）
--     ④ ck_price_versions_room_modes 固化 room_modes 值域（<@ text|voice|video 包含判定）；
--        数组内去重/形态由应用层校验（CHECK 无法表达 DISTINCT，简报授权「值域 CHECK 或应用校验」，双层分工报告注明）
--     ⑤ ck_price_versions_1v1_range 固化 R-02 区间（DB 兜底层）：三通道键必须存在（IS NOT NULL，
--        防 jsonb 缺键在 CHECK 里静默 NULL 通行）且 文字 per_round ∈ [50,300]、语音/视频 per_15min ∈ [100,500]；
--        应用校验双层在 B3 service（TDD 边界矩阵 49/50/300/301、99/100/500/501）
--   UNIQUE(lawyer_id, version)（§3 原文）= 版本分配的最终防线（应用侧经事务内 advisory lock 串行化分配，
--   见 pricing.service——「version 取当前最大+1」在并发 PUT 下靠 UNIQUE 兜底为 409 语义之外的硬错误）。
--
-- R-03 版本不可变（§9「禁止直接 UPDATE 已有版本行」）：tg_price_versions_immutable 触发器硬禁
--   UPDATE/DELETE（简报裁量加分项，采纳——与「状态字段禁裸写」同精神；历史版本是 C3 快照与 C6
--   引擎基线的事实源）。GRANT 只授 SELECT/INSERT（无 UPDATE/DELETE 权限位，双保险）。
--
-- 边界纪律：lawyer_id 为 identity 侧 bigint 裸引用（跨 schema 禁 FK，W1/W2 惯例）；
-- 金额列 numeric(10,2)（§3 口径），应用侧一律经 @ljr/shared Money 字符串往返（禁 float）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 pricing.<table>。
-- 幂等性：IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS，reset 整库重放可重复执行。

-- ---------- pricing.price_versions：价格配置版本表（§3，R-03 只 INSERT 不改） ----------
CREATE TABLE IF NOT EXISTS pricing.price_versions (
    id                bigserial      PRIMARY KEY,
    lawyer_id         bigint         NOT NULL,
                                     -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    version           int            NOT NULL,
                                     -- 从 1 递增；分配=当前最大 version+1（事务内 advisory lock 串行化）
    per_head          numeric(10,2)  NULL,
                                     -- 人头价（R-01 二选一计价模式：单价×实际成团人数）
    session_total     numeric(10,2)  NULL,
                                     -- 场次总价（R-01 二选一：C2B 分摊额=总价÷子范围最低人数）
    group_size        smallint       NULL,
                                     -- 开团固定人数（正数）
    accept_min        smallint       NULL,
    accept_max        smallint       NULL,
                                     -- 接受拼团范围（正数；accept_min ≤ accept_max）
    room_modes        varchar(32)[]  NULL,
                                     -- 房间沟通形式多选：text|voice|video（值域 CHECK；空数组=未选择）
    one_on_one_prices jsonb          NOT NULL,
                                     -- {text:{per_round}, voice:{per_15min}, video:{per_15min}}（三通道全量必填）
    created_at        timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ux_price_versions_lawyer_version UNIQUE (lawyer_id, version),
    CONSTRAINT ck_price_versions_pricing_mode
        CHECK ((per_head IS NOT NULL) <> (session_total IS NOT NULL)),
    CONSTRAINT ck_price_versions_accept
        CHECK ((accept_min IS NULL OR accept_min > 0)
           AND (accept_max IS NULL OR accept_max > 0)
           AND (accept_min IS NULL OR accept_max IS NULL OR accept_min <= accept_max)),
    CONSTRAINT ck_price_versions_group_size CHECK (group_size IS NULL OR group_size > 0),
    CONSTRAINT ck_price_versions_room_modes
        CHECK (room_modes IS NULL OR room_modes <@ ARRAY['text', 'voice', 'video']::varchar[]),
    CONSTRAINT ck_price_versions_1v1_range
        CHECK ((one_on_one_prices -> 'text' ->> 'per_round') IS NOT NULL
           AND (one_on_one_prices -> 'voice' ->> 'per_15min') IS NOT NULL
           AND (one_on_one_prices -> 'video' ->> 'per_15min') IS NOT NULL
           AND (one_on_one_prices -> 'text' ->> 'per_round')::numeric BETWEEN 50 AND 300
           AND (one_on_one_prices -> 'voice' ->> 'per_15min')::numeric BETWEEN 100 AND 500
           AND (one_on_one_prices -> 'video' ->> 'per_15min')::numeric BETWEEN 100 AND 500)
);

COMMENT ON TABLE pricing.price_versions IS 'B3 价格配置版本表（R-01 二选一计价 + R-02 1对1 区间 + R-03 版本不可变：只 INSERT，修改=新版本）';
COMMENT ON COLUMN pricing.price_versions.one_on_one_prices IS '1对1 价格矩阵：{text:{per_round}, voice:{per_15min}, video:{per_15min}}；三通道全量必填；区间 DB CHECK（R-02）+应用层双层';
COMMENT ON COLUMN pricing.price_versions.room_modes IS '房间沟通形式多选（text|voice|video）：值域经 ck_price_versions_room_modes；去重/形态应用层校验；NULL=未配置，[]=未选择';

-- 当前版本读取锚点：UNIQUE(lawyer_id, version) 前缀即覆盖 WHERE lawyer_id ORDER BY version DESC
-- （§5 GET 当前版/PUT max+1/history 全走此索引；§3 清单之外不加索引）。

-- ---------- R-03 版本不可变触发器（禁 UPDATE/DELETE；TRUNCATE 不经行触发器，清场不受影响） ----------
CREATE OR REPLACE FUNCTION pricing.fn_price_versions_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'pricing.price_versions 版本行不可变（R-03）：禁止 %，修改请 INSERT 新版本', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_price_versions_immutable ON pricing.price_versions;
CREATE TRIGGER tg_price_versions_immutable
    BEFORE UPDATE OR DELETE ON pricing.price_versions
    FOR EACH ROW EXECUTE FUNCTION pricing.fn_price_versions_immutable();

-- ---------- 权限（R-03 双保险：无 UPDATE/DELETE 权限位；应用账号接线是 M1 接线决策，同 V1-V16） ----------
GRANT SELECT, INSERT ON pricing.price_versions TO ljr_pricing;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pricing TO ljr_pricing;
