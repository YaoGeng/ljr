-- M1-W3 V24：trade 模块（C2 C2B 发起拼团切片）——交易域第二表：group_buys 拼团任务表
--
-- 施工规格：docs/modules/C-交易/C2-C2B发起拼团（§3 领域模型 + §4 状态机 + §7 R-01~R-05；文档名以
-- 免点分词形误报不带 .md 后缀）。schema trade / role ljr_trade 已由 V1 建好（禁增删 schema/role，
-- 本文件不触碰）；V1~V23 冻结。本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走
-- 新迁移或在代码注释说明。
--
-- 表清单与文档对照（trade-group-buys §3 逐字 + 口径归一，沿 V23 对同款文档裸列的先例）：
--   ①status 补 NOT NULL DEFAULT 'PUBLISHED'（发布初始态=拼团中）+ ck 值域八态（§4 状态机全文：
--     PUBLISHED|REACHED|PENDING_LAWYER|CONFIRMED|EXPIRED|REJECTED|REFUNDED|CONVERTED；迁移
--     矩阵=core 拼团状态机件（entity_type='group_buy'）全用例钉住，经守卫+state_transition_log
--     留痕；REFUNDED 仅由 F2 退款完成推进（T6/M2 接线）、CONVERTED 仅由 C4 认领转化推进
--     （C4=M2）、CONFIRMED 仅由 C4 律师确认推进（C4=M2）——本批三者只声明边，无生产者）；
--   ②created_at 补 NOT NULL DEFAULT now()（V20/V23 口径归一）；
--   ③status_since timestamptz NOT NULL DEFAULT now()：状态进入时刻（§3 裸列清单外新增，理由：
--     B2 reaper 终态判定通道 EntityTerminalInfo 的 since 锚点——架构 §4.2「活跃锁+关联实体已
--     终态超阈释放」要求进入终态时刻；groupbuy 终态 provider（本批落位）读本列，V23 sessions
--     同款先例）；业务迁移路径同步 UPDATE，应用侧经守卫；
--   ④source_id bigint NULL（§3 裸列清单外新增，理由：§5 POST /group-buys/{id}/recreate 幂等键
--     =source_id（M1-W3 T5 简报裁决，F1 R-02 口径：同 source 重放=幂等返回已建任务）——幂等键
--     的事实源列；部分唯一索引 ux_group_buys_source 承载，NULL（自然发布）不参与；
--   ⑤question_tags jsonb NOT NULL：E3 问题树引导的多选标签数组（形态防御在应用层：
--     字符串数组 1..64 字符/项、≤20 项；不设 DB 值域 CHECK 留 M2 结构演进位）；
--   ⑥joined 不落本表（§3 逐字无此列）：已加入数的事实源=C3 enrollments（T7 落位），列表
--     「已加入数」经跨模块服务面取数（禁跨 schema join）——W3 无 enrollments，列表 joined
--     出 null 桩（SessionStatsView attendance_rate 同款先例）。
--
-- 派生索引（超出 §3 清单，理由）：
--   ux_group_buys_source (source_id) WHERE source_id IS NOT NULL
--                                     —— recreate 幂等键 DB 真兜底（F1 R-02 口径，头注④）；
--   ix_group_buys_list (status, specialty, deadline)
--                                     —— GET /group-buys?specialty= 公开列表扫描面
--                                     （仅 PUBLISHED + 专项过滤 + 倒计时序，§5）；
--   ix_group_buys_initiator_slot (initiator_id, slot_start)
--                                     —— POST /group-buys 幂等键=user+slot_start 的等值定位
--                                     （非终态查原单，C1 sessions 幂等先例同款）。
--
-- 边界纪律：initiator_id/lawyer_id 为他域 bigint 裸引用（跨 schema 禁 FK，W1/W2/W3 惯例）；
--   金额列 share_price numeric(10,2)（=session_total_default÷sub_min 发布时固化，R-02 HALF_UP
--   两位，应用侧一律经 Money 字符串往返禁 float）；锁语义不落本表（B2 slot_locks.ref_type=
--   'groupbuy' 持有，PENDING_PAYMENT 发布锁绑发起人支付单——架构 §4.2）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 trade 表。
-- 幂等性：IF NOT EXISTS，reset 整库重放可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（trade-group-buys），规避 check-schema-refs 的点分词形
--   扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- trade.group_buys：C2B 拼团任务（§3；生命周期经守卫，状态禁裸写） ----------
CREATE TABLE IF NOT EXISTS trade.group_buys (
    id                bigserial      PRIMARY KEY,
    initiator_id      bigint         NOT NULL,
                                     -- 发起人（identity 侧用户 id，bigint 裸引用口径）
    lawyer_id         bigint         NOT NULL,
                                     -- 目标律师（identity 侧用户 id，bigint 裸引用口径）
    specialty         varchar(32)    NOT NULL,
                                     -- 专项（V1 仅 labor_arbitration，E3 R-04）
    slot_start        timestamptz    NOT NULL,
                                     -- 约定开始时刻（B2 发布锁 slot 锚、R-W3-G 未来时刻校验）
    sub_min           smallint       NOT NULL,
                                     -- 子范围下限（R-01 ⊆ B3 accept_min/accept_max；R-04 创建后不可变）
    sub_max           smallint       NOT NULL,
                                     -- 子范围上限（R-01/R-04 同上）
    share_price       numeric(10,2)  NOT NULL,
                                     -- R-02 分摊额快照=session_total_default÷sub_min（发布时固化，
                                     -- 律师后改价不影响；HALF_UP 两位）
    question_tags     jsonb          NOT NULL,
                                     -- 结构化问题标签（E3 问题树引导，头注⑤）
    deadline          timestamptz    NOT NULL,
                                     -- 成团截止（缺省=开始前 24h ⚠04§8-3；ENROLL_DEADLINE job 锚点）
    status            varchar(20)    NOT NULL DEFAULT 'PUBLISHED',
                                     -- PUBLISHED|REACHED|PENDING_LAWYER|CONFIRMED|EXPIRED|REJECTED|
                                     -- REFUNDED|CONVERTED（§4，头注①）
    lawyer_confirm_by timestamptz    NULL,
                                     -- 律师确认截止（REACHED 时点+12h；C2B_CONFIRM_TIMEOUT job 锚点）
    source_id         bigint         NULL,
                                     -- 一键重新发起的源任务 id（§5 幂等键=source_id，头注④）
    status_since      timestamptz    NOT NULL DEFAULT now(),
                                     -- ③状态进入时刻（B2 reaper 终态判定 since 锚点）
    created_at        timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ck_group_buys_sub_range CHECK (sub_min <= sub_max),
    CONSTRAINT ck_group_buys_share_nonneg CHECK (share_price >= 0),
    CONSTRAINT ck_group_buys_status CHECK (status IN (
        'PUBLISHED', 'REACHED', 'PENDING_LAWYER', 'CONFIRMED',
        'EXPIRED', 'REJECTED', 'REFUNDED', 'CONVERTED'))
);

