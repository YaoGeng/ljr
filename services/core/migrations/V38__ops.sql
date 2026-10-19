-- M2-W2 V38：ops 模块追加（H3 纠纷工单与退款审核）——tickets 工单主表 + ticket_actions 审计行
--
-- 事实源：docs/modules/H-运营后台/H3-纠纷工单与退款审核.md（§3 领域模型 + §7 R-01~R-04）+
-- docs/plans/M2-W2-执行计划.md 附录 A.3 V38 蓝图（T0 契约冻结，列级逐字对齐）。
-- schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V37 冻结。
--
-- 表清单与蓝图对照（附录 A.3 逐字 + 口径归一）：
--   ops-tickets（工单主表，H3 §3）：
--     id bigserial PK / category varchar(24) NOT NULL ck 七值（dispute|refund_review|price_change|
--       cancel_lt24h|reconciliation|dead_letter|export_recording，H3 §2 工单类型全集）/
--       ref_type varchar(16) NULL + ref_id bigint NULL（关联实体裸引用，跨域禁 FK 全仓口径；
--       事件工单幂等锚的组成部分）/ title varchar(128) NOT NULL / detail text NOT NULL（H3 §3
--       裸列补 NOT NULL——工单正文为处置必需信息）/ status varchar(16) NOT NULL ck 四值
--       （OPEN|PROCESSING|RESOLVED|REJECTED——状态禁裸写：迁移经守卫+STL entity_type='ticket'）/
--       priority smallint NOT NULL DEFAULT 3 / sla_due timestamptz NOT NULL（SLA 锚=created_at
--       DB 钟：对账差异 24h 硬/其余 48h 软，H3 §2——服务层配置化计算，建行同语句 now() 推导）/
--       assignee_id bigint NULL / created_at timestamptz NOT NULL DEFAULT now() / resolved_at
--       timestamptz NULL（终态时刻）。
--     派生约束（蓝图逐字）：
--       ux_tickets_category_ref 部分唯一索引 (category, ref_type, ref_id) WHERE ref_id IS NOT
--       NULL——幂等键=category+ref（⚠W2-9：事件工单去重 DB 真兜底；人工工单 ref 空不设幂等）；
--       ix_tickets_sla (sla_due) WHERE status IN ('OPEN','PROCESSING')——SLA 扫描面（未结恒少数）；
--       ix_tickets_status_created (status, created_at)——后台筛选列表面。
--   ops-ticket_actions（审计行，H3 §3「审计」）：id bigserial PK / ticket_id bigint NOT NULL
--     （本域 tickets 表 id 同域裸引用）/ action varchar(32) NOT NULL（流转/处置词汇：start_
--     processing|resolve|reject，服务层定义）/ operator_id bigint NOT NULL（处置人=identity 域
--     用户 id 裸引用；事件建单无处置人故建单不落 action 行）/ payload jsonb NOT NULL（处置载荷
--     原样留档）/ created_at timestamptz NOT NULL DEFAULT now()（补 DB 钟缺省，V7 口径归一同款）。
--     派生约束：ix_ticket_actions_ticket (ticket_id)——工单详情页审计行取数面（蓝图 ix 逐字）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 ops.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V38）可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（ops-tickets / ops-ticket_actions），规避
--   check-schema-refs 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- ops.tickets：纠纷工单主表（创建/分派/SLA/流转状态；R-01~R-04 载体） ----------
CREATE TABLE IF NOT EXISTS ops.tickets (
    id          bigserial     PRIMARY KEY,
    category    varchar(24)   NOT NULL,
                              -- 工单类型七值（H3 §2 全集；ck 值域固化）
    ref_type    varchar(16)   NULL,
                              -- 关联实体类型（session/recon_period/refund/pricing_history 等；
                              -- 事件工单幂等锚组成；人工工单可空=不设幂等 ⚠W2-9）
    ref_id      bigint        NULL,
                              -- 关联实体 id（与 ref_type 成对出现，服务层校验 both-or-neither）
    title       varchar(128)  NOT NULL,
    detail      text          NOT NULL,
                              -- 工单正文（事件工单=事件载荷 JSON 留档；人工工单=运营录入）
    status      varchar(16)   NOT NULL,
                              -- OPEN|PROCESSING|RESOLVED|REJECTED（禁裸写：守卫+STL 迁移）
    priority    smallint      NOT NULL DEFAULT 3,
                              -- 优先级（1-5；缺省 3——PRD 未定义档位语义，占位列）
    sla_due     timestamptz   NOT NULL,
                              -- SLA 到期（锚=created_at DB 钟；reconciliation 24h 硬/其余 48h 软）
    assignee_id bigint        NULL,
                              -- 分派处理人（identity 域用户 id；NULL=未分派）
    created_at  timestamptz   NOT NULL DEFAULT now(),
    resolved_at timestamptz   NULL,
                              -- 终态时刻（RESOLVED/REJECTED 落值）
    CONSTRAINT ck_tickets_category CHECK (category IN ('dispute', 'refund_review', 'price_change',
                                                       'cancel_lt24h', 'reconciliation',
                                                       'dead_letter', 'export_recording')),
    CONSTRAINT ck_tickets_status CHECK (status IN ('OPEN', 'PROCESSING', 'RESOLVED', 'REJECTED'))
);

