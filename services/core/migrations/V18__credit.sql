-- M1-W2 V18：credit 模块（G1 信用体系）——账户快照 / 不可变事件流水 / 限制令
--
-- 施工规格：docs/modules/G-信用与评价/G1-信用体系.md（§3 领域模型 + §7 R-01~R-03）。
-- schema credit / role ljr_credit 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V17 冻结。
--
-- 表清单与文档对照（三表 §3 逐字 + 口径归一，沿 V13/V16/V17 对同款文档裸列的先例）：
--   credit_accounts        §3 原文列 + ①updated_at 补 NOT NULL DEFAULT now()；ck_owner_type 固化
--                          owner_type 值域（varchar(8)：'user'|'lawyer'）；ck_score >= 0 固化 R-01
--                          下限 0（应用侧 GREATEST(0,…) 钳制的 DB 兜底层；无上限=无上界 CHECK）。
--   credit_events          §3 原文列 + ②ref_type/ref_id 补 NOT NULL——§5/简报裁决幂等键=
--                          (owner_type,owner_id,action,ref_type,ref_id) 唯一约束「真兜底」，
--                          NULL 在 PG 唯一约束下互异（NULLS DISTINCT），可空列会使重放失去
--                          DB 层防线；EMIT_CREDIT_EVENT 契约 ref 必填（幂等键=ref+action），
--                          故全量写入恒有 ref（口径归一，报告注明）。③created_at 补 NOT NULL
--                          DEFAULT now()。uq_credit_events_idem=幂等键（§4「幂等」逐字）。
--   credit_restrictions    §3 原文列 + ④until/reason 补 NOT NULL（until=限制令语义必需；
--                          reason=发放依据审计必需）；ck_kind 固化 §3 kind 值域四值；ck_owner_type
--                          同①；ck_until_future 不设（惰性失效允许存量行自然过期，写入侧
--                          until=now()+days 恒未来，CHECK 无增益）。
--
-- 失效机制（§3 注）：惰性判断——查询时比对 until <= now() 即失效，无 I2 物化 job（I2 全集
--   已声明排除 RESTRICTION_EXPIRE）；无「活跃行唯一」部分唯一索引可用：索引谓词禁用 now()
--   （STABLE 非 IMMUTABLE），活跃唯一性由应用侧 pg_advisory_xact_lock(owner) 串行化
--   「查活跃→插行」临界区兜底（credit.service emit，pricing advisory 先例）。
--
-- 派生索引（超出 §3 清单，理由）：
--   ix_credit_events_owner_created (owner_type, owner_id, created_at DESC)
--     ——GET /credit/mine recent_events（ORDER BY created_at DESC LIMIT N）扫描面；
--   ix_credit_events_owner_action_created (owner_type, owner_id, action, created_at)
--     ——连续违规 30 天窗口计数（WHERE owner AND action = ANY(…) AND created_at >= …）扫描面；
--   ix_credit_restrictions_owner (owner_type, owner_id, until)
--     ——GET /credit/restrictions 活跃行查询（WHERE owner AND until > now()）扫描面。
--
-- R-03 流水/限制令不可变（§3「不可变，仅 INSERT」+ §9「禁止 UPDATE credit_events」）：
--   tg_credit_events_immutable / tg_credit_restrictions_immutable 触发器硬禁 UPDATE/DELETE
--   （V17 tg_price_versions_immutable 先例）；GRANT 不授两表 UPDATE/DELETE 权限位（双保险）。
--   credit_accounts 是可变快照（score UPSERT），授 UPDATE。
--
-- 边界纪律：owner_id 为 identity 侧 bigint 裸引用（跨 schema 禁 FK，W1/W2 惯例）；
--   分值规则不在本 schema（H7 credit.rules 行为时快照经 RuleCenterService 取，禁本地建分值表
--   R-W2-10）。kind/delta 为 int/varchar，无金额列（Money 纪律不涉）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 credit.<table>。
-- 幂等性：IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS，reset 整库重放可重复执行。

-- ---------- credit.credit_accounts：账户分快照（§3；credit_accounts 唯一事实源） ----------
CREATE TABLE IF NOT EXISTS credit.credit_accounts (
    owner_type varchar(8)  NOT NULL,
                             -- 'user'|'lawyer'（§3；ck_owner_type 固化值域）
    owner_id   bigint     NOT NULL,
                             -- identity 侧用户 id 裸引用（跨 schema 禁 FK，W1/W2 惯例）
    score      int        NOT NULL DEFAULT 100,
                             -- R-01：初始 100、下限 0（ck_score 兜底）、上限开放
    updated_at timestamptz NOT NULL DEFAULT now(),
                             -- ①口径归一（§3 裸列）
    CONSTRAINT pk_credit_accounts PRIMARY KEY (owner_type, owner_id),
    CONSTRAINT ck_credit_accounts_owner_type CHECK (owner_type IN ('user', 'lawyer')),
    CONSTRAINT ck_credit_accounts_score CHECK (score >= 0)
);

COMMENT ON TABLE credit.credit_accounts IS 'G1 账户分快照（R-01 初始 100/下限 0/上限开放）；唯一事实源，lawyer_profiles 表的 credit_score 列仅为读缓存';
COMMENT ON COLUMN credit.credit_accounts.score IS '当前信用分（UPSERT 累计 delta，GREATEST(0,…) 钳制下限；流水侧 credit_events 的 delta 列记录规则原值不受钳制影响）';

