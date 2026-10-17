-- M1-W3 V31：identity 模块（A1 ⚠W3-8 裁决落地 + W2 终审 G-A 前置门第 1 项）——user_roles 角色枚举放宽增 'admin'
--
-- 施工依据：M1-W3 Task 10 简报「迁移 1：identity.user_roles role CHECK 放宽增 'admin'」
-- + docs/plans/M1-W2-复审报告.md §2-C/§3-A（G-A 组：admin 鉴权机制，不可降级项）。
-- schema identity / role ljr_identity 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 变更内容：仅替换 V13 的 ck_user_roles_role CHECK（原文 role IN ('user','lawyer') → 增 'admin'）。
-- 表结构/授权面零变更；存量行（user/lawyer）全部满足新 CHECK，无数据迁移。
--
-- 语义口径（实现层落点，M1-W3 T10 报告同口径注记）：
--   admin = 「权限旗标」非「激活角色」——JWT claims 的 roles 成员含 'admin' 即过
--   @RequireRole('admin')（identity.guards IdentityRoleGuard 分支，W3 T10 交付）；
--   激活角色（claims 的 role 键）词汇不变，switch-role 仍限 user|lawyer
--   （A1 服务层 assertUserRole，admin 不可自铸/自换——防提权）。
--   admin 账号供给 = DB 级预置（identity.user_roles 直插 role='admin'；无自助 API，
--   运营台=M3/M4）：本迁移只放宽枚举，不预置任何账号行——生产预置走运维 SQL（同密钥不入库
--   纪律：账号预置不落代码层），测试夹具直插（各 admin 面 spec）。
--
-- 注意：flyway.conf defaultSchema=flyway —— DDL 一律全限定 identity.<table>。
-- 幂等性：reset 演练（drop schema 后整库重放 V1→V31）可重复执行——V13 先建原 CHECK、
-- 本文件后替换，重放一次到达目标态（ALTER 类迁移同 V 系列既有口径）。

ALTER TABLE identity.user_roles DROP CONSTRAINT ck_user_roles_role;

ALTER TABLE identity.user_roles
    ADD CONSTRAINT ck_user_roles_role CHECK (role IN ('user', 'lawyer', 'admin'));

COMMENT ON CONSTRAINT ck_user_roles_role ON identity.user_roles IS
    'user|lawyer|admin（V31 放宽增 admin，⚠W3-8）：admin=DB 级预置权限旗标（G-A 前置门），非 switch-role 可激活角色';

COMMENT ON TABLE identity.user_roles IS
    'A1 双角色+运营旗标（R-02/⚠W3-8）：PK 兜底幂等授角色；lawyer 由 A3a 审核事件授予，A1 不自授；admin 由 DB 预置（无自助 API，运营台=M3/M4）';

-- 权限：不变更授权面（M0 占位口径，同 V13 头注——应用账号接线与完整授权是 M1 接线决策）
