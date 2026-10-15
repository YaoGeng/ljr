-- M1-W2 V16：schedule 模块追加（B1 时间表管理）——按周重复的可预约时间段模板 + 律师时间表版本
--
-- 施工规格：docs/modules/B-律师配置/B1-时间表管理.md（§3 领域模型 + §4 关键流程 + §7 R-01~R-03）。
-- schema schedule / role ljr_schedule 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
-- 同 schedule schema 追加（B1 与 I2/B2 同 owner schema，M1-W2 执行计划 Task 4 裁决），不新建 schema。
--
-- 表清单与文档对照：
--   schedule.time_slot_templates  §3 逐字 + 三处口径归一（沿 V4/V5/V6 对同款文档裸列的先例）：
--     ① created_at 补 NOT NULL DEFAULT now()（§3 为裸列名；插入方无需显式传时刻）
--     ② ck_time_slot_templates_weekday 固化 §3 CHECK 字面（0-6；0=周日..6=周六，JS getUTCDay/PG DOW 同口径）
--     ③ ck_time_slot_templates_duration 固化 §3 CHECK 字面（IN (60,90,120)，R-03 DB 兜底层；应用校验双层在 B1 service）
--   schedule.lawyer_schedule_versions  裁量新增表（文档缺口回写项，A1 verify_codes R6 先例）：
--     §5 PUT 幂等键=lawyer+version 的服务端承载位——version 语义最小化（简报本任务裁决）：服务端当前
--     version 与入参一致才接受全量替换（否则 409），每次成功替换 +1；无行=0。§3 无此表，收尾随 §10 回写 B1 §3。
--
-- 边界纪律：lawyer_id 为 identity 侧 bigint 裸引用（跨 schema 禁 FK，W1/W2 惯例）；
-- 模板不参与唯一约束（R-02：唯一性防线只在 B2 slot_locks 的 ux_slot_active），本表不建业务唯一索引；
-- 物化结果不落库（§3/§4）：具体时刻由 slot_locks 承载，B1 只算候选+视图。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 schedule.<table>。
-- 幂等性：全部 IF NOT EXISTS，reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- schedule.time_slot_templates：可预约时间段模板（§3） ----------
CREATE TABLE IF NOT EXISTS schedule.time_slot_templates (
    id             bigserial     PRIMARY KEY,
    lawyer_id      bigint        NOT NULL,
                   -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    weekday        smallint      NOT NULL CONSTRAINT ck_time_slot_templates_weekday CHECK (weekday BETWEEN 0 AND 6),
                   -- 0=周日..6=周六（JS getUTCDay / PG extract(dow) 同口径）；物化=日历日 weekday 匹配
    start_time     time          NOT NULL,
                   -- 当日开拍墙钟时刻；物化 slot_start = date AT TIME ZONE 'Asia/Shanghai' + start_time（§4）
    duration_small smallint      NOT NULL CONSTRAINT ck_time_slot_templates_duration CHECK (duration_small IN (60, 90, 120)),
                   -- 单场时长三档（R-03，分钟）；DB CHECK + 应用校验双层
    enabled        boolean       NOT NULL DEFAULT true,
                   -- 禁用只影响未来物化候选（R-01）：既有 slot_locks 不受影响照常履约
    created_at     timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE schedule.time_slot_templates IS 'B1 可预约时间段模板（R-01/R-02）：按周重复；模板不参与唯一约束，物化结果不落库（具体时刻由 B2 slot_locks 承载）';
COMMENT ON COLUMN schedule.time_slot_templates.duration_small IS '单场时长三档（R-03，分钟）：60/90/120；DB CHECK+应用校验双层';
COMMENT ON COLUMN schedule.time_slot_templates.enabled IS '禁用只影响未来物化候选（R-01）：既有 slot_locks 照常活跃';

-- 律师时间表读取锚点（§5 GET / 物化 WHERE lawyer_id+weekday；裁量索引：单律师数十行量级，轻索引即够，
-- V5 ux_schedule_jobs_type_ref_live 先例=超出 §3 清单须给理由）
CREATE INDEX IF NOT EXISTS ix_time_slot_templates_lawyer
    ON schedule.time_slot_templates (lawyer_id, weekday);

-- ---------- schedule.lawyer_schedule_versions：时间表版本（§5 PUT 幂等键=lawyer+version 承载位；裁量新增，见头注） ----------
CREATE TABLE IF NOT EXISTS schedule.lawyer_schedule_versions (
    lawyer_id  bigint        PRIMARY KEY,
    version    integer       NOT NULL,
                   -- 服务端当前时间表版本：成功全量替换 +1；PUT 入参 version 与当前一致才接受（否则 409）
    updated_at timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE schedule.lawyer_schedule_versions IS 'B1 时间表版本（§5 PUT 幂等键=lawyer+version 承载位；裁量新增表=文档缺口回写项）';
COMMENT ON COLUMN schedule.lawyer_schedule_versions.version IS '服务端当前版本：成功替换 +1；无行=0（首次 PUT 入参 0）';

-- ---------- 权限（M0 占位口径，同 V1-V15 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON schedule.time_slot_templates TO ljr_schedule;
GRANT SELECT, INSERT, UPDATE ON schedule.lawyer_schedule_versions TO ljr_schedule;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA schedule TO ljr_schedule;
