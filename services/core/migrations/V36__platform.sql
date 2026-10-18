-- M2-W1 V36：I3 文件与存证存储——platform schema 落表（artifacts 台账 + 调取审批）
--
-- 事实源：docs/modules/I-平台支撑/I3-文件与存证存储.md（§3 领域模型 + §5 接口 + §7 R-01~R-04）
-- + docs/plans/M2-W1-执行计划.md 附录 A.3 DDL 蓝图（T0 契约冻结，列级逐字）。
-- 归属裁定（⚠W1-4）：文件与存证=横切基座（outbox/state-machine 先例），非业务模块——表落
-- platform infra schema（check-schema-refs 白名单内），代码放 src/infrastructure/artifacts/，
-- 不注册 src/modules；13 业务 schema 锁定不改（V1 头注），文件服务非微服务候选。
-- schema platform / role ljr_platform 已由 V2 建好（本文件不触碰）；V1~V35 冻结。本文件
-- apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或代码注释。
--
-- 表清单与蓝图对照（附录 A.3 逐字 + 简报增量）：
--   platform-artifacts（I3 §3 逐字）：
--     id bigserial PK / kind varchar(24) NOT NULL ck 五值（recording|export|credential|
--       cold_message|recon_file，§3 注释行）/ ref_type varchar(24) NOT NULL（引用域开放词汇，
--       W1 策略表收窄 credential→identity 域 / recon_file→payment 域）/ ref_id bigint NOT NULL /
--       bucket varchar(32) NOT NULL（kind 映射：recordings|exports|credentials|cold-messages|
--       recon-files）/ object_key varchar(256) NOT NULL（内容寻址=<bucket>/<kind>/<hash 前两位>/
--       <hash 全值>，同 hash 天然去重）/ hash_sha256 char(64) NOT NULL（SHA-256 hex64，幂等键）/
--       evidence_id varchar(128) NULL（存证平台凭证；仅 recording 归档链写入，D-P9 至信链=M5 前
--       mock 适配器）/ retention_until date NOT NULL（R-01 留存 ≥3 年锚，DB 钟 Asia/Shanghai）/
--       purged_at timestamptz NULL（RETENTION_PURGE 处置戳；NULL=未处置）/ created_at
--       timestamptz NOT NULL DEFAULT now()。
--     派生约束：ux_artifacts_hash UNIQUE(hash_sha256)（幂等键 DB 真兜底——同 bytes 重放返回
--       既有行不重复写存储）；ix_artifacts_retention 部分索引 (retention_until) WHERE
--       purged_at IS NULL（到期日扫面，处置后行退出扫描）。
--   platform-artifact_access_approvals（简报增量，V14 identity 域 decrypt-approvals 同形先例）：
--     id bigserial PK / artifact_id bigint NOT NULL（platform-artifacts 表 id 裸引用，同域无 FK
--     口径）/ reason text NOT NULL（调取证由，审计口径非 PII）/ approved_by bigint NULL +
--       approved_at timestamptz NULL（审批人渐进签发）/ reviewed_by bigint NULL + reviewed_at
--       timestamptz NULL（复核人渐进签发）；ck 禁同人（双签齐时 approved_by<>reviewed_by——
--       DB 物理兜底，应用层只校验双签完整即可信不同人）。
--     审批工作流 UI/创建面=H9（W2+），本批审批行以测试直插，只做「双签完整 → 调取面放行」。
--
-- 审计口径注记（简报改口径裁定）：I3 处置动作不入 ops 域 audit-logs 直写（infrastructure
--   基座禁反向依赖业务域服务/表，schema-refs 纪律）——审计承载=outbox 事件 ArtifactPurged
--   逐行出箱（H9 消费=W2+）；ops 直写留 W2 评审裁量。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 platform.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V36）可重复执行。
-- 注释纪律：本文件注释以连字符指称他域表（identity 域 decrypt-approvals），规避
--   check-schema-refs 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- platform.artifacts：I3 存档台账（bucket 策略/内容寻址/留存/处置戳） ----------
CREATE TABLE IF NOT EXISTS platform.artifacts (
    id              bigserial     PRIMARY KEY,
    kind            varchar(24)   NOT NULL,
                                  -- recording|export|credential|cold_message|recon_file（ck 值域，§3）
    ref_type        varchar(24)   NOT NULL,
                                  -- 引用域词汇（one_on_one/conversation/qualification…；开放，W1 策略表收窄）
    ref_id          bigint        NOT NULL,
                                  -- 引用实体 id（裸引用，跨域禁 FK 惯例）
    bucket          varchar(32)   NOT NULL,
                                  -- recordings(WORM)|exports|credentials(加密)|cold-messages|recon-files
    object_key      varchar(256)  NOT NULL,
                                  -- 内容寻址键=<bucket>/<kind>/<hash 前两位>/<hash 全值>
    hash_sha256     char(64)      NOT NULL,
                                  -- SHA-256 hex64（内容指纹=幂等键；录音哈希上链存证同源）
    evidence_id     varchar(128)  NULL,
                                  -- 存证平台凭证号（仅 recording 归档链；mock 适配器生成 EV-<日期>-<序>）
    retention_until date          NOT NULL,
                                  -- 留存到期日（R-01 ≥3 年；RETENTION_PURGE 日扫锚，DB 钟）
    purged_at       timestamptz   NULL,
                                  -- 处置时刻（NULL=未处置；扫描面=部分索引 ix_artifacts_retention）
    created_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_artifacts_kind
        CHECK (kind IN ('recording', 'export', 'credential', 'cold_message', 'recon_file')),
    CONSTRAINT ux_artifacts_hash UNIQUE (hash_sha256)
                                  -- 幂等键=DB 真兜底：同 bytes（同 hash）重放返回既有行，不重复写存储
);