COMMENT ON TABLE ops.tickets IS 'H3 纠纷工单：七类工单/SLA/流转（OPEN→PROCESSING→RESOLVED|REJECTED，禁裸写经守卫）；幂等键=category+ref（部分唯一，W2-9）';
COMMENT ON COLUMN ops.tickets.sla_due IS 'SLA 到期时刻：锚=created_at（DB 钟），对账差异 24h 硬/其余 48h 软（H3 §2，服务层配置化）';
COMMENT ON COLUMN ops.tickets.detail IS '工单正文：事件工单=触发事件载荷 JSON 留档（金额文本/时刻，禁 phone/id_no 等 PII）；人工工单=运营录入';

-- 幂等键=category+ref（蓝图逐字：部分唯一 WHERE ref_id 非空——人工工单 ref 空不设幂等）
CREATE UNIQUE INDEX IF NOT EXISTS ux_tickets_category_ref
    ON ops.tickets (category, ref_type, ref_id) WHERE ref_id IS NOT NULL;

-- SLA 扫描面（未结工单按到期时刻排序取数；超时率口径=H4，本批布尔/计数查询用）
CREATE INDEX IF NOT EXISTS ix_tickets_sla
    ON ops.tickets (sla_due) WHERE status IN ('OPEN', 'PROCESSING');

-- 后台筛选列表面（category/status 筛选 + 建单时间序）
CREATE INDEX IF NOT EXISTS ix_tickets_status_created
    ON ops.tickets (status, created_at);

-- ---------- ops.ticket_actions：流转/处置审计行（每次状态迁移 INSERT 一行；H3 §3「审计」） ----------
CREATE TABLE IF NOT EXISTS ops.ticket_actions (
    id          bigserial     PRIMARY KEY,
    ticket_id   bigint        NOT NULL,
                              -- 本域 tickets 表 id（同域裸引用，不设 FK 全仓口径）
    action      varchar(32)   NOT NULL,
                              -- start_processing|resolve|reject（流转/处置词汇，服务层定义）
    operator_id bigint        NOT NULL,
                              -- 处置人（identity 域用户 id；事件建单非处置不落行）
    payload     jsonb         NOT NULL,
                              -- 处置载荷原样留档（{action_payload, approved} 等）
    created_at  timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.ticket_actions IS 'H3 工单流转/处置审计行：每次状态机迁移同事务 INSERT（action/operator_id/payload）';

-- 工单详情页审计行取数面（蓝图 ix 逐字）
CREATE INDEX IF NOT EXISTS ix_ticket_actions_ticket
    ON ops.ticket_actions (ticket_id);

-- ---------- 权限（沿 V8/V32/V34 ops 先例：应用账号读写减 DELETE——工单留痕不可删） ----------
GRANT SELECT, INSERT, UPDATE ON ops.tickets TO ljr_ops;
GRANT SELECT, INSERT ON ops.ticket_actions TO ljr_ops;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO ljr_ops;
