-- M1-W1 V4：notify 模块（I1 通知中心）——通知触达台账 / 模板中心 / 用户偏好 / 验证码限频计数
--
-- 施工规格：docs/modules/I-平台支撑/I1-通知中心.md（§3 领域模型 + §4 关键流程 + §5 接口 + §7 规则）。
-- schema notify / role ljr_notify 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 表清单与文档对照：
--   notify.notifications           §3 原文列 + 两裁量列（retry_count/last_error，§4「失败重试 3 次」的计数与诊断落点，
--                                  口径同 platform.outbox.retry_count：每次失败尝试 +1，超上限置 FAILED 终态）
--   notify.notification_templates §3 原文列 + 一裁量列（critical，「可关非关键类」的关键性判定来源——
--                                  文档缺口同控制者裁决 R6：§2/§10 偏好语义要求区分关键/非关键，§3 未给载体）
--   notify.notification_prefs      控制者裁决 R6 新增（文档缺口）：§5 GET/PUT /notification-prefs 需要持久层，
--                                  §3 未列。最小结构：按 (user_id, template_code) 粒度开关（模板 code 即通知类别，
--                                  无需另设 category 映射层）
--   notify.verify_code_sends       R-02 验证码限频执行计数（A1 R-01：同号 60s/1h/1d 三窗限频；A1(W2) 承接消费）。
--                                  只存 sha256(phone) 哈希不存明文（lj-data-security 口径：明文手机号禁落库）；
--                                  dev 栈无 Redis（Ruling-6），计数落 DB + 行级 advisory lock 串行化同号并发，
--                                  Redis 适配位留待基础设施就位后替换（实现内注释标 ⚠）
--
-- 模板种子：PRD §8.2 三档改价话术（R-01 逐字一致，测试全等断言）。种子落迁移而非启动 seed：
--   话术是 PRD 契约数据（不是运行时可变配置），随迁移版本化走 Flyway 才能保证 reset 整库重放后
--   与测试断言同源；启动 seed 需要额外代码路径与并发防重，收益为零。文案修订走新迁移 UPDATE + version+1。
--   通道取 INBOX（站内信）⚠决策位：PRD 未规定三档话术的通道；push 供应商开发期 mock（外部对接后置约定），
--   站内信=落 notifications 表零外部依赖，为 V1 缺省通道。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 notify.<table>。
-- 幂等性：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING，reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- notify.notifications：触达台账（§3） ----------
CREATE TABLE IF NOT EXISTS notify.notifications (
    id              bigserial     PRIMARY KEY,
    user_id         bigint        NOT NULL,
    channel         varchar(8)    NOT NULL,
                      -- PUSH|SMS|INBOX
    template_code   varchar(32)   NOT NULL,
    params          jsonb         NOT NULL DEFAULT '{}'::jsonb,
    status          varchar(12)   NOT NULL DEFAULT 'QUEUED',
                      -- QUEUED|SENT|FAILED|SKIPPED(prefs)；禁裸写：仅经 infrastructure/state-machine 守卫迁移
                      --（QUEUED→SENT / QUEUED→FAILED / QUEUED→SKIPPED，终态不可再迁移）
    idempotency_key varchar(64)   NOT NULL,
                      -- R-03 幂等：同键一次触达；UNIQUE 兜底（at-least-once 重复事件插入 0 行即短路）
    retry_count     integer       NOT NULL DEFAULT 0,
                      -- 裁量列：§4 失败重试 3 次的计数落点（口径同 platform.outbox.retry_count）
    last_error      text          NULL,
                      -- 裁量列：终态失败诊断（模板缺失/通道异常消息）
    sent_at         timestamptz   NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_notifications_channel CHECK (channel IN ('PUSH', 'SMS', 'INBOX')),
    CONSTRAINT ck_notifications_status CHECK (status IN ('QUEUED', 'SENT', 'FAILED', 'SKIPPED')),
    CONSTRAINT ux_notifications_idempotency_key UNIQUE (idempotency_key)
);

COMMENT ON TABLE notify.notifications IS 'I1 通知触达台账：事件消费→模板渲染→偏好过滤→通道下发→回执更新；幂等键唯一兜底一次触达';
COMMENT ON COLUMN notify.notifications.retry_count IS '失败尝试计数（初始尝试失败即 1）；> 上限（默认 3 次重试）置 FAILED 终态';

