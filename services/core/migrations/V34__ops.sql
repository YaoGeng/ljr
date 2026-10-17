-- M1-W4 V34：ops 模块追加（H4 资损巡检首轮）——巡检运行记录 + 违例台账两表
--
-- 施工依据：docs/02-架构设计.md §7.2「资损不变量巡检 job（分钟级）」五类不变量 +
-- docs/plans/M1-W4-执行计划.md 序 1（⚠W4-2 裁决：巡检执行器+违例台账落 ops 域 patrol 子模块，
-- 检测 SQL 各域自持、跨域核对走既有导出接口应用层聚合）+ M1-W4 Task 1 简报「迁移：V34__ops」。
-- schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V33 冻结。
--
-- 表清单与简报对照（两表简报列清单逐字 + 口径归一，沿 V32 对同款简报裸列的先例）：
--   ops-patrol_runs（巡检运行记录）：
--     id/started_at（补 DEFAULT now()）/finished_at/status(RUNNING|DONE|FAILED，ck 值域)/
--     checked_counts jsonb（补 NOT NULL DEFAULT '{}'+每 kind 计数形状由服务层保证）/
--     finding_count（补 NOT NULL DEFAULT 0 + 非负 ck——本轮新入账违例数，非在册未处置总数）。
--   ops-patrol_findings（违例台账）：
--     id/run_id bigint 裸引用（同 schema 仍不设 FK，全仓零 FK 口径）/kind 五类枚举 ck
--     （PAID_NOT_REFUNDED|STALE_LOCK|SCHED_BACKLOG|SPLIT_UNCONFIRMED|COMPENSATION_UNPAID——
--     架构 §7.2 五类为全集，禁第六类）/ref_type varchar(16)/ref_id bigint
--     （SCHED_BACKLOG 聚合面用 ref_id=0 哨兵，故不设正性 ck）/detail jsonb NOT NULL
--     （PII 红线：只放 id/状态/金额文本/时刻，禁 phone/id_no 等）/severity ck
--     （INFO|WARN|CRITICAL）/detected_at（补 DEFAULT now()）/resolved_at NULL。
--     kind↔ref_type 配对 ck：五类各自钉死指向实体词汇（enrollment/slot_lock/schedule_jobs/
--     split_ledger/pricing_history），防跨类错挂行。
--   去重锚（简报逐字）：ux_patrol_findings_open 部分唯一索引 (kind, ref_type, ref_id)
--     WHERE resolved_at IS NULL——同违例未处置不重复入账（服务层 INSERT ... ON CONFLICT DO
--     NOTHING 配套；resolved 翻转后同键可再入账=处置后复发可追踪）。
--
-- GRANT 权衡（简报留给实现者裁决，本批口径）：
--   runs 全量 DML 减 DELETE（SELECT/INSERT/UPDATE——status/finished_at/checked_counts/
--     finding_count 的开轮与关轮写；无 DELETE=运行记录留痕）；
--   findings 只授 SELECT/INSERT（不可变留痕台账）：本批无 resolved_at 翻转代码路径
--     （巡检只检测不修复，处置面=M2 H3 dead_letter 工单接线），故不授 UPDATE——
--     届时处置面需要「resolved 翻转=UPDATE resolved_at 单列」再走独立 GRANT 迁移收窄授权，
--     避免本批开出无人使用的写权。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 ops.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V34）可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（ops-patrol_runs），规避 check-schema-refs 的
--   点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- ops.patrol_runs：巡检运行记录（每轮一行；RISK_PATROL job 执行轨迹） ----------
CREATE TABLE IF NOT EXISTS ops.patrol_runs (
    id             bigserial     PRIMARY KEY,
    started_at     timestamptz   NOT NULL DEFAULT now(),
    finished_at    timestamptz   NULL,
    status         varchar(8)    NOT NULL DEFAULT 'RUNNING',
    checked_counts jsonb         NOT NULL DEFAULT '{}'::jsonb,
    finding_count  int           NOT NULL DEFAULT 0,
    CONSTRAINT ck_patrol_runs_status CHECK (status IN ('RUNNING', 'DONE', 'FAILED')),
    CONSTRAINT ck_patrol_runs_finding_count CHECK (finding_count >= 0)
);

