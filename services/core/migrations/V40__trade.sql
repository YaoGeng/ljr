-- M2-W2 V40：trade 模块追加（C4 C2B 律师响应与双向转化）——enrollments pay_status 值域扩 CONVERTED_OUT
--
-- 事实源：docs/modules/C-交易/C4-C2B律师响应与双向转化.md（§3 领域模型「enrollments（新建行 +
--   prev_enrollment_id 回链，旧行置 CONVERTED_OUT）」+ §7 R-02（迁移靠新建行，禁 UPDATE 既有行
--   做迁移）+ §10 验收②）+ docs/plans/M2-W2-执行计划.md T4 行（无新表——本迁移为既有表 CHECK
--   值域扩展，非新表）。
-- schema trade / role ljr_trade 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V39 冻结。
--
-- 变更内容（单件）：
--   trade-enrollments（V26 建）的 ck_enrollments_pay_status 值域由 PENDING|PAID|REFUNDED
--   扩为 +CONVERTED_OUT（第四态=迁移出标记，enrollment 状态机件（trade 域机器件）M2-W2 T4 同步增态）：
--     - PAID→CONVERTED_OUT：C4 律师确认（PENDING_LAWYER→CONFIRMED 生成 mode='C2B' 履约
--       Session）或认领转化（→CONVERTED 生成 B2C Session）时，参与者报名行的迁移出标记——
--       同事务新建 session 型报名行（复制快照+prev_enrollment_id 回链），旧行仅 pay_status
--       位翻转（ref_type/ref_id/快照列禁 UPDATE——审计链铁律，C4 §9）；
--     - CONVERTED_OUT 机终态无出边：原单退款完成（24h 转化窗退款）的收敛走后继行
--       （advanceToRefunded 迁移链重定向），旧行不复活；
--     - 未支付（PENDING）行不迁移：晚到支付回调走既有满员/终态自动退款分支（R-W3-O 口径
--       延续），故不增 PENDING→CONVERTED_OUT 边。
--   权限/索引零变化：ux_enroll_active 部分唯一索引谓词（pay_status IN ('PENDING','PAID')）
--   天然将 CONVERTED_OUT 行移出活跃集（同场次同用户活跃唯一不因迁移破坏）；V26 GRANT 的
--   SELECT/INSERT/UPDATE 已覆盖本值域扩展（CHECK 收窄的逆向放宽，无需再授权）。
--   RESCHEDULED_OUT（C5 改期迁移出标记）不在本迁移：T5 随 reschedule_requests 表各自落位
--   （执行计划 T4 行「本批只补 C4 需要的」）。
--
-- 幂等性：约束替换用 DROP IF EXISTS + 重建同名同新值域，reset 演练（drop schema 整库重放
--   V1→V40）可重复执行；列宽 varchar(16) 不变（'CONVERTED_OUT' 13 字符在界内）。
-- 注释纪律：本文件注释以连字符指称表名（trade-enrollments），规避 check-schema-refs 的点分
--   词形扫描误报；DDL 本体一律全限定名不受此限。

-- ---------- trade-enrollments：pay_status 值域扩 CONVERTED_OUT（C4 迁移出标记，V26 头注①增量） ----------
ALTER TABLE trade.enrollments DROP CONSTRAINT IF EXISTS ck_enrollments_pay_status;
ALTER TABLE trade.enrollments
    ADD CONSTRAINT ck_enrollments_pay_status
    CHECK (pay_status IN ('PENDING', 'PAID', 'REFUNDED', 'CONVERTED_OUT'));

COMMENT ON CONSTRAINT ck_enrollments_pay_status ON trade.enrollments IS
    'PENDING|PAID|REFUNDED 三态（V26 §3 逐字）+ CONVERTED_OUT（M2-W2 T4/C4：确认/认领转化的迁移出标记——新建行回链承载迁移，旧行仅状态位翻转）';
