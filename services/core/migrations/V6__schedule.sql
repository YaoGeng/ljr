-- M1-W1 V6：schedule 模块追加（B2 时间段占用锁）——具体场次时刻占用锁的唯一事实源
--
-- 施工规格：docs/modules/B-律师配置/B2-时间段占用锁.md（§3 领域模型 + §4 状态机 + §7 R-01~R-04）。
-- schema schedule / role ljr_schedule 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
-- 同 schedule schema 追加（B2 与 I2 同 owner schema，M1-W1 执行计划 Task 3 裁决），不新建 schema。
--
-- 表清单与文档对照：
--   schedule.slot_locks  §3 原文列逐字 + 两处口径归一（沿 V4/V5 对同款文档裸列的先例）：
--     ① created_at 补 NOT NULL DEFAULT now()（§3 为裸列名；插入方无需显式传时刻，V4/V5 同款归一）
--     ② ck_slot_locks_status CHECK 固化 §3 注释的四态枚举（§3 枚举的 DB 兜底，V5 ck_schedule_jobs_status 同款）
--   §3 三个索引逐字照抄（谓词/列序与文档一致；全限定 + IF NOT EXISTS 为迁移工程口径）：
--     ux_slot_active(lawyer_id, slot_start) WHERE status IN ('PENDING_PAYMENT','LOCKED','OCCUPIED')
--       —— 部分唯一索引=物理防线（R-01）：同律师同段至多一把进行中锁，DB 是唯一事实源，
--          PENDING_PAYMENT 纳入唯一覆盖（R-03 第一重）；Redis 前置锁仅性能优化、本批次不引入（Ruling-3）。
--     ix_slot_ttl(ttl_at) WHERE status = 'PENDING_PAYMENT'          —— TTL/reaper 扫描锚点（R-04）
--     ix_slot_user(initiator_user_id) WHERE status IN (活跃三态)     —— R-03 滥用计数锚点
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 schedule.<table>。
-- 幂等性：全部 IF NOT EXISTS，reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- schedule.slot_locks：时间段占用锁（§3，R-01 唯一事实源） ----------
CREATE TABLE IF NOT EXISTS schedule.slot_locks (
    id                bigserial     PRIMARY KEY,
    lawyer_id         bigint        NOT NULL,
    slot_start        timestamptz   NOT NULL,
    status            varchar(20)   NOT NULL,
                      -- PENDING_PAYMENT|LOCKED|OCCUPIED|RELEASED；禁裸写：迁移仅经
                      -- infrastructure/state-machine 守卫 + state_transition_log（§4 五条边）；
                      -- 创建态（PENDING_PAYMENT/LOCKED）为 INSERT 非迁移，无需守卫（demo/notify 同口径）
    ref_type          varchar(16)   NOT NULL,
                      -- session|groupbuy|reschedule（关联业务实体类型；reaper 终态判定走 provider
                      -- 注册表抽象，禁跨域 join trade.* 表——边界纪律）
    ref_id            bigint        NOT NULL,
    initiator_user_id bigint        NOT NULL,
                      -- 发起人（R-03 滥用防护计数：每用户对同律师进行中锁 ≤1、全局 ≤3）
    payment_order_id  bigint        NULL,
                      -- C2B 发布锁绑定的支付单（§2）；非空 ⇒ 创建为 PENDING_PAYMENT + SLOT_TTL job
    ttl_at            timestamptz   NULL,
                      -- PENDING_PAYMENT 自动释放时刻（默认 10min ⚠决策位，env 可配）；
                      -- SLOT_TTL job due_at 与 ix_slot_ttl 扫描锚点
    created_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_slot_locks_status CHECK (status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED', 'RELEASED'))
);

COMMENT ON TABLE schedule.slot_locks IS 'B2 时间段占用锁唯一事实源（R-01）：ux_slot_active 保证同律师同段至多一把进行中锁；锁迁移与业务终态同事务（R-02）';
COMMENT ON COLUMN schedule.slot_locks.initiator_user_id IS '发起人（R-03 滥用计数锚点：每用户对同律师进行中锁 ≤1、全局 ≤3，超限 SLOT_ABUSE_LIMIT）';
COMMENT ON COLUMN schedule.slot_locks.ttl_at IS 'PENDING_PAYMENT 自动释放时刻（默认 10min ⚠）：SLOT_TTL job due_at 与 reaper ix_slot_ttl 扫描共用锚点';

-- §3 三索引逐字（R-01 物理防线 + R-03/R-04 扫描锚点）
CREATE UNIQUE INDEX IF NOT EXISTS ux_slot_active
    ON schedule.slot_locks (lawyer_id, slot_start)
    WHERE status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED'); -- 部分唯一索引=物理防线

CREATE INDEX IF NOT EXISTS ix_slot_ttl
    ON schedule.slot_locks (ttl_at)
    WHERE status = 'PENDING_PAYMENT';

CREATE INDEX IF NOT EXISTS ix_slot_user
    ON schedule.slot_locks (initiator_user_id)
    WHERE status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED');

-- ---------- 权限（M0 占位口径，同 V1-V5 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE ON schedule.slot_locks TO ljr_schedule;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA schedule TO ljr_schedule;