-- ---------- credit.credit_events：不可变事件流水（§3，R-02/R-03 核心承载） ----------
CREATE TABLE IF NOT EXISTS credit.credit_events (
    id           bigserial    PRIMARY KEY,
    owner_type   varchar(8)   NOT NULL,
    owner_id     bigint       NOT NULL,
    action       varchar(32)  NOT NULL,
                              -- 行为动作（G1 行为词汇表；分值/限制映射在 H7 credit.rules content，R-W2-10）
    delta        int          NOT NULL,
                              -- 规则分值原值（快照版本下的 delta；账户钳制不改流水——R-03 可审计）
    rule_version int          NOT NULL,
                              -- 行为时快照命中的 credit.rules 版本（R-02 审计位）
    ref_type     varchar(16)  NOT NULL,
                              -- ②口径归一：幂等键成员，NOT NULL（NULL 使唯一约束失去兜底力）
    ref_id       bigint       NOT NULL,
                              -- ②口径归一：同上
    created_at   timestamptz  NOT NULL DEFAULT now(),
                              -- ③口径归一（§3 裸列）
    CONSTRAINT uq_credit_events_idem UNIQUE (owner_type, owner_id, action, ref_type, ref_id),
    CONSTRAINT ck_credit_events_owner_type CHECK (owner_type IN ('user', 'lawyer'))
);

COMMENT ON TABLE credit.credit_events IS 'G1 信用事件流水（R-03 不可变仅 INSERT；R-02 rule_version=行为时快照版本；at-least-once 幂等=uq_credit_events_idem 真兜底）';
COMMENT ON COLUMN credit.credit_events.ref_type IS '幂等引用形态（session/price_change/attendance/review/group/outbox_event 等多态；EMIT 幂等键=ref+action）';

-- GET /credit/mine recent_events（ORDER BY created_at DESC LIMIT N）扫描面
CREATE INDEX IF NOT EXISTS ix_credit_events_owner_created
    ON credit.credit_events (owner_type, owner_id, created_at DESC);

-- 连续违规 30 天窗口计数（WHERE owner AND action = ANY(…) AND created_at >= …）扫描面
CREATE INDEX IF NOT EXISTS ix_credit_events_owner_action_created
    ON credit.credit_events (owner_type, owner_id, action, created_at);

-- ---------- credit.credit_restrictions：限制令（§3；惰性失效 until <= now()） ----------
CREATE TABLE IF NOT EXISTS credit.credit_restrictions (
    id         bigserial    PRIMARY KEY,
    owner_type varchar(8)   NOT NULL,
    owner_id   bigint       NOT NULL,
    kind       varchar(24)  NOT NULL,
                             -- BAN_JOIN|BAN_PUBLISH|SUSPEND_TAKE_3D|SUSPEND_TAKE_7D（§3 值域固化）
    until      timestamptz  NOT NULL,
                             -- ④口径归一：失效时刻（惰性判断锚点；写入=now()+days，DB 时钟）
    reason     varchar(255) NOT NULL,
                             -- ④口径归一：发放依据（action/窗口触发来源，审计面）
    created_at timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_credit_restrictions_kind
        CHECK (kind IN ('BAN_JOIN', 'BAN_PUBLISH', 'SUSPEND_TAKE_3D', 'SUSPEND_TAKE_7D')),
    CONSTRAINT ck_credit_restrictions_owner_type CHECK (owner_type IN ('user', 'lawyer'))
);

COMMENT ON TABLE credit.credit_restrictions IS 'G1 限制令（§2 四 kind；惰性失效=查询比对 until<=now()，无 I2 到期 job；重复发放同 kind 未到期幂等跳过）';

-- GET /credit/restrictions 活跃行（WHERE owner AND until > now()）扫描面
CREATE INDEX IF NOT EXISTS ix_credit_restrictions_owner
    ON credit.credit_restrictions (owner_type, owner_id, until);

-- ---------- R-03 不可变触发器（禁 UPDATE/DELETE；TRUNCATE 不经行触发器，清场不受影响） ----------
CREATE OR REPLACE FUNCTION credit.fn_credit_events_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'credit.credit_events 流水不可变（R-03）：禁止 %，事件仅 INSERT', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_credit_events_immutable ON credit.credit_events;
CREATE TRIGGER tg_credit_events_immutable
    BEFORE UPDATE OR DELETE ON credit.credit_events
    FOR EACH ROW EXECUTE FUNCTION credit.fn_credit_events_immutable();

CREATE OR REPLACE FUNCTION credit.fn_credit_restrictions_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'credit.credit_restrictions 限制令不可变：禁止 %（到期=惰性失效不删行）', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_credit_restrictions_immutable ON credit.credit_restrictions;
CREATE TRIGGER tg_credit_restrictions_immutable
    BEFORE UPDATE OR DELETE ON credit.credit_restrictions
    FOR EACH ROW EXECUTE FUNCTION credit.fn_credit_restrictions_immutable();

-- ---------- 权限（R-03 双保险：events/restrictions 无 UPDATE/DELETE 权限位；应用账号接线是 M1 接线决策，同 V1-V17） ----------
GRANT SELECT, INSERT, UPDATE ON credit.credit_accounts TO ljr_credit;
GRANT SELECT, INSERT ON credit.credit_events TO ljr_credit;
GRANT SELECT, INSERT ON credit.credit_restrictions TO ljr_credit;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA credit TO ljr_credit;
