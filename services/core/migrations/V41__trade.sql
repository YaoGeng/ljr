-- M2-W2 V41：trade 模块追加（C4 修复环 C-2）——trade-group-buys 补 session_id 回链列
--
-- 事实源：docs/modules/C-交易/C4-C2B律师响应与双向转化.md §3/§4（「CONFIRMED 生成履约 Session」
--   「GroupBuy→CONVERTED + 新 Session 创建」）+ M2-W2 T4 修复环控制者裁定（加列方案）：
--   gb→履约 Session 的关联原经 enrollment 迁移链反查（新行 prev_enrollment_id → 旧行 ref_id=gb），
--   零参与转化（PUBLISHED 认领、migrated_users=[]）时链上无行 → 幂等重放解析 500——加列为
--   唯一路径后消除（C4 前无 CONFIRMED/CONVERTED 生产者，历史行不存在缺值形态）。
--
-- 变更内容（单件）：
--   trade-group-buys ADD COLUMN session_id bigint NULL——C4 confirm/convert 建面同事务落值：
--     - confirm：= mode='C2B' 履约 Session id（PENDING_LAWYER→CONFIRMED 同事务）；
--     - convert：= 转化 B2C 场次 id（→CONVERTED 同事务）；
--     - NULL=未生成（PUBLISHED/REACHED/PENDING_LAWYER 及 EXPIRED/REJECTED/REFUNDED 全程）。
--   幂等重放（幂等键=gb 的目标态短路）直查本列返回 {session_id}；enrollment 迁移链反查路径删除
--   （唯一路径=本列；迁移行链路仍承载 prev 回链审计语义，不承担 session 解析）。
--   裸列口径：同 schema 自引用语义指针（指向 trade-sessions 表 id），不设 FK（V26 头注⑤
--   prev-enrollment-id 同款先例；trade-sessions 行与 gb 行同事务写，存在性由事务保证）。
--
-- ⚠ 迁移号顺延连锁（M2-W2 计划附录 A.3 原蓝图 +1 后再 +1）：V40=C4 enrollments CHECK 扩、
--   V41=本文件 → **T5 C5 reschedule_requests=V42__trade、T6 F4=V43__benefits+V44__pricing、
--   T8 H4 metrics=V45__ops**；周批 DoD「flyway validate V1~V43」更正为 V1~V45（后续任务施工时
--   以此为准，计划文档勾账时同步）。
--
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 整库重放 V1→V41）可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（trade-group-buys / trade-sessions），规避
--   check-schema-refs 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

ALTER TABLE trade.group_buys ADD COLUMN IF NOT EXISTS session_id bigint;

COMMENT ON COLUMN trade.group_buys.session_id IS
    'C4 履约 Session 回链（M2-W2 T4 修复环 C-2）：confirm=mode C2B 履约场次 id / convert=转化 B2C 场次 id，建面同事务落值；NULL=未生成（幂等重放直查本列，迁移链反查已移除）';
