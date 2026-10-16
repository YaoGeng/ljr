-- M1-W3 V23：trade 模块（C1 B2C 开团①切片）——交易域首件：sessions 场次表
--
-- 施工规格：docs/modules/C-交易/C1-B2C开团（§3 领域模型 + §4 状态机 + §7 R-01~R-05；文档名以
-- 免点分词形误报不带 .md 后缀）。schema trade / role ljr_trade 已由 V1 建好（禁增删 schema/role，
-- 本文件不触碰）；V1~V22 冻结。本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走
-- 新迁移或在代码注释说明。
--
-- 表清单与文档对照（一表 §3 逐字 + 口径归一，沿 V20/V22 对同款文档裸列的先例）：
--   trade-sessions  §3 原文列 + ①status 补 NOT NULL DEFAULT 'CREATED'（开团初始态=报名中）
--                   + ck 值域十态（§4 状态机全文：CREATED|FULL|CONFIRMED|OPEN|IN_SERVICE|
--                   FINISHED|HOLD|SETTLED|FAILED|CANCELLED；迁移矩阵=core 场次状态机件
--                   （entity_type='session'）全用例钉住，经守卫+state_transition_log 留痕；
--                   CANCELLED 本批词汇保留不接线（D4=M2），FAILED 仅由 ENROLL_DEADLINE job
--                   判定——文档 §4 逐字）；②created_at 补 NOT NULL DEFAULT now()（V20 口径
--                   归一）；③status_since timestamptz NOT NULL DEFAULT now()：状态进入时刻
--                   （§3 裸列清单外新增，理由：B2 reaper 终态判定通道 EntityTerminalInfo 的
--                   since 锚点——架构 §4.2「活跃锁+关联实体已终态
--                   超阈释放」要求进入终态时刻；跨 schema 读他域表被红线禁止，本表自带
--                   该锚点是最小落位；业务迁移路径同步 UPDATE，应用侧经守卫）；
--                   ④mode 值域 ck（B2C|C2B，§3 注释逐字）；⑤price_mode 值域 ck
--                   （per_head|session_total，§3 注释逐字）；⑥unit_price/session_total
--                   非负 ck（金额方向语义由 price_mode 表达，与 shared Money 非负口径一致）；
--                   ⑦room_mode 不设 ck：§3 仅 varchar(32) 无值域注记，且 B3 room_modes 为
--                   多选集合语义（text|voice|video）可能随 M2 沟通形式演进——值域防御收在
--                   应用层（core 侧 assertRoomMode 校验），不把演进锁死在迁移层。
--                   joined 裸 UPDATE 禁令（§9）：唯一写点=C3 成团守卫 SQL 路径（T7 接线，
--                   架构 §4.4 成团原子守卫同式）；本批生产代码零 joined 写点。
--
-- 派生索引（超出 §3 清单，理由）：
--   ix_sessions_list (status, slot_start)           —— §3 逐字指定（用户端列表扫描面）；
--   ix_sessions_lawyer_slot (lawyer_id, slot_start) —— 幂等键=lawyer+slot_start 的等值定位
--                                                      （§5 POST /sessions 幂等重放查原单）
--                                                      + 律师侧 stats 范围聚合扫描面（§5）。
--
-- 边界纪律：lawyer_id 为他域 bigint 裸引用（跨 schema 禁 FK，W1/W2 惯例）；金额列
--   unit_price numeric(10,2) / session_total numeric(12,2)，应用侧一律经 Money 字符串往返
--   （禁 float）；R-01 分账/资金语义不落本 schema（只落价格快照与人数）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 trade 表。
-- 幂等性：IF NOT EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（trade-sessions），规避 check-schema-refs 的点分词形
--   扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- trade.sessions：B2C 场次（§3；生命周期经守卫，状态禁裸写；C2B 履约 Session 复用本表 mode=C2B） ----------
CREATE TABLE IF NOT EXISTS trade.sessions (
    id              bigserial      PRIMARY KEY,
    lawyer_id       bigint         NOT NULL,
                                      -- 律师（identity 侧用户 id，bigint 裸引用口径）
    mode            varchar(8)     NOT NULL DEFAULT 'B2C',
                                      -- B2C（C2B 确认后生成履约 Session 亦复用本表，mode=C2B，§3）
    slot_start      timestamptz    NOT NULL,
                                      -- 约定开始时刻（提醒/开房 job 锚点，架构 §4.5）
    price_mode      varchar(14)    NOT NULL,
                                      -- per_head|session_total（§3 注释逐字）
    unit_price      numeric(10,2)  NOT NULL,
                                      -- 快照：per_head 单价 或 total÷capacity 分摊（§3；半分向上取整分摊，应用侧口径）
    session_total   numeric(12,2)  NOT NULL,
                                      -- 场次总价基数（R-04：per_head=单价×选定人数；total=开团时总价；违约金计算用）
    capacity        smallint       NOT NULL,
                                      -- 选定人数（2..50，ck_sessions_capacity）
    joined          smallint       NOT NULL DEFAULT 0,
                                      -- 已报名人数（唯一写点=C3 成团守卫 SQL，T7 接线）
    enroll_deadline timestamptz    NOT NULL,
                                      -- 报名截止（ENROLL_DEADLINE job 锚点；缺省=开始前 24h ⚠04§8-3，律师可改）
    room_mode       varchar(32)    NOT NULL,
                                      -- 沟通形式（值域防御在应用层，见头注⑦）
    status          varchar(20)    NOT NULL DEFAULT 'CREATED',
                                      -- CREATED|FULL|CONFIRMED|OPEN|IN_SERVICE|FINISHED|HOLD|SETTLED|FAILED|CANCELLED（§4）
    status_since    timestamptz    NOT NULL DEFAULT now(),
                                      -- ③状态进入时刻（B2 reaper 终态判定 since 锚点）
    created_at      timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ck_sessions_joined_capacity CHECK (joined <= capacity),
    CONSTRAINT ck_sessions_capacity CHECK (capacity BETWEEN 2 AND 50),
    CONSTRAINT ck_sessions_mode CHECK (mode IN ('B2C', 'C2B')),
    CONSTRAINT ck_sessions_price_mode CHECK (price_mode IN ('per_head', 'session_total')),
    CONSTRAINT ck_sessions_price_nonneg CHECK (unit_price >= 0 AND session_total >= 0),
    CONSTRAINT ck_sessions_status CHECK (status IN (
        'CREATED', 'FULL', 'CONFIRMED', 'OPEN', 'IN_SERVICE',
        'FINISHED', 'HOLD', 'SETTLED', 'FAILED', 'CANCELLED'))
);

