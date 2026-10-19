-- M2-W2 V46：ops 模块追加（H4 数据看板·指标管道切片，T8）——事件去重表 + 指标日表
--
-- 施工规格：docs/modules/H-运营后台/H4-数据看板.md（§3 领域模型 metrics_daily 日表 /
-- §4 Outbox 事件消费幂等 → 聚合 → 落日表 / §6 R-03 重放不双计=event_id 去重表 /
-- §7 R-01 口径=架构 §7.2 映射表）+ docs/plans/M2-W2-执行计划.md T8 行与附录 A.3 蓝图
-- （列级逐字）。schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，不触碰）。
--
-- **迁移号顺延（附录 A.3 勘误）**：原排 H4=V43__ops，实况 V40~V45 已被 C5/F4/H5 占用
-- （V40 C4 ck 扩/V41 C4 session_id/V42 C5/V43 F4 benefits/V44 F4 pricing/V45 H5），
-- 本文件取 V46 ⇒ 周批 DoD flyway validate 至 V1~V46。
--
-- 形态裁定（任务简报+控制者最小面）：
--   - 消费即聚合：metrics_daily 由 metrics consumer 在事件消费事务内按日增量 upsert
--     （R-03 去重与聚合同事务）——不建独立 T+1 job（语义等同且少一个调度面）；
--   - metrics_realtime 不建表（⚠W2-6 dev 口径）：实时面=查询时 SQL 聚合直查
--     metrics_daily（事件流聚合的唯一物化层）；
--   - 本迁移只建两表：events_consumed + metrics_daily。
--
-- 幂等性：reset 演练（drop schema 整库重放）可重复执行；纯 CREATE 无状态回填。

-- ---------- ops.events_consumed：R-03 事件去重表（重放不双计的唯一承载） ----------
CREATE TABLE ops.events_consumed (
    event_id    varchar(64)   NOT NULL,
    topic       varchar(64)   NOT NULL,
    consumed_at timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_events_consumed PRIMARY KEY (event_id)
);

COMMENT ON TABLE ops.events_consumed IS 'H4 指标管道事件去重表（M2-W2 T8，R-03）：event_id=platform.outbox.event_id 同文；消费事务首步 INSERT ON CONFLICT 短路，重放事件零二次聚合';
COMMENT ON COLUMN ops.events_consumed.event_id IS '事件幂等键（outbox event_id uuid 文本，36 字符；varchar(64)=A.3 蓝图列宽）';
COMMENT ON COLUMN ops.events_consumed.topic IS '事件 topic（审计/回查位；去重判定不依赖）';

-- ---------- ops.metrics_daily：指标日表（metric_key+dim+day 唯一，事件增量累加） ----------
CREATE TABLE ops.metrics_daily (
    metric_key   varchar(48)  NOT NULL,
    dim          varchar(48)  NOT NULL DEFAULT '',
    day          date         NOT NULL,
    value        numeric(14,4) NOT NULL,
    computed_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pk_metrics_daily PRIMARY KEY (metric_key, dim, day)
);

COMMENT ON TABLE ops.metrics_daily IS 'H4 指标日表（M2-W2 T8）：事件流计数器按上海日累加（消费即聚合，无 T+1 job）；查询面（/admin/dashboard/metrics）按窗口 SUM 后在应用层算比率——比率不入表（口径唯一事实源=架构 §7.2 映射表）';
COMMENT ON COLUMN ops.metrics_daily.metric_key IS '计数器键（词汇表=MC_* 常量，metrics 模块 types 文件承载；比率键不入本表）';
COMMENT ON COLUMN ops.metrics_daily.dim IS '维度切片（空串=全域；mode:B2C/user:{id}/lawyer:{id}/category:{x}/role:user）';
COMMENT ON COLUMN ops.metrics_daily.day IS '聚合日（上海日界；=事件消费时刻的上海日期——重放已被 events_consumed 短路，无跨日漂移面）';
COMMENT ON COLUMN ops.metrics_daily.value IS '计数累加值（numeric(14,4)=A.3 蓝图列宽；计数恒整数，评价维度和可为整数——比率查询时计算不入表）';

-- 权限：新表沿 M0 占位口径（V1 已把 ops.* 全表授 ljr_ops；列级/细粒度=M3+ 收紧面，同 V33/V38/V45 注记）