-- 下发驱动拾取（只扫 QUEUED；FOR UPDATE SKIP LOCKED 抢占，多实例安全）
CREATE INDEX IF NOT EXISTS ix_notifications_queued_pickup
    ON notify.notifications (id)
    WHERE status = 'QUEUED';

-- 用户站内信列表（GET /notifications/mine）
CREATE INDEX IF NOT EXISTS ix_notifications_user_inbox
    ON notify.notifications (user_id, id DESC)
    WHERE channel = 'INBOX' AND status = 'SENT';

-- ---------- notify.notification_templates：模板中心（§3；话术禁在业务模块硬编码，§9） ----------
CREATE TABLE IF NOT EXISTS notify.notification_templates (
    code     varchar(32) PRIMARY KEY,
    channel  varchar(8)  NOT NULL,
    content  text        NOT NULL,
    version  integer     NOT NULL DEFAULT 1,
    critical boolean     NOT NULL DEFAULT false,
               -- 裁量列（文档缺口同 R6）：true=关键类（验证码等），用户偏好不可关；false=非关键类可关（§2）
    CONSTRAINT ck_notification_templates_channel CHECK (channel IN ('PUSH', 'SMS', 'INBOX'))
);

COMMENT ON TABLE notify.notification_templates IS 'I1 模板中心：code 化模板 + PRD 话术事实源（seed 随迁移版本化，文案修订走新迁移）';

-- ---------- PRD §8.2 三档改价话术 seed（R-01：与 PRD 文案逐字一致） ----------
INSERT INTO notify.notification_templates (code, channel, content, version, critical)
VALUES
    ('PRICE_UP_LOCKED',  'INBOX', '您已锁定原价，当前律师已调价，您享受的是涨价前的价格，不受影响。', 1, false),
    ('PRICE_DOWN_COMP',  'INBOX', '您参与的服务价格有所调整，您已锁定的原价不受影响。为感谢您的信任，我们已为您申请平台积分补偿，将在 24 小时内到账。', 1, false),
    ('PRICE_DOWN_BIG',   'INBOX', '您参与的服务价格大幅调整。您已锁定的原价不受影响，我们已为您申请积分补偿 + 额外平台优惠券，将在 24 小时内到账。感谢您的信任与支持。', 1, false)
ON CONFLICT (code) DO NOTHING;

-- ---------- notify.notification_prefs：用户通知偏好（控制者裁决 R6 新增；§2/§5） ----------
CREATE TABLE IF NOT EXISTS notify.notification_prefs (
    id            bigserial     PRIMARY KEY,
    user_id       bigint        NOT NULL,
    template_code varchar(32)   NOT NULL,
    enabled       boolean       NOT NULL DEFAULT true,
                    -- false=该用户关闭此类通知（仅非关键类可关，服务层校验 critical）
    updated_at    timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ux_notification_prefs_user_template UNIQUE (user_id, template_code)
);

COMMENT ON TABLE notify.notification_prefs IS 'I1 用户通知偏好：(user_id, template_code) 粒度开关，缺省投递；关键类不可关（critical 判定）';

-- ---------- notify.verify_code_sends：验证码限频计数（R-02 承接 A1 R-01） ----------
CREATE TABLE IF NOT EXISTS notify.verify_code_sends (
    id         bigserial     PRIMARY KEY,
    phone_hash varchar(64)   NOT NULL,
                 -- sha256(phone) hex；明文手机号禁落库（lj-data-security 口径）
    sent_at    timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE notify.verify_code_sends IS 'I1 验证码限频计数：三滑窗（60s/1h/1d）按 phone_hash 计数；tryAcquire 原子判定+登记';

CREATE INDEX IF NOT EXISTS ix_verify_code_sends_phone_time
    ON notify.verify_code_sends (phone_hash, sent_at);

-- ---------- 权限（M0 占位口径，同 V1/V2/V3 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE ON notify.notifications TO ljr_notify;
GRANT SELECT, INSERT, UPDATE ON notify.notification_templates TO ljr_notify;
GRANT SELECT, INSERT, UPDATE ON notify.notification_prefs TO ljr_notify;
GRANT SELECT, INSERT, DELETE ON notify.verify_code_sends TO ljr_notify;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA notify TO ljr_notify;
