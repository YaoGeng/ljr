-- M2-W1 V35：fulfillment 模块首表（D1 房间生命周期）——rooms 房间表
--
-- 事实源：docs/modules/D-履约/D1-房间生命周期（§3 领域模型 + §4 状态机 + §7 R-01~R-04）+
-- docs/plans/M2-W1-执行计划.md 附录 A.3 DDL 蓝图（T0 契约冻结，列级逐字）。
-- schema fulfillment / role ljr_fulfillment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V34 冻结。本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或代码注释。
--
-- 表清单与蓝图对照（附录 A.3 逐字 + 口径归一）：
--   fulfillment-rooms（D1 §3 逐字）：
--     id bigserial PK / session_id bigint UNIQUE NOT NULL（幂等键=session，§5；
--       trade-sessions 裸引用，跨 schema 禁 FK，W1/W2 惯例）/ mode varchar(8) NOT NULL
--       ck 三值（text|voice|video，场次 room_mode 透传，R-04）/ scheduled_start timestamptz
--       NOT NULL（约定开始时刻快照——经 trade 导出面取，禁直连 SQL）/ opened_at timestamptz
--       NULL / grace_end timestamptz NOT NULL / closed_at timestamptz NULL / status varchar(16)
--       NOT NULL ck 四值（OPEN|IN_SERVICE|CLOSED|CANCELLED；迁移经守卫+state_transition_log，
--       entity_type='room'；开房失败行以 CANCELLED 直插=初始态承载，同 trade-sessions
--       INSERT 'CREATED' 先例——INSERT 非迁移）/ open_fail_reason varchar(64) NULL（开房
--       失败因，mock 适配器错误码口径，非 PII）。
--   status_since 不加（简报逐字裁定）：rooms 无 reaper since 锚需求（D1 §3 逐字无该列；
--       B2 slot-locks 的 since 锚是占用锁回收语义，房间生命周期无对应机制）。
--   grace_end 应用层锚定=scheduled_start+5min（R-01：不随 opened_at 漂移——开房延迟不吞
--       宽限）；**禁 DB 表达式默认值**（GENERATED/DEFAULT 会掩盖锚点语义，简报逐字）。
--
-- 派生索引：ux_rooms_session UNIQUE(session_id)（§5 幂等键=session 的 DB 真兜底——
--   ROOM_OPEN 重放/竞态双插唯一防线；业务查询按 session 定位房间也走本索引）。
--
-- GRANT 权衡（本批口径）：rooms 需要 UPDATE（status 经守卫推进 + closed_at 落值）；
--   无 DELETE（房间记录留痕，电商法 §31 锚定，架构 §1.3）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 fulfillment 表。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V35）可重复执行。
-- 注释纪律：本文件注释以连字符指称他域表名（trade-sessions），规避 check-schema-refs 的
--   点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- fulfillment.rooms：D1 房间（开房/宽限锚/关闭状态机；grace_end 锚定约定开始时刻） ----------
CREATE TABLE IF NOT EXISTS fulfillment.rooms (
    id               bigserial     PRIMARY KEY,
    session_id       bigint        NOT NULL,
                                   -- 场次 id（trade 域裸引用，禁 FK；幂等键=session，§5）
    mode             varchar(8)    NOT NULL,
                                   -- text|voice|video（场次 room_mode 透传，R-04；ck 值域）
    scheduled_start  timestamptz   NOT NULL,
                                   -- 约定开始时刻快照（开房时经 trade 导出面取，同源锚）
    opened_at        timestamptz   NULL,
                                   -- 实际开房时刻（DB 钟；grace_end 不以本列计算——R-01）
    grace_end        timestamptz   NOT NULL,
                                   -- = scheduled_start + 5min（应用层锚定，禁 DB 默认值表达式）
    closed_at        timestamptz   NULL,
                                   -- 关闭时刻（DB 钟；close API 出参锚）
    status           varchar(16)   NOT NULL,
                                   -- OPEN|IN_SERVICE|CLOSED|CANCELLED（经守卫迁移，禁裸写）
    open_fail_reason varchar(64)   NULL,
                                   -- 开房失败因（仅 CANCELLED(开房失败) 行非空；mock 错误码口径）
    CONSTRAINT ck_rooms_mode CHECK (mode IN ('text', 'voice', 'video')),
    CONSTRAINT ck_rooms_status CHECK (status IN ('OPEN', 'IN_SERVICE', 'CLOSED', 'CANCELLED'))
);

COMMENT ON TABLE fulfillment.rooms IS 'D1 房间生命周期（履约域首表）：grace_end=scheduled_start+5min 锚定约定开始时刻不随 opened_at 漂移（R-01）；status 经守卫+state_transition_log（entity_type=room）；session_id UNIQUE=幂等键=session';
COMMENT ON COLUMN fulfillment.rooms.grace_end IS '宽限截止=scheduled_start+5min（R-01 应用层锚定；开房延迟 90s 场景仍不变——misfire 不吞宽限）';
COMMENT ON COLUMN fulfillment.rooms.open_fail_reason IS '开房失败因（RTC mock 适配器错误码；仅开房失败 CANCELLED 行携带，平台取消分支审计锚）';

-- ---------- 派生索引（幂等键 DB 真兜底） ----------
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_session ON fulfillment.rooms (session_id);

-- ---------- 权限（应用账号接线口径同 V22/V26：GRANT 收窄形态，只授所需） ----------
GRANT SELECT, INSERT, UPDATE ON fulfillment.rooms TO ljr_fulfillment;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fulfillment TO ljr_fulfillment;
