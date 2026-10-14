-- M1-W1 V5：schedule 模块（I2 调度中心）——DB 到期任务表事实源 + 调度执行日志（ADR-0003 自研 TS 调度器）
--
-- 施工规格：docs/modules/I-平台支撑/I2-调度中心.md（§3 领域模型 + §4 关键流程/job 全集对照表 + §7 规则）；
-- 机制裁决：docs/decisions/ADR-0003-调度器TS平替.md（schedule_jobs 事实源 + FOR UPDATE SKIP LOCKED 抢占
-- + 执行器幂等回查 + 重试退避 + ROOM_OPEN 高优先级队列 ≤5s + schedule_job_log 可重放）。
-- schema schedule / role ljr_schedule 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 表清单与文档对照：
--   schedule.schedule_jobs     §3 原文列 + 两裁量列（next_retry_at/last_error，口径同 platform.outbox：
--                              next_retry_at=失败退避后的拾取门槛，保持 due_at 为业务锚定时刻不被重试污染
--                              ——积压监控/ROOM_OPEN 延迟告警仍按 due_at 判定；last_error=终态失败诊断）
--   schedule.schedule_job_log  §3 原文列 + 一裁量列（detail，失败/重试诊断消息——FAILED 告警工单与
--                              log 重放排查的落点；result 存枚举，诊断文本不塞枚举列）
--
-- 裁量约束（超出 §3 清单的部分，逐一给理由）：
--   ux_schedule_jobs_type_ref_live：§5「幂等键=type+ref」的 DB 兜底（notify.notifications.idempotency_key
--                              同款手法，I1 R-03 先例）——部分唯一索引只盖在册（PENDING|RUNNING）行，
--                              终态行不阻止同键新 job（重开团/周期自投等场景合法）。
--   ck_schedule_job_log_result：result 枚举固化（DONE|CANCELLED|RETRY|FAILED|NO_EXECUTOR），重放口径稳定。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 schedule.<table>。
-- 幂等性：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING，reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- schedule.schedule_jobs：到期任务表（§3，R-01 事实源） ----------
CREATE TABLE IF NOT EXISTS schedule.schedule_jobs (
    id            bigserial     PRIMARY KEY,
    job_type      varchar(32)   NOT NULL,
                    -- 全集 22 种（I2 §2 枚举 + §4 对照表 FIRM_REVERIFY + 控制者裁决 R2 增 RULE_EFFECTIVE；
                    -- 注册表=schedule 模块 catalog 常量，RESTRICTION_EXPIRE 明确排除——G1 惰性失效不建 job）
    ref_type      varchar(16)   NULL,
                    -- 幂等键 ref 半边（业务实体类型）；经 REGISTER_JOB 写入时必填（幂等键完整性，服务层校验）
    ref_id        bigint        NULL,
                    -- 幂等键 ref 另半边（业务实体 id）
    due_at        timestamptz   NOT NULL,
                    -- 业务锚定时刻（宽限期/缺席判定锚定约定开始时刻，架构 §4.5）；可注册过去时刻（misfire 自愈）
    status        varchar(12)   NOT NULL DEFAULT 'PENDING',
                    -- PENDING|RUNNING|DONE|CANCELLED|FAILED；禁裸写：仅经 infrastructure/state-machine 守卫迁移
                    --（PENDING→RUNNING 抢占 / RUNNING→DONE 执行成功 / PENDING→CANCELLED 业务作废 /
                    --  PENDING→FAILED 重试耗尽或无执行器 / FAILED→PENDING log 重放）
    version       integer       NOT NULL DEFAULT 1,
                    -- 业务作废靠 version 比对（§3）：行每次被成功迁移/推进即 +1，CANCEL_JOB 可带期望 version
                    -- 做乐观并发（0 行=job 已被并发推进，调用方转业务态回查兜底，R-02）
    retry_count   smallint      NOT NULL DEFAULT 0,
                    -- 失败重试计数（口径同 platform.outbox.retry_count：失败尝试次数；退避 3 次后 FAILED）
    next_retry_at timestamptz   NOT NULL DEFAULT now(),
                    -- 裁量列：退避重试拾取门槛（失败后 = now()+backoff；口径同 platform.outbox.next_retry_at）
    last_error    text          NULL,
                    -- 裁量列：终态失败诊断（执行器异常消息/无执行器等）
    created_at    timestamptz   NOT NULL DEFAULT now(),
    fired_at      timestamptz   NULL,
                    -- 首次实际触发时刻（首次抢占时落值；重试不覆盖——延迟监控按 due_at 与 fired_at 差）
    CONSTRAINT ck_schedule_jobs_status CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'CANCELLED', 'FAILED'))
);

