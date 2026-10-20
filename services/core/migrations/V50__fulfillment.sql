-- M2-W3 V50：fulfillment 模块追加（D5 会话与消息·T5 批内收口件）——message_receipts 持久回执面
--
-- 事实源：docs/modules/D-履约/D5-会话与消息.md（§5 客户端幂等 msg_client_id）+
-- docs/plans/M2-W3-执行计划.md 附录 A.3 V50 蓝图（T0 契约冻结，列级逐字对齐）+ W2 复审 §3-④
-- （「msg_client_id LRU 换持久判重；系统消息 dedup_key=生成侧判重键」收口项，W3-14 决策位）。
-- schema fulfillment / role ljr_fulfillment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V49 冻结。
--
-- 列清单与蓝图对照（A.3 逐字，无增补列）：
--   fulfillment-message_receipts：
--     conversation_id bigint NOT NULL（本域 conversations 表 id 同域裸引用——回执随会话归属）/
--       dedup_key varchar(128) NOT NULL（判重键：客户端消息=msg_client_id 原值；系统消息=
--       生成侧判重键（D2 消费=事件锚形态 room-opened 冒号 event_id 等——服务层入参校验 1-128））/
--       message_seq int NOT NULL（首访消息 seq 锚——重复命中时回放 ack/回读原消息的定位半边；
--       与 messages 表 ux_messages_conv_seq 唯一约束同键域）/
--       created_at timestamptz NOT NULL DEFAULT now()（首访落回执时刻）/
--       PRIMARY KEY (conversation_id, dedup_key)——判重键域=会话内 dedup_key（非全局键：
--       同一 msg_client_id 跨会话互不判重，蓝图逐字）。
--
-- 语义（服务层承载，头注钉住）：WSS send 路径 msg_client_id 判重自 per-connection 内存 LRU
--   （近 256 条，M2-W1 T3 形态）换本持久面——全周期判重（含进程重启/换连接）；
--   判重与消息落库同一事务（INSERT ... ON CONFLICT DO NOTHING 命中=重复 → 整事务回滚零新行，
--   回执行的 message_seq 回放首访 ack）；系统消息（postInternalMessage dedup_key）同面
--   （relay at-least-once 重投窗的重复落消息行收口，W1 已接受项兑现）。
-- 注释纪律（V48 同款）：注释以连字符/裸表名指称本域约束与表（messages 表 ux_messages_conv_seq、
--   conversations 表 id 等），规避 check-schema-refs 的点分词形扫描误报。
--
-- 注意：flyway.conf defaultSchema=flyway —— DDL 一律全限定 fulfillment.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V50）可重复执行。
-- 无 DELETE/UPDATE：回执=判重事实源不可变（错误重放经新 dedup_key 承载）；seq 锚允许
--   messages 冷存（>90d 热删转 I3）后回执行仍在——回读原消息按需走冷存面（幂等回放 ack
--   只依赖 message_seq 数值，不依赖消息行在册）。

-- ---------- fulfillment.message_receipts：客户端/系统消息持久判重回执（V50 唯一新表） ----------
CREATE TABLE IF NOT EXISTS fulfillment.message_receipts (
    conversation_id bigint        NOT NULL,
                                  -- 会话锚（本域 conversations 表 id 同域裸引用；判重键域半边一）
    dedup_key       varchar(128)  NOT NULL,
                                  -- 判重键（客户端=msg_client_id；系统消息=生成侧判重键）
    message_seq     int           NOT NULL,
                                  -- 首访消息 seq（重复命中回放 ack/回读原消息的锚）
    created_at      timestamptz   NOT NULL DEFAULT now(),
                                  -- 首访落回执时刻
    CONSTRAINT pk_message_receipts PRIMARY KEY (conversation_id, dedup_key)
);

COMMENT ON TABLE fulfillment.message_receipts IS 'D5 消息持久判重回执（M2-W3 T5，W2 复审 §3-④收口）：msg_client_id LRU→持久面（全周期含重启）；键域=(conversation_id,dedup_key)；与消息落库同事务，命中=重复零新行';
COMMENT ON COLUMN fulfillment.message_receipts.dedup_key IS '判重键：客户端消息=msg_client_id 原值；系统消息=生成侧判重键（D2 消费=事件锚形态）；服务层校验 1-128 与列宽同源';
COMMENT ON COLUMN fulfillment.message_receipts.message_seq IS '首访消息 seq 锚：重复命中回放首访 ack（deduplicated:true）与 postInternalMessage 幂等回读的定位半边；消息冷存后回执仍有效（ack 只依赖本数值）';

-- ---------- 权限（沿 V47 口径：GRANT 收窄形态，只授所需；无 UPDATE/DELETE——回执不可变） ----------
GRANT SELECT, INSERT ON fulfillment.message_receipts TO ljr_fulfillment;
