-- M1-W2 V14：identity 模块（A2 实名认证与同意管理）——实名核验结果 / 全 scope 同意 / 受控解密审批
--
-- 施工规格：docs/modules/A-身份与账号/A2-实名认证与同意管理.md（§3 领域模型 + §5 接口 + §7 规则）。
-- schema identity / role ljr_identity 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 表清单与文档对照：
--   identity.real_name_infos      §3 原文列。默认仅存核验结果 + 凭据摘要（§2/R-04 密文最小化）：
--                                 verify_token_digest=sha256(核验凭据) hex64（不存原文）；name_enc/
--                                 id_no_enc 仅纠纷处理目的留存（默认 NULL，应用侧 R-W2 留存开关控制，
--                                 密文用 A1 同一套 AES-256-GCM 信封密钥体系）；核验通道=适配器 +
--                                 MockRealnameProvider（D12 逾期默认，verify_provider 落 'MOCK'，prod 前替换）。
--                                 user_id 按文档原文不建 FK 引用（A1 users bigint 裸引用，简报裁决）。
--                                 状态机 NONE→PENDING→VERIFIED/FAILED 无独立状态列：VERIFIED=本表行存在，
--                                 其余态留痕于 platform.state_transition_log（经守卫，禁裸写）。
--   identity.consents             §3 原文列。scope 三值 CHECK（realname|training|recording）；
--                                 本批写入面仅 training（realname/recording 只承载枚举值：实名同意记录
--                                 即 real_name_infos 行本身，房间级 recording 映射=D5 consent_records，M2）；
--                                 GRANTED/REVOKED 经守卫迁移（ABSENT=无行），REVOKED 后同版本再授权=新行，
--                                 撤回=原行原位置 UPDATE（不另起行）。
--   identity.decrypt_approvals    裁决 R-W2-5 新增表（文档缺口，R6 先例）：§2/R-04「审批+双人复核」
--                                 无承载表。approved_by/reviewed_by 可空=审批/复核渐进签发，双签完整才可
--                                 解密（应用层校验 + CHECK 禁同人）；审批工作流 UI/创建面=H9（M4），
--                                 本批只做「完整审批 → 临时解密返回并审计留痕」，审批行以测试直插。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 identity.<table>。
-- 幂等性：全部 IF NOT EXISTS / DO 守卫，reset 演练（drop schema 后整库重放 V1→V14）可重复执行。

-- ---------- identity.real_name_infos：实名核验结果（§3；R-04 密文最小化） ----------
CREATE TABLE IF NOT EXISTS identity.real_name_infos (
    id                  bigserial   PRIMARY KEY,
    user_id             bigint      NOT NULL,
                          -- A1 identity.users.id 裸引用（无 FK，文档原文口径）
    verify_provider     varchar(32) NOT NULL,
                          -- 核验通道名：CTID|CARRIER3|MOCK…（⚠04§8-12 选型，D12 逾期默认=MOCK 适配器）
    verify_token_digest char(64)    NOT NULL,
                          -- sha256(核验凭据) hex64：凭据摘要（不存原文，R-04）
    name_enc            bytea       NULL,
                          -- 姓名密文（A1 同一套 AES-256-GCM 信封）：仅纠纷处理目的留存，默认 NULL
    id_no_enc           bytea       NULL,
                          -- 身份证号密文：留存口径同上；受控解密（审批+双人复核）是唯一读出口
    verified_at         timestamptz NOT NULL,
                          -- 核验通过时刻（R-01 实名闸口查询的事实源）
    CONSTRAINT ck_real_name_infos_user UNIQUE (user_id)
                          -- 一账号至多一条实名记录（§3 UNIQUE；重提幂等=返回现值不重复核验）
);

COMMENT ON TABLE identity.real_name_infos IS 'A2 实名核验结果：默认仅存凭据摘要（R-04 密文最小化），密文列仅纠纷留存；user_id 唯一，重提幂等';
COMMENT ON COLUMN identity.real_name_infos.verify_token_digest IS 'sha256(核验凭据) hex64，不存原文；核验原文只存在于通道适配器入参生命周期内';
COMMENT ON COLUMN identity.real_name_infos.name_enc IS 'AES-256-GCM 信封密文（与 A1 phone_enc 同密钥体系）；默认 NULL，留存开关=应用配置（纠纷处理场景）';
COMMENT ON COLUMN identity.real_name_infos.id_no_enc IS 'AES-256-GCM 信封密文；读取唯一出口=POST 受控解密（审批+双人复核，R-04）';