COMMENT ON TABLE schedule.schedule_jobs IS 'I2 调度事实源（R-01）：业务同事务写/作废 job，多节点 SKIP LOCKED 抢占，执行器幂等回查';
COMMENT ON COLUMN schedule.schedule_jobs.version IS '乐观并发令牌：每次行迁移 +1；CANCEL_JOB 可按期望 version 比对作废（§3）';
COMMENT ON COLUMN schedule.schedule_jobs.next_retry_at IS '失败退避拾取门槛（裁量列，口径同 platform.outbox）：due_at 保持业务锚定时刻不被重试推进';

-- 到期拾取主索引（§3 原文）
CREATE INDEX IF NOT EXISTS ix_jobs_due
    ON schedule.schedule_jobs (due_at)
    WHERE status = 'PENDING';

-- 幂等键 type+ref 的 DB 兜底（裁量，见头注）：只盖在册行，终态不挡同键新 job
CREATE UNIQUE INDEX IF NOT EXISTS ux_schedule_jobs_type_ref_live
    ON schedule.schedule_jobs (job_type, ref_type, ref_id)
    WHERE status IN ('PENDING', 'RUNNING');

-- ---------- schedule.schedule_job_log：调度执行日志（§3，R-04 全部调度事件落 log 可重放） ----------
CREATE TABLE IF NOT EXISTS schedule.schedule_job_log (
    id          bigserial     PRIMARY KEY,
    job_id      bigint        NOT NULL,
                  -- 同 job 多次尝试各落一行（重试/重放全历史），按 job_id 可完整回放
    job_type    varchar(32)   NOT NULL,
    ref         jsonb         NOT NULL DEFAULT '{}'::jsonb,
                  -- {ref_type, ref_id}；无 ref 的行落 {}（§3 ref 单列的 jsonb 承载）
    fired_at    timestamptz   NOT NULL DEFAULT now(),
    result      varchar(16)   NOT NULL,
                  -- DONE|CANCELLED(回查判定过期无操作)|RETRY(退避再排程)|FAILED(重试耗尽)|NO_EXECUTOR(类型未注册)
    detail      text          NULL,
                  -- 裁量列：失败/重试诊断消息（FAILED 告警工单与重放排查落点）
    duration_ms integer       NOT NULL,
                  -- 本次尝试耗时（回查+执行）
    CONSTRAINT ck_schedule_job_log_result CHECK (result IN ('DONE', 'CANCELLED', 'RETRY', 'FAILED', 'NO_EXECUTOR'))
);

COMMENT ON TABLE schedule.schedule_job_log IS 'I2 调度执行日志（R-04）：每次尝试一行，FAILED 经同 job_id 重放重新入队，幂等回查兜底安全';

CREATE INDEX IF NOT EXISTS ix_schedule_job_log_job
    ON schedule.schedule_job_log (job_id);

-- ---------- 权限（M0 占位口径，同 V1-V4 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE ON schedule.schedule_jobs TO ljr_schedule;
GRANT SELECT, INSERT, UPDATE ON schedule.schedule_job_log TO ljr_schedule;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA schedule TO ljr_schedule;
