-- M1-W1 V11：notify 模块修复（终审 Important-3 / A-1）——notify.notifications 的 idempotency_key
-- 列宽对齐幂等键契约。
--
-- 根因：shared 幂等键规范（packages/shared/src/idempotency 契约文件，M0-4 锁定）三段式
-- `domain/entity/event` 每段最长 32 字符 → 合法键最长 32+1+32+1+32 = 98 字符；
-- V4 建列 varchar(64) 窄于该规范上限，65-98 位合法键 INSERT 撞 22001（value too long）
-- 裸库错 → 事件进重试轨道直至死信（用户通知静默不达）。契约不改（isValidIdempotencyKey
-- 校验上限仍 98），列宽只放宽不收紧：varchar(128) ≥ 98 且留运维余量。
-- V4 已 apply 冻结严禁改动（Flyway 社区版 SQL-first 无 down，修复一律前滚新版本）。
--
-- 注意：flyway.conf defaultSchema=flyway —— DDL 一律全限定 notify.<table>。
-- 幂等性：同宽重放为 no-op 不报错，reset 演练（drop schema 后整库重放 V1→V11）可重复执行。

ALTER TABLE notify.notifications ALTER COLUMN idempotency_key TYPE varchar(128);

COMMENT ON COLUMN notify.notifications.idempotency_key IS
'R-03 幂等：同键一次触达；UNIQUE 兜底（at-least-once 重复事件插入 0 行即短路）。键规范=domain/entity/event 三段各≤32（shared idempotency 契约文件），合法键最长 98 → 列宽 128（V11 前为 64，65-98 位合法键撞 22001，终审 Important-3 / A-1 修复）';