COMMENT ON TABLE platform.artifacts IS 'I3 文件与存证台账（横切基座）：kind→bucket 策略映射+内容寻址 object_key+hash 幂等；RETENTION_PURGE 日扫 retention_until 到期行处置（R-01）';
COMMENT ON COLUMN platform.artifacts.hash_sha256 IS 'SHA-256 hex64：写入幂等键（ux 唯一）+录音上链存证同源哈希（R-02）';
COMMENT ON COLUMN platform.artifacts.evidence_id IS '存证平台凭证号（仅 recording 归档链写入；dev=mock 适配器，D-P9 至信链真对接=M5 前换装）';
COMMENT ON COLUMN platform.artifacts.retention_until IS '留存到期日（R-01 ≥3 年锚，电商法 §31）：RETENTION_PURGE 扫 retention_until<=当日 且未处置行';
COMMENT ON COLUMN platform.artifacts.purged_at IS '到期处置时刻（NULL=未处置）；处置=存储对象删除+本列落值+ArtifactPurged 逐行出箱（行保留留痕）';

-- 到期扫描面（部分索引）：未处置行按 retention_until 检索；处置后退场
CREATE INDEX IF NOT EXISTS ix_artifacts_retention
    ON platform.artifacts (retention_until)
    WHERE purged_at IS NULL;

-- ---------- platform.artifact_access_approvals：调取审批（双签渐进；H9 工作流=W2+） ----------
CREATE TABLE IF NOT EXISTS platform.artifact_access_approvals (
    id          bigserial   PRIMARY KEY,
    artifact_id bigint      NOT NULL,
                            -- platform.artifacts.id 同域裸引用（跨域才禁 FK，本域同口径从简）
    reason      text        NOT NULL,
                            -- 调取证由（合规工单号等，审计口径非 PII）
    approved_by bigint      NULL,
                            -- 审批人账号；NULL=待审批（H9 创建面，W2+）
    approved_at timestamptz NULL,
                            -- 审批发签时刻（渐进签发留痕）
    reviewed_by bigint      NULL,
                            -- 复核人账号；NULL=待复核；与 approved_by 同人即违规（ck 拦截）
    reviewed_at timestamptz NULL,
                            -- 复核发签时刻（渐进签发留痕）
    CONSTRAINT ck_artifact_access_approvals_two_person
        CHECK (approved_by IS NULL OR reviewed_by IS NULL OR approved_by <> reviewed_by)
);

COMMENT ON TABLE platform.artifact_access_approvals IS 'I3 调取审批（R-02 仅合规审批调取）：双签完整（两列均非空且 ck 禁同人）才可经 /admin/artifacts/{id}/evidence 取证；创建面=H9（W2+），本批只消费';
COMMENT ON COLUMN platform.artifact_access_approvals.reason IS '调取证由（审计留痕随调取操作落应用日志）；合规工单信息，非 PII';

-- ---------- 权限（沿 V2 infra 先例：platform 表只授 ljr_platform，业务模块经基座服务访问） ----------
-- artifacts 无 DELETE（台账行保留留痕，R-01/电商法 §31——处置=purged_at 落值非删行）；
-- UPDATE 供 evidence_id 回写（归档链）与 purged_at 落值（处置链）。
GRANT SELECT, INSERT, UPDATE ON platform.artifacts TO ljr_platform;
GRANT SELECT, INSERT, UPDATE ON platform.artifact_access_approvals TO ljr_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO ljr_platform;