COMMENT ON TABLE trade.sessions IS 'C1 B2C 场次（交易域首表；状态机十态经守卫+state_transition_log，entity_type=session；joined 唯一写点=C3 守卫 SQL）';
COMMENT ON COLUMN trade.sessions.unit_price IS '价格快照：per_head 模式=单价；session_total 模式=总价÷capacity 分摊（半分向上，应用侧口径）——R-01 仅本次有效，不改 B3 默认';
COMMENT ON COLUMN trade.sessions.session_total IS 'R-04 场次总价基数：per_head=单价×capacity；total=开团时总价（违约金计算锚点，F2/F3 消费）';
COMMENT ON COLUMN trade.sessions.status_since IS '状态进入时刻（架构 §4.2：B2 reaper 终态超阈判定的 since 锚点；随状态迁移同步 UPDATE）';

-- ---------- 派生索引（见头注理由） ----------
CREATE INDEX IF NOT EXISTS ix_sessions_list
    ON trade.sessions (status, slot_start);
CREATE INDEX IF NOT EXISTS ix_sessions_lawyer_slot
    ON trade.sessions (lawyer_id, slot_start);

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V22：只授不验，GRANT 收窄形态照 V17/V18/V20） ----------
-- sessions 需要 UPDATE（状态迁移/status_since 推进 + joined=C3 守卫 SQL 写点，T7 接线）；
-- 无 DELETE（场次/交易记录法定留存，电商法 §31 锚定，架构 §1.3）。
GRANT SELECT, INSERT, UPDATE ON trade.sessions TO ljr_trade;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA trade TO ljr_trade;