COMMENT ON TABLE ops.patrol_runs IS 'H4 资损巡检运行记录（RISK_PATROL 每轮一行；单类失败不拖垮整轮，类级错误记 checked_counts 的 err 键）';
COMMENT ON COLUMN ops.patrol_runs.checked_counts IS '每 kind 计数形状（服务层保证）：{checked,findings,inserted[,err]}——checked=扫描候选数/findings=违例判定数/inserted=去重后新入账数';
COMMENT ON COLUMN ops.patrol_runs.finding_count IS '本轮新入账违例数（Σinserted；在册未处置违例重复检出经 dedup 不重复计数）';

-- 运维读侧：最近轮次视图扫描面
CREATE INDEX IF NOT EXISTS ix_patrol_runs_started
    ON ops.patrol_runs (started_at DESC);

-- ---------- ops.patrol_findings：资损违例台账（不可变留痕；dedup=kind+ref 未处置） ----------
CREATE TABLE IF NOT EXISTS ops.patrol_findings (
    id          bigserial     PRIMARY KEY,
    run_id      bigint        NOT NULL,
    kind        varchar(24)   NOT NULL,
    ref_type    varchar(16)   NOT NULL,
    ref_id      bigint        NOT NULL,
    detail      jsonb         NOT NULL,
    severity    varchar(8)    NOT NULL,
    detected_at timestamptz   NOT NULL DEFAULT now(),
    resolved_at timestamptz   NULL,
    CONSTRAINT ck_patrol_findings_kind CHECK (kind IN (
        'PAID_NOT_REFUNDED', 'STALE_LOCK', 'SCHED_BACKLOG',
        'SPLIT_UNCONFIRMED', 'COMPENSATION_UNPAID')),
    CONSTRAINT ck_patrol_findings_severity CHECK (severity IN ('INFO', 'WARN', 'CRITICAL')),
    CONSTRAINT ck_patrol_findings_ref_type_len CHECK (char_length(ref_type) BETWEEN 1 AND 16),
    CONSTRAINT ck_patrol_findings_pairing CHECK (
        (kind = 'PAID_NOT_REFUNDED' AND ref_type = 'enrollment')
        OR (kind = 'STALE_LOCK' AND ref_type = 'slot_lock')
        OR (kind = 'SCHED_BACKLOG' AND ref_type = 'schedule_jobs')
        OR (kind = 'SPLIT_UNCONFIRMED' AND ref_type = 'split_ledger')
        OR (kind = 'COMPENSATION_UNPAID' AND ref_type = 'pricing_history'))
);

COMMENT ON TABLE ops.patrol_findings IS 'H4 资损违例台账（架构 §7.2 五类不变量全集；行不可变=GRANT 只授 SELECT/INSERT；resolved 处置面=M2 H3 工单接线时另走 GRANT 迁移）';
COMMENT ON COLUMN ops.patrol_findings.run_id IS '首发轮 patrol_runs 行主键裸引用（同 schema 不设 FK，全仓零 FK 口径）';
COMMENT ON COLUMN ops.patrol_findings.ref_id IS '违例指向实体 id；SCHED_BACKLOG 聚合面=0 哨兵（积压是队列级非单行级违例）';
COMMENT ON COLUMN ops.patrol_findings.detail IS '违例上下文（id/状态/金额文本/时刻；PII 红线：禁 phone/id_no/账户密钥等敏感字段）';
COMMENT ON COLUMN ops.patrol_findings.resolved_at IS '处置时刻（NULL=未处置=dedup 锚谓词；翻转后同键复发可再入账；处置面 M2）';

-- 去重锚（简报逐字）：同 kind+ref_type+ref_id 未处置不重复入账（部分唯一索引物理兜底）
CREATE UNIQUE INDEX IF NOT EXISTS ux_patrol_findings_open
    ON ops.patrol_findings (kind, ref_type, ref_id)
    WHERE resolved_at IS NULL;

-- 运维读侧：未处置违例按严重度+发现序清单扫描面
CREATE INDEX IF NOT EXISTS ix_patrol_findings_open_list
    ON ops.patrol_findings (severity, detected_at DESC)
    WHERE resolved_at IS NULL;

-- ---------- 权限（应用账号接线口径同 V32：GRANT 收窄形态，只授所需） ----------
-- runs：开轮 INSERT + 关轮 UPDATE（status/finished_at/计数列），无 DELETE（运行记录留痕）；
-- findings：只授 SELECT/INSERT——不可变留痕台账，本批无 resolved 翻转代码路径（头注 GRANT 权衡）。
GRANT SELECT, INSERT, UPDATE ON ops.patrol_runs TO ljr_ops;
GRANT SELECT, INSERT ON ops.patrol_findings TO ljr_ops;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO ljr_ops;