COMMENT ON TABLE trade.group_buys IS 'C2B 拼团任务（交易域第二表；状态机八态九边经守卫+state_transition_log，entity_type=group_buy；发布锁=B2 PENDING_PAYMENT 绑支付单）';
COMMENT ON COLUMN trade.group_buys.share_price IS 'R-02 分摊额快照=B3 默认场次总价÷sub_min（发布时固化，HALF_UP 两位；律师后改价不影响——R-03 加入者按此快照价支付）';
COMMENT ON COLUMN trade.group_buys.status_since IS '状态进入时刻（架构 §4.2：B2 reaper 终态超阈判定的 since 锚点；随状态迁移同步 UPDATE）';
COMMENT ON COLUMN trade.group_buys.source_id IS '一键重新发起源任务 id（POST /group-buys/{id}/recreate 幂等键=source_id；ux_group_buys_source 部分唯一承载）';

-- ---------- 派生索引（见头注理由） ----------
CREATE UNIQUE INDEX IF NOT EXISTS ux_group_buys_source
    ON trade.group_buys (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_group_buys_list
    ON trade.group_buys (status, specialty, deadline);
CREATE INDEX IF NOT EXISTS ix_group_buys_initiator_slot
    ON trade.group_buys (initiator_id, slot_start);

-- ---------- 权限（应用账号接线是 M1 接线决策，同 V1~V23：只授不验，GRANT 收窄形态照 V23） ----------
-- group_buys 需要 UPDATE（状态迁移/status_since/lawyer_confirm_by 推进）；无 DELETE（交易记录
-- 法定留存，电商法 §31 锚定，架构 §1.3）。
GRANT SELECT, INSERT, UPDATE ON trade.group_buys TO ljr_trade;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA trade TO ljr_trade;
