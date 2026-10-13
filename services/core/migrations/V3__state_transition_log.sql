-- M0-4 V3：platform.state_transition_log（守卫留痕）+ demo 模块脚手架（M0-4 验收用）
--
-- state_transition_log（架构 §4.1「所有状态迁移经守卫与 state_transition_log 落库，供审计、对账与指标计算」）：
--   列清单以 docs/modules/C-交易/C3-报名与支付成团.md §3 的具名契约为准
--   state_transition_log(id, entity_type, entity_id, from_status, to_status, reason, job_id, created_at)
--   追加裁量列 allowed boolean（区分放行/拒绝两类留痕——C3 §4「更新 0 行 ⇒ 走自动退款分支（写 state_transition_log）」
--   即拒绝留痕场景）；from_status 可空（创建迁移无 from）。归属同 V2 裁定：infra schema platform。
--
-- demo 模块（docs/05 M0-4 验收「基座单测 + demo 模块走通」）：专用 demo schema + role，
-- 一张表两态状态机（DRAFT→DONE）+ 动作幂等台账 + 消费侧防重表，走通 写→守卫→outbox→relay→幂等消费。
-- demo 是可抛弃脚手架（M1 起可整体下线），不与任何业务 schema join（边界纪律）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 schema 名。

-- ---------- state_transition_log（platform schema 已由 V2 创建） ----------
CREATE TABLE IF NOT EXISTS platform.state_transition_log (
    id          bigserial     PRIMARY KEY,
    entity_type varchar(32)   NOT NULL,
    entity_id   bigint        NOT NULL,
    from_status varchar(32)   NULL,
                  -- 可空：创建迁移（无 from）
    to_status   varchar(32)   NOT NULL,
    allowed     boolean       NOT NULL,
                  -- true=放行留痕（同业务事务）；false=守卫拒绝留痕（独立事务，业务回滚不影响）
    reason      varchar(128)  NULL,
    job_id      varchar(64)   NULL,
                  -- 调度协同时的 job 回链（C3/架构 §4.5）
    created_at  timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform.state_transition_log IS '状态迁移留痕（架构 §4.1）：放行与拒绝都落一行，供审计/对账/指标';

CREATE INDEX IF NOT EXISTS ix_stl_entity
    ON platform.state_transition_log (entity_type, entity_id, id);

GRANT SELECT, INSERT ON platform.state_transition_log TO ljr_platform;

-- ---------- demo role/schema（M0-4 验收脚手架，风格与 V1 一致） ----------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ljr_demo') THEN
        EXECUTE 'CREATE ROLE ljr_demo NOLOGIN';
    END IF;
END
$$;

DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO ljr_demo',
        current_database()
    );
END
$$;

CREATE SCHEMA IF NOT EXISTS demo;
REVOKE ALL ON SCHEMA demo FROM PUBLIC;
GRANT USAGE ON SCHEMA demo TO ljr_demo;
ALTER ROLE ljr_demo SET search_path TO demo;
COMMENT ON SCHEMA demo IS 'M0-4 demo：横切基座验收脚手架（写→守卫→outbox→relay→幂等消费），M1 起可整体下线';

-- demo.orders：一张表两态状态机 DRAFT→DONE；金额 NUMERIC(12,2) 字符串往返（架构 §1.3）
CREATE TABLE IF NOT EXISTS demo.orders (
    id             bigserial     PRIMARY KEY,
    title          varchar(64)   NOT NULL,
    amount         numeric(12,2) NOT NULL,
    status         varchar(16)   NOT NULL,
                     -- DRAFT|DONE；禁裸写：仅经守卫基类迁移（M0-4 口径）
    completed_note text          NULL,
                     -- 消费侧效果落点：demo.order.completed 事件被消费后回写（幂等消费的可观测证明）
    created_at     timestamptz   NOT NULL DEFAULT now(),
    updated_at     timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_demo_orders_status CHECK (status IN ('DRAFT', 'DONE'))
);

COMMENT ON TABLE demo.orders IS 'demo 订单：DRAFT→DONE 两态状态机，completed_note 由消费者幂等回写';

-- demo.order_actions：动作幂等台账（DB 级唯一约束，同键并发/重试短路的事实源）
CREATE TABLE IF NOT EXISTS demo.order_actions (
    idempotency_key varchar(128)  PRIMARY KEY,
                     -- 键规范 domain/entity/event（shared 契约），如 demo/order-42/completed
    order_id        bigint        NOT NULL,
    action          varchar(32)   NOT NULL,
    result          jsonb         NOT NULL,
    created_at      timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE demo.order_actions IS 'demo 动作幂等台账：唯一约束承担持久幂等（并发第二笔同键事务在提交点败退为读取首访结果）';

-- demo.consumed_events：消费侧防重表（at-least-once 下重复投递的幂等消费，Review Focus #4）
CREATE TABLE IF NOT EXISTS demo.consumed_events (
    event_id   uuid          PRIMARY KEY,
    topic      varchar(128)  NOT NULL,
    handled_at timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE demo.consumed_events IS 'demo 消费防重：event_id 唯一，重复投递插入 0 行即跳过（不得把 at-least-once 当恰好一次）';

-- ---------- 权限（M0 占位口径，同 V1 头注：role 均 NOLOGIN，应用账号接线与完整授权在 M1） ----------
-- 注意：本段只保证「模块自有 schema 对本模块 role 的授权集自洽」（demo 链路的全部表操作均可由 ljr_demo 完成：
-- orders 读写、order_actions 插入+回填首访结果（UPDATE）、consumed_events 插入防重）。
-- demo 服务写 platform.outbox / platform.state_transition_log 不经 ljr_demo 表授权直连——横切写入走基座服务
-- （recordOutbox/守卫），platform 表权限只授 ljr_platform（见 V2）；应用账号体系（NestJS 进程以何角色连接、
-- 是否单账号跨 schema）是 M1 接线决策，届时按最小权限落位，勿据当前 GRANT 集反推运行时账号模型。
GRANT SELECT, INSERT, UPDATE ON demo.orders TO ljr_demo;
GRANT SELECT, INSERT, UPDATE ON demo.order_actions TO ljr_demo;
GRANT SELECT, INSERT ON demo.consumed_events TO ljr_demo;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA demo TO ljr_demo;
