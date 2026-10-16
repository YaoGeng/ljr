-- M1-W3 V19：schedule 模块追加索引——slot_locks 支付单查询锚点（W3 开工批 G-B/W1 前置件）
--
-- 来源：docs/plans/M1-W1-复审报告.md §4-A 前置件①（随 W3 派发携带，B2 评审裁决）。
-- 施工对象：docs/modules/B-律师配置/B2-时间段占用锁.md §3 索引清单外的复审补齐项——
-- B2 confirmPayment 支付回调按 payment_order_id 等值定位锁行（slot-lock 服务内
-- WHERE payment_order_id = $1 ... FOR UPDATE），此前无索引=全表扫描；锁表随 RELEASED 行
-- 无界增长后支付回调路径退化（W1 复审 §4-A 原文口径）。
-- schema schedule / role ljr_schedule 已由 V1 建好（禁增删 schema/role，本文件不触碰）；V1~V18 冻结。
--
-- 索引：ix_slot_payment_order(payment_order_id)——普通 btree 即可（回调按单号等值命中，
-- 无部分谓词需求；列可空，NULL 不参与该查询路径，无部分索引增益）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 schedule 表。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放）可重复执行。
-- 注释纪律：本文件注释以连字符指称表名（schedule-slot_locks），规避 check-schema-refs
-- 的点分词形扫描误报；DDL 本体一律全限定名不受此限。

CREATE INDEX IF NOT EXISTS ix_slot_payment_order
    ON schedule.slot_locks (payment_order_id);
