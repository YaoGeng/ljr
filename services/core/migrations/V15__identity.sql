-- M1-W2 V15：identity 模块（A3a 律师资质审核）——律师资质档案 / 资质材料版本
--
-- 施工规格：docs/modules/A-身份与账号/A3a-律师资质审核.md（§3 领域模型 + §5 接口 + §7 规则）。
-- schema identity / role ljr_identity 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 表清单与文档对照：
--   identity.lawyer_profiles        §3 原文列 + 两列裁量（简报 R-W2-12 同源/重提版本授权自定）：
--                                   audit_status 五态经 infrastructure/state-machine 守卫迁移
--                                   （DRAFT=无行态不入库，禁裸写）；license_no_enc=A1 同一套
--                                   AES-256-GCM 信封列加密（复用勿复制）；license_no_blind_idx=
--                                   HMAC-SHA256(license_no, pepper) hex64 盲索引（复用 T1 pepper
--                                   体系，R-03 唯一性检索唯一入口）；material_version/material_
--                                   fingerprint=重提守卫载体（§4「REJECTED 重提需新材料版本号」，
--                                   简报：版本号字段自定）——前者为服务端单调版本（每次提交 +1，
--                                   材料版本事实源），后者为材料集内容指纹（sha256，同材料重提
--                                   不构成新版本 → 409）。firm_id 保持 NULL 至 A3b 进件（W3）；
--                                   auditor_id 占位 NULL（admin 鉴权=R-W2-F park 先例，H1 接线
--                                   后取 admin claims 回填）。
--   identity.qualification_files    §3 原文列 + material_version：材料按版本留痕（审核追溯），
--                                   file_ref 仅存引用文本（R-W2-7：I3=M2-W1 才有真 OSS，不做上传）；
--                                   旧版本行保留不删（§8 审核全留痕精神）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 identity.<table>。
-- 幂等性：全部 IF NOT EXISTS 守卫，reset 演练（drop schema 后整库重放 V1→V15）可重复执行。

-- ---------- identity.lawyer_profiles：律师资质档案（§3；R-03 盲索引唯一） ----------
CREATE TABLE IF NOT EXISTS identity.lawyer_profiles (
    id                  bigserial   PRIMARY KEY,
    user_id             bigint      NOT NULL,
                          -- A1 identity.users.id 裸引用（无 FK，A2 同口径文档原文）；唯一=一账号一档案
    license_no_enc      bytea       NOT NULL,
                          -- 执业证号密文（AES-256-GCM 信封，A1 同密钥体系）：明文禁落库/日志/载荷
    license_no_blind_idx char(64)   NOT NULL,
                          -- HMAC-SHA256(license_no, pepper) hex64 盲索引：R-03 唯一性等值检索唯一入口
    firm_name           varchar(128) NULL,
    firm_id             bigint      NULL,
                          -- trade/pricing 域裸引用：A3b 律所进件（W3）后回填，提交时不产生
    material_version    integer     NOT NULL,
                          -- 服务端单调材料版本（§4 重提守卫载体）：每次提交 +1，
                          -- 与 qualification_files 的同名列同源
    material_fingerprint char(64)   NOT NULL,
                          -- 材料集内容指纹 sha256 hex64：同材料重提/修改不构成新版本（409）
    audit_status        varchar(16) NOT NULL,
                          -- SUBMITTED|IN_REVIEW|PASSED|REJECTED|SUSPENDED（DRAFT=无行态）；
                          -- 禁裸写：仅经 infrastructure/state-machine 守卫迁移
    submitted_at        timestamptz NULL,
                          -- 最近一次提交时刻（R-02 三工作日 SLA 起算事实源）
    audited_at          timestamptz NULL,
                          -- 最近一次审核结论时刻（通过/拒绝；R-02 数据位，告警看板=H1 W3）
    auditor_id          bigint      NULL,
                          -- 审核人（admin 账号裸引用）：R-W2-F 鉴权占位期间 NULL，H1 接线后回填
    reject_reason       text        NULL,
                          -- 拒绝事由（仅 REJECTED 态允许非空，CHECK 兜底；重提/迁移时应用层清空）
    CONSTRAINT ck_lawyer_profiles_status
        CHECK (audit_status IN ('SUBMITTED', 'IN_REVIEW', 'PASSED', 'REJECTED', 'SUSPENDED')),
    CONSTRAINT ck_lawyer_profiles_reject_reason
        CHECK (audit_status = 'REJECTED' OR reject_reason IS NULL)
);

