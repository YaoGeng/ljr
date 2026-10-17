-- M1-W3 V32：ops 模块追加（H1 律师与资质管理 + W2 终审 G-A 前置门配套）——audit_logs 操作审计
--
-- 施工依据：docs/modules/H-运营后台/H1-律师与资质管理.md（§3「audit_logs 记操作」+ §8
-- 「审核操作全审计」+ §10「全部操作在 H9 审计可查」）+ M1-W3 Task 10 简报「迁移 2：ops.audit_logs」。
-- schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 定位：H1 操作审计的最小落地 + H9(M4) 正式审计存储的前置位（简报 G-E 口径：H9 落位时
-- 扩面不换表）。写入方=ops 域 AuditLogService（record 只收 uow——审计行与业务状态迁移
-- 同事务提交/回滚，H1 审核操作与 A3a 状态迁移原子）；actor_user_id=admin claims userId
-- （⚠W3-8 鉴权接线的绑定产物，终结 auditor_id 恒 NULL 问题的同批配套留痕面）。
--
-- 表清单与文档对照（简报列清单逐字 + 口径归一，沿 V7/V8 对裸列的先例）：
--   ① created_at 补 NOT NULL DEFAULT now()（简报裸列无；插入方无需显式传时刻）
--   ② 索引按查询面（简报「索引按查询面」）：审计读侧主入口=按对象回溯操作史
--      ix_audit_logs_target (target_type, target_id, id DESC)；次入口=按操作人追责
--      ix_audit_logs_actor (actor_user_id, id DESC)。排序键用 id（bigserial 单调，插入序
--      ≈时间序）而非 created_at——同结果、免重复时间索引；H9 落位若需时间窗扫描再补。
--   ③ action/target_type 不设 CHECK：审计词汇是开放集（H9=M4 将扩展非 H1 动作），
--      形态防呆在服务层（1-64 / 1-32 位非空字符串，AuditLogService 服务件）——DB 只兜底类型。
--   ④ 无 updated 类列：审计行不可变（只 INSERT，无 UPDATE/DELETE 语义——GRANT 只授
--      SELECT/INSERT，DB 层禁改）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 ops.<table>。
-- 幂等性：IF NOT EXISTS 守卫，reset 演练（drop schema 后整库重放 V1→V32）可重复执行。

-- ---------- ops.audit_logs：运营操作审计（H1 §3/§8；H9 正式审计存储前置位） ----------
CREATE TABLE IF NOT EXISTS ops.audit_logs (
    id            bigserial    PRIMARY KEY,
    actor_user_id bigint       NOT NULL,
                     -- 操作人（identity.users.id 裸引用，无 FK——跨 schema 零 FK 全仓口径）
    action        varchar(64)  NOT NULL,
                     -- 操作动作（开放词汇，H1 审核面=lawyer_audit 前缀五枚 claim/approve/reject/suspend/resume；
                     -- 形态防呆在服务层，开放集不设 CHECK，见头注③）
    target_type   varchar(32)  NOT NULL,
                     -- 操作对象类型（H1=lawyer_profile）
    target_id     bigint       NOT NULL,
                     -- 操作对象 id（H1=identity.lawyer_profiles.id 裸引用）
    detail        jsonb        NULL,
                     -- 操作详情（如 result_status/reason/reject_reason；自由 jsonb，服务层保证对象形态）
    created_at    timestamptz  NOT NULL DEFAULT now(),
                     -- 头注①：插入方无需显式传时刻
    CONSTRAINT ck_audit_logs_action_len CHECK (char_length(action) BETWEEN 1 AND 64),
    CONSTRAINT ck_audit_logs_target_type_len CHECK (char_length(target_type) BETWEEN 1 AND 32)
);

-- 按对象回溯操作史（审计读侧主入口，§10「全部操作可查」的扫描面）
CREATE INDEX IF NOT EXISTS ix_audit_logs_target
    ON ops.audit_logs (target_type, target_id, id DESC);
-- 按操作人追责（次入口）
CREATE INDEX IF NOT EXISTS ix_audit_logs_actor
    ON ops.audit_logs (actor_user_id, id DESC);

COMMENT ON TABLE ops.audit_logs IS 'H1/H9 操作审计（ops 域最小落地）：同事务写入（uow），行不可变（GRANT 无 UPDATE/DELETE）；H9=M4 扩面不换表';
COMMENT ON COLUMN ops.audit_logs.actor_user_id IS '操作人 identity.users.id 裸引用（admin claims userId，⚠W3-8 鉴权接线绑定产物）';
COMMENT ON COLUMN ops.audit_logs.action IS '开放动作词汇（H1 审核面=lawyer_audit 前缀五枚）；形态防呆在 AuditLogService（1-64 位非空）';

-- ---------- 权限（M0 占位口径，同 V7/V8 头注）：审计行不可变——只授 SELECT/INSERT ----------
GRANT SELECT, INSERT ON ops.audit_logs TO ljr_ops;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO ljr_ops;
