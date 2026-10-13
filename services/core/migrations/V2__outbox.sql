-- M0-4 V2：infra schema `platform` + Outbox 双表（架构 §4/§5.1：outbox(id, event_id, topic, payload, status) 事务性发件箱）
--
-- 归属裁定（Ruling-4）：架构 §3.2 模块表（13 模块=13 schema）未给 outbox/state_transition_log 指定归属；
-- §3.2 边界纪律「模块间只允许通过应用服务接口与领域事件（Outbox）通信」——事件总线是跨模块横切设施，
-- 落入任一业务 schema 都意味着该模块私有化公共通道，故建专用 infra schema `platform`（role=ljr_platform，
-- 与 V1 的 DO 守卫/命名/权限风格一致）。T4 跨 schema 检查据此将 platform 列入 infra 白名单。
--
-- relay 语义（架构 §5.1 outbox + §4.5 SKIP LOCKED 抢占模式）：
--   * 写入端 recordOutbox(uow, evt) 与业务写同事务 —— 业务回滚则事件不出（原子性）；
--   * relay 独立轮询 at-least-once：成功才标记 SENT；失败 retry_count 递增 + next_retry_at 退避；
--   * 重试超上限 → 死信表 outbox_dead_letter + status=DEAD（终态，人工处置）。
--   * 消费侧幂等由消费者以幂等键自行防重（at-least-once ≠ 恰好一次，Review Focus #4）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 platform.<table>。
-- 幂等性：role 创建用 DO 守卫（PG15 CREATE ROLE 无 IF NOT EXISTS）；schema/表 IF NOT EXISTS，
-- 配合 reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- infra role ----------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_platform') THEN
        EXECUTE 'CREATE ROLE ljr_platform NOLOGIN';
    END IF;
END
$$;

DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO ljr_platform',
        current_database()
    );
END
$$;

-- ---------- infra schema ----------
CREATE SCHEMA IF NOT EXISTS platform;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO ljr_platform;
ALTER ROLE ljr_platform SET search_path TO platform;
COMMENT ON SCHEMA platform IS 'M0-4 infra：事务性 Outbox/死信/state_transition_log（跨模块横切，Ruling-4 专用 infra schema）';

-- ---------- outbox（架构 §5.1：outbox(id, event_id, topic, payload, status) + relay 所需列） ----------
CREATE TABLE IF NOT EXISTS platform.outbox (
    id            bigserial     PRIMARY KEY,
    event_id      uuid          NOT NULL,
    topic         varchar(128)  NOT NULL,
    payload       jsonb         NOT NULL,
    status        varchar(16)   NOT NULL DEFAULT 'PENDING',
                  -- PENDING|SENT|DEAD；禁裸写：仅 relay 状态机推进（M0-4 口径）
    retry_count   integer       NOT NULL DEFAULT 0,
    next_retry_at timestamptz   NOT NULL DEFAULT now(),
    last_error    text          NULL,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    sent_at       timestamptz   NULL,
    CONSTRAINT ck_outbox_status CHECK (status IN ('PENDING', 'SENT', 'DEAD')),
    CONSTRAINT ux_outbox_event_id UNIQUE (event_id)
);

COMMENT ON TABLE platform.outbox IS '事务性发件箱：与业务同事务写入（recordOutbox），relay at-least-once 投递';
COMMENT ON COLUMN platform.outbox.event_id IS '事件 UUID（消费侧幂等键的事实源）';
COMMENT ON COLUMN platform.outbox.next_retry_at IS '下次可投递时刻（退避）；到期前 relay 不再拾取';

CREATE INDEX IF NOT EXISTS ix_outbox_pending_pickup
    ON platform.outbox (next_retry_at, id)
    WHERE status = 'PENDING';

-- ---------- outbox_dead_letter（重试超上限的终态事件，人工处置入口） ----------
CREATE TABLE IF NOT EXISTS platform.outbox_dead_letter (
    id          bigserial     PRIMARY KEY,
    outbox_id   bigint        NOT NULL,
    event_id    uuid          NOT NULL,
    topic       varchar(128)  NOT NULL,
    payload     jsonb         NOT NULL,
    retry_count integer       NOT NULL,
    last_error  text          NULL,
    dead_at     timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform.outbox_dead_letter IS 'Outbox 死信：retry_count 达上限（relay 配置）即入此表，事件本体在 outbox 置 DEAD';

CREATE INDEX IF NOT EXISTS ix_odl_outbox_id ON platform.outbox_dead_letter (outbox_id);

-- ---------- 权限（M0 最小口径：infra role 独占读写，public 已收回） ----------
GRANT SELECT, INSERT, UPDATE ON platform.outbox TO ljr_platform;
GRANT SELECT, INSERT ON platform.outbox_dead_letter TO ljr_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO ljr_platform;
