-- M1-W2 V13：identity 模块（A1 注册登录与双角色）——用户 / 双角色 / refresh token / 验证码
--
-- 施工规格：docs/modules/A-身份与账号/A1-注册登录与双角色.md（§3 领域模型 + §5 接口 + §7 规则）。
-- schema identity / role ljr_identity 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 表清单与文档对照：
--   identity.users           §3 原文列。phone 列加密（bytea，AES-256-GCM 信封，裁决 R-W2-11：
--                            mock KMS，数据密钥经 env 注入 dev-only 默认）；phone_blind_idx=
--                            HMAC-SHA256(phone, pepper) hex64 盲索引（明文手机号禁落库/落日志/
--                            落载荷，lj-data-security）；status 三态经 infrastructure/state-machine
--                            守卫迁移（ACTIVE|BANNED|DELETING，禁裸写）；age_declared=R-04 年龄声明
--                            （裁决 R-W2-C：新建号 age_declared 非 true 拒绝完成注册）。
--   identity.user_roles      §3 原文列（双角色同账号，R-02：lawyer 账号默认具备 user 身份；
--                            lawyer 仅由 LawyerAuditPassed 事件消费授予——本模块不做角色提升，§9）。
--   identity.refresh_tokens  §3 原文列。token_hash=sha256(refresh_token) hex64（明文 token 不落库，
--                            裁决 R-W2-3）；吊销即时生效=刷新时查库 revoked_at/expires_at（裁决
--                            R-W2-4：dev 无 Redis，Redis 黑名单为 prod 换装适配位，机制不变）。
--   identity.verify_codes    裁量新增表（文档缺口，R6 先例）：§5 /auth/verify 401 CODE_INVALID 与
--                            「60s 有效」需要验证码载体，§3 未列（I1 只有限频计数，无码值存储——
--                            I1 R-02 计数表语义是频控不是凭证）。只存 sha256(code) hex 不存明文码，
--                            一次性消费（consumed_at），按 phone_blind_idx 定位（无明文手机号）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 identity.<table>。
-- 幂等性：全部 IF NOT EXISTS / DO 守卫，reset 演练（drop schema 后整库重放 V1→V13）可重复执行。

-- ---------- identity.users：账号主表（§3） ----------
CREATE TABLE IF NOT EXISTS identity.users (
    id              bigserial     PRIMARY KEY,
    phone_enc       bytea         NOT NULL,
                      -- 列加密（AES-256-GCM，mock KMS 信封）：01 版本位 + iv(12) + tag(16) + 密文
    phone_blind_idx char(64)      NOT NULL,
                      -- HMAC-SHA256(phone, pepper) hex64：等值检索唯一入口（加密列不可查询）
    status          varchar(16)   NOT NULL DEFAULT 'ACTIVE',
                      -- ACTIVE|BANNED|DELETING；禁裸写：仅经 infrastructure/state-machine 守卫迁移
    age_declared    boolean       NOT NULL DEFAULT false,
                      -- R-04 年龄声明（架构 §6 未成年人保护）：新建号必须 true（R-W2-C）
    created_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE', 'BANNED', 'DELETING'))
);

-- 盲索引唯一：同号仅一账号（§3 ux_users_phone）
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone ON identity.users (phone_blind_idx);

COMMENT ON TABLE identity.users IS 'A1 账号主表：phone 列加密 + HMAC 盲索引等值检索；status 经守卫迁移；R-04 年龄声明';
COMMENT ON COLUMN identity.users.phone_enc IS 'AES-256-GCM 信封密文（01+iv+tag+ct）；密钥经 env 注入（R-W2-11 mock KMS，dev-only 默认）';
COMMENT ON COLUMN identity.users.phone_blind_idx IS 'HMAC-SHA256(phone, pepper) hex64 盲索引，唯一（ux_users_phone）；明文手机号禁落库/落日志/落载荷';

-- ---------- identity.user_roles：双角色同账号（§3，R-02） ----------
CREATE TABLE IF NOT EXISTS identity.user_roles (
    user_id bigint      NOT NULL REFERENCES identity.users(id),
    role    varchar(8)  NOT NULL,
                      -- user|lawyer；lawyer 仅经 LawyerAuditPassed 事件消费授予（§9 禁本模块提升）
    CONSTRAINT ck_user_roles_role CHECK (role IN ('user', 'lawyer')),
    CONSTRAINT pk_user_roles PRIMARY KEY (user_id, role)
);

COMMENT ON TABLE identity.user_roles IS 'A1 双角色（R-02）：PK 兜底幂等授角色；lawyer 由 A3a 审核事件授予，A1 不自授';

-- ---------- identity.refresh_tokens：refresh token 台账（§3；R-W2-3/R-W2-4） ----------
CREATE TABLE IF NOT EXISTS identity.refresh_tokens (
    id         bigserial   PRIMARY KEY,
    user_id    bigint      NOT NULL REFERENCES identity.users(id),
    token_hash char(64)    NOT NULL,
                 -- sha256(refresh_token) hex64：明文 token 不落库（签发时仅返回一次）
    expires_at timestamptz NOT NULL,
                 -- 签发 +14d（裁决 R-W2-3）
    revoked_at timestamptz NULL
                 -- 登出吊销（R-W2-B）；刷新时查库校验=吊销即时生效（R-W2-4，dev 无 Redis）
);

-- 按哈希等值检索（刷新/吊销的唯一入口；哈希天然唯一）
CREATE UNIQUE INDEX IF NOT EXISTS ux_refresh_tokens_hash ON identity.refresh_tokens (token_hash);
-- 用户维度清/查（A4 删除账号时的级联吊销入口）
CREATE INDEX IF NOT EXISTS ix_refresh_tokens_user ON identity.refresh_tokens (user_id);

COMMENT ON TABLE identity.refresh_tokens IS 'A1 refresh token 台账：sha256 哈希落库（明文不存），revoked_at 吊销即时生效（R-W2-4）';

-- ---------- identity.verify_codes：验证码载体（裁量新增，文档缺口同 R6） ----------
CREATE TABLE IF NOT EXISTS identity.verify_codes (
    id              bigserial   PRIMARY KEY,
    phone_blind_idx char(64)    NOT NULL,
                      -- 与 identity.users 同名列同口径（HMAC 盲索引），验证码记录不存明文手机号
    code_hash       char(64)    NOT NULL,
                      -- sha256(code + ':' + phone_blind_idx) hex64：明文验证码不落库
    expires_at      timestamptz NOT NULL,
                      -- 签发 +60s（§2「60s 有效」）
    consumed_at     timestamptz NULL,
                      -- 一次性消费：verify 成功即落时间戳，重放（同码二次 verify）拒绝
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- 取「最新一条未消费未过期」的检索口径
CREATE INDEX IF NOT EXISTS ix_verify_codes_pickup
    ON identity.verify_codes (phone_blind_idx, id DESC);

COMMENT ON TABLE identity.verify_codes IS 'A1 验证码载体（§3 文档缺口裁量新增）：码值哈希存储、60s 有效、一次性消费；频控计数在 notify.verify_code_sends（I1 R-02/A1 R-01），两表不混用';

-- ---------- 权限（M0 占位口径，同 V1/V4 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.users TO ljr_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.user_roles TO ljr_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.refresh_tokens TO ljr_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.verify_codes TO ljr_identity;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO ljr_identity;
