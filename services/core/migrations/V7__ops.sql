-- M1-W1 V7：ops 模块追加（H7 规则中心）——rule_definitions 通用规则版本化唯一事实源
--
-- 施工规格：docs/modules/H-运营后台/H7-规则中心.md（§3 领域模型 + §2 变更流 + §7 R-01~R-03）。
-- schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
-- 归属裁决（M1-W1 执行计划 Task 4 控制者裁决）：rule_definitions 落 ops.*（架构 §3.2 将
-- 「规则版本化」列在 pricing 域名下，H7 文档头部口径为「pricing/credit + ops」——本表是 H7
-- 运营后台的规则治理事实源，且 M1-W1 各消费方（H5 词库/G1 信用）经 H7 机制 API 取数，
-- 不跨表 join，schema 归属不影响边界纪律）。
--
-- 表清单与文档对照：
--   ops.rule_definitions  §3 原文列逐字 + 两处口径归一（沿 V4/V5/V6 对同款文档裸列的先例）：
--     ① created_at 补 NOT NULL DEFAULT now()（§3 为裸列无；插入方无需显式传时刻）
--     ② ck_rule_defs_status CHECK 固化状态枚举（§3 为 varchar(12) 裸列；DB 兜底，
--        V5/V6 同款）——状态集=§2 三态 + ABANDONED（控制者裁决：DRAFT 可废弃为终态，
--        留痕优于删行——电商法 §34 要求规则变更历史可查；PUBLISHED 后不可废弃，
--        只能被新版本取代，守卫无 PUBLISHED→ABANDONED 边）。
--   uq_rule_defs_key_version：§3「UNIQUE(rule_key, version)」逐字（表约束形态）；
--     即 §5 幂等键=key+version 的 DB 兜底（R-03 免公示通道同受约束）。
--
-- 派生索引（超出 §3 清单，理由）：ix_rule_defs_key_version (rule_key, version DESC)
--     ——§3 快照查询「WHERE rule_key=? AND effective_at<=? ORDER BY version DESC LIMIT 1」
--     的扫描面（§8 P95 ≤30ms；单 key 版本数有限，effective_at 过滤在索引序上逐行过滤即可）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 ops.<table>。
-- 幂等性：全部 IF NOT EXISTS，reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- ops.rule_definitions：通用规则版本化（§3，R-01 唯一事实源） ----------
CREATE TABLE IF NOT EXISTS ops.rule_definitions (
    id             bigserial    PRIMARY KEY,
    rule_key       varchar(32)  NOT NULL,
                     -- 规则键（§2 规则域：price_change/credit/cancellation/disclaimer/room_notice；
                     -- H5 词库为 wordlist.* 前缀，R-03 免公示通道写入）——格式校验在服务层
    version        int          NOT NULL,
                     -- 版本号（同 key 内递增；UNIQUE(rule_key, version)=提交幂等键）
    content        jsonb        NOT NULL,
                     -- 规则内容原文（结构随 rule_key 而定；room_notice 结构由 H7 定义并在
                     -- 模块头注/报告明示，D5 按 GET /rooms/notice-content 契约消费）
    effective_at   timestamptz  NULL,
                     -- 生效时刻：PUBLISHED 提交时落 = published_at + 7 日（§2 公示期满承诺时刻，
                     -- App「即将生效」展示与快照查询锚点）；R-03 免公示通道创建即落生效时刻；
                     -- DRAFT/ABANDONED 为 NULL
    publish_status varchar(12)  NOT NULL,
                     -- DRAFT|PUBLISHED|EFFECTIVE|ABANDONED；禁裸写：迁移仅经
                     -- infrastructure/state-machine 守卫 + state_transition_log（§2 变更流三条边：
                     -- DRAFT→PUBLISHED 提交公示 / PUBLISHED→EFFECTIVE 公示期满 / DRAFT→ABANDONED 废弃）；
                     -- §9 明文禁止未公示直接 EFFECTIVE（状态机无 DRAFT→EFFECTIVE 边）。
                     -- 例外=R-03 词库免公示通道（创建即 EFFECTIVE，仅限内部机制调用，
                     -- 以 state_transition_log 显式留痕，不暴露 HTTP）
    published_at   timestamptz  NULL,
                     -- 提交公示时刻（PUBLISHED 及之后非空；R-03 免公示通道恒 NULL——未走公示流）
    created_at     timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_rule_defs_key_version UNIQUE (rule_key, version),
    CONSTRAINT ck_rule_defs_status CHECK (publish_status IN ('DRAFT', 'PUBLISHED', 'EFFECTIVE', 'ABANDONED'))
);

COMMENT ON TABLE ops.rule_definitions IS 'H7 规则中心：rule_definitions 通用规则版本化唯一事实源（R-01 公示≥7日+行为时快照，架构 §4.3 合规 R11/电商法 §34）';
COMMENT ON COLUMN ops.rule_definitions.effective_at IS '生效时刻（PUBLISHED 时=published_at+7日；R-03 免公示通道创建即落）：快照查询与「即将生效」展示锚点';
COMMENT ON COLUMN ops.rule_definitions.publish_status IS 'DRAFT|PUBLISHED|EFFECTIVE|ABANDONED；迁移经守卫+state_transition_log；§9 禁止未公示直接 EFFECTIVE（R-03 免公示通道例外，内部留痕）';

-- 快照查询扫描面（§3 查询句式 + §8 P95 预算，见头注）
CREATE INDEX IF NOT EXISTS ix_rule_defs_key_version
    ON ops.rule_definitions (rule_key, version DESC);

-- ---------- 权限（M0 占位口径，同 V1-V6 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE ON ops.rule_definitions TO ljr_ops;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO ljr_ops;