-- ---------- identity.consents：全 scope 同意台账（§3；R-02 独立同意） ----------
CREATE TABLE IF NOT EXISTS identity.consents (
    id             bigserial   PRIMARY KEY,
    user_id        bigint      NOT NULL,
                     -- A1 identity.users.id 裸引用（无 FK，文档原文口径）
    scope          varchar(16) NOT NULL,
                     -- realname|training|recording（CHECK）；本批写入面仅 training
    status         varchar(16) NOT NULL,
                     -- GRANTED|REVOKED；禁裸写：仅经 infrastructure/state-machine 守卫迁移
                     -- （ABSENT=无行；GRANTED 可再授权=新行，撤回=原行 UPDATE）
    policy_version varchar(16) NOT NULL,
                     -- 授权时政策版本（撤回链路 R-03 的事实源之一；当前有效值=config，裁决 R-W2-6）
    granted_at     timestamptz NULL,
                     -- 授予时刻（GRANTED 行必填，应用层保证）
    revoked_at     timestamptz NULL,
                     -- 撤回时刻（REVOKED 行必填；TrainingConsentRevoked 载荷同源）
    CONSTRAINT ck_consents_scope CHECK (scope IN ('realname', 'training', 'recording')),
    CONSTRAINT ck_consents_status CHECK (status IN ('GRANTED', 'REVOKED'))
);

-- 活跃态唯一（§3 原文）：同 (user_id, scope, policy_version) 至多一条 GRANTED——
-- 重复授权幂等返回现值；REVOKED 后同版本再授权=新行（部分索引只约束活跃态）
CREATE UNIQUE INDEX IF NOT EXISTS ux_consent_active
    ON identity.consents (user_id, scope, policy_version) WHERE status = 'GRANTED';

-- 现行同意状态检索（设置中心查询/撤回/再授权都取「同 user+scope 最新一行」）
CREATE INDEX IF NOT EXISTS ix_consents_user_scope
    ON identity.consents (user_id, scope, id DESC);

COMMENT ON TABLE identity.consents IS 'A2 全 scope 同意台账（R-02 训练授权独立同意，不并入用户协议）；活跃态唯一=ux_consent_active；撤回后 D5/I3 删除执行（本模块只发事件）';
COMMENT ON COLUMN identity.consents.status IS 'GRANTED|REVOKED，经状态机守卫迁移并留痕 state_transition_log；同 user+scope 现行状态=最新行 status，无行=ABSENT';

-- ---------- identity.decrypt_approvals：受控解密审批（裁决 R-W2-5；R-04 双人复核） ----------
CREATE TABLE IF NOT EXISTS identity.decrypt_approvals (
    id          bigserial   PRIMARY KEY,
    user_id     bigint      NOT NULL,
                    -- 解密目标账号（identity.real_name_infos.user_id 裸引用，无 FK 同口径）
    reason      text        NOT NULL,
                    -- 解密事由（纠纷处理工单号等，审计口径；非 PII）
    approved_by bigint      NULL,
                    -- 审批人（合规岗）账号；NULL=待审批（H9 创建面，M4）
    reviewed_by bigint      NULL,
                    -- 复核人账号；NULL=待复核；与 approved_by 同人即违规（CHECK 拦截）
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_decrypt_approvals_two_person
        CHECK (approved_by IS NULL OR reviewed_by IS NULL OR approved_by <> reviewed_by)
);

COMMENT ON TABLE identity.decrypt_approvals IS 'A2 受控解密审批（R-W2-5 文档缺口裁量新增）：双签完整（两列均非空且不同人）才可临时解密；创建面=H9（M4），本批只消费';
COMMENT ON COLUMN identity.decrypt_approvals.reason IS '解密事由（审计留痕随解密操作落日志）；合规工单信息，非 PII';

-- ---------- 权限（M0 占位口径，同 V13：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.real_name_infos TO ljr_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.consents TO ljr_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.decrypt_approvals TO ljr_identity;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO ljr_identity;