-- 一账号一档案（§3 user_id UNIQUE；重提/修改均原行迁移，不另起行）
CREATE UNIQUE INDEX IF NOT EXISTS ux_lawyer_profiles_user ON identity.lawyer_profiles (user_id);
-- R-03 执业证号唯一（盲索引等值；防一人多号重复入驻，应用预检的 DB 兜底）
CREATE UNIQUE INDEX IF NOT EXISTS ux_lawyer_profiles_license ON identity.lawyer_profiles (license_no_blind_idx);

COMMENT ON TABLE identity.lawyer_profiles IS 'A3a 律师资质档案：license_no 列加密+盲索引唯一（R-03）；audit_status 经守卫迁移（禁裸写）；重提需新材料版本（material_version/fingerprint）';
COMMENT ON COLUMN identity.lawyer_profiles.license_no_enc IS 'AES-256-GCM 信封密文（A1 同密钥体系）；明文禁落库/落日志/落事件载荷（lj-data-security）';
COMMENT ON COLUMN identity.lawyer_profiles.license_no_blind_idx IS 'HMAC-SHA256(license_no, pepper) hex64 盲索引，唯一（ux_lawyer_profiles_license）；明文执业证号禁落库';
COMMENT ON COLUMN identity.lawyer_profiles.material_version IS '服务端单调材料版本：每次提交 +1；qualification_files 按版本留痕';
COMMENT ON COLUMN identity.lawyer_profiles.material_fingerprint IS '材料集 sha256 指纹：REJECTED 重提/PASSED 修改须与现行指纹不同（§4 新材料版本守卫）';
COMMENT ON COLUMN identity.lawyer_profiles.auditor_id IS '审核人 admin 账号；R-W2-F admin 鉴权占位期间 NULL，H1（W3）接线后回填';

-- ---------- identity.qualification_files：资质材料版本（§3；R-W2-7 仅存引用文本） ----------
CREATE TABLE IF NOT EXISTS identity.qualification_files (
    id               bigserial   PRIMARY KEY,
    lawyer_id        bigint      NOT NULL,
                       -- identity.lawyer_profiles.id 裸引用（同 schema，无 FK 同口径）
    material_version integer     NOT NULL,
                       -- 所属材料版本（与 lawyer_profiles 的同名列同源）
    file_ref         text        NOT NULL,
                       -- 材料引用文本（I3 加密 OSS key 形态；R-W2-7：真 OSS=M2-W1，不做上传）
    kind             varchar(32) NOT NULL
                       -- 材料类别（LICENSE_PHOTO|FIRM_AUTHORIZATION…；应用层校验形态）
);

-- 档案维度版本化检索（审核面按现行版本取材料；历史版本保留追溯）
CREATE INDEX IF NOT EXISTS ix_qualification_files_lawyer
    ON identity.qualification_files (lawyer_id, material_version, id);

COMMENT ON TABLE identity.qualification_files IS 'A3a 资质材料（按版本留痕）：file_ref 仅存引用文本（R-W2-7），真 OSS 加密存储=I3（M2-W1）';
COMMENT ON COLUMN identity.qualification_files.material_version IS '所属材料版本（与 lawyer_profiles 的同名列同源）；旧版本行保留供审核追溯';

-- ---------- 权限（M0 占位口径，同 V13/V14：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.lawyer_profiles TO ljr_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.qualification_files TO ljr_identity;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO ljr_identity;
