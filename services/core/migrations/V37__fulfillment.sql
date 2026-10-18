-- M2-W1 V37：D5 会话与消息——fulfillment 模块三表（conversations/messages/consent_records）
--
-- 事实源：docs/modules/D-履约/D5-会话与消息.md（§3 领域模型 + §4 发送链 + §7 R-00~R-06）+
-- docs/plans/M2-W1-执行计划.md 附录 A.3 DDL 蓝图（T0 契约冻结，列级逐字）。
-- schema fulfillment / role ljr_fulfillment 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V36 冻结。本文件 apply 后冻结禁改（W1 R16 冻结令）；后续口径变化一律走新迁移或代码注释。
--
-- 表清单与蓝图对照（附录 A.3 逐字 + 口径归一）：
--   fulfillment-conversations（统一会话模型，D5 §3）：
--     id bigserial PK / type varchar(12) NOT NULL ck 三值（room|private|one_on_one，§2 会话形态
--       三分）/ ref_id bigint NOT NULL（room=rooms 表 id、one_on_one=订单 id、private=W1 无生产方——
--       R-00 ⚠04§8-7 决策位；裸引用跨域禁 FK，W1/W2 惯例）/ next_seq bigint NOT NULL DEFAULT 0
--       （PG 发号列，⚠W1-3：UPDATE next_seq=next_seq+1 RETURNING 行锁事务内单调；Redis INCR
--       换装=SeqIssuer 接口缝，禁先加列）/ created_at timestamptz NOT NULL DEFAULT now()。
--     派生约束：ux_conversations_type_ref UNIQUE(type, ref_id)（会话幂等键——OneOnOnePaid
--       重放/开房重放双插 DB 真兜底）。
--   fulfillment-messages（§3 逐字；§5 GET /conversations/{id}/messages 读路径）：
--     id bigserial PK / conversation_id bigint NOT NULL（本域 conversations 表 id 同域裸引用）/
--       seq bigint NOT NULL（会话内单调，发号=conversations 行锁；UNIQUE(conversation_id,seq)
--       兜底）/ sender_id bigint NOT NULL（identity 域用户 id 裸引用；system 消息=0 锚）/
--       sender_role varchar(12) NOT NULL ck 四值（user|lawyer|agent|system；隔离铁律：agent 仅
--       经内部系统 API 写入，WSS 入参禁伪造——服务层白名单校验）/ type varchar(12) NOT NULL
--       ck 二值（text|system）/ content text NOT NULL / mention varchar(12) NULL ck 二值
--       （agent|lawyer；@Agent=W3 E1 管线路由桩）/ risk_flag varchar(12) NULL ck 三值
--       （PASS|BLOCKED|REVIEW；BLOCKED 值在册但不可达=拦截即拒无行——词汇完整性锚）/ 
--       source_msg_id char(36) NULL（训练语料溯源标记，撤回删除反查锚）/ created_at
--       timestamptz NOT NULL DEFAULT now()（DB 钟）。
--     派生约束：ux_messages_conv_seq UNIQUE(conversation_id, seq)（seq 无洞无重的 DB 兜底）；
--       ix_messages_conv_time(conversation_id, created_at)（冷存 90 天扫描，D5 §3 逐字）；
--       ix_messages_source(source_msg_id)（撤回反查，附录 A.3）。
--   fulfillment-consent_records（录制/房间级训练授权，D5 §3 + A2 授权落点）：
--     id bigserial PK / ref_type varchar(16) NOT NULL ck 二值（recording|training_room）/
--       ref_id bigint NOT NULL（recording=conversations 表 id、training_room=rooms 表 id）/
--       party_id bigint NOT NULL（identity 域用户 id 裸引用）/ version varchar(32) NOT NULL
--       （授权版本锚）/ granted_at timestamptz NOT NULL DEFAULT now()。
--     派生约束：ux_consent_records_ref UNIQUE(ref_type, ref_id, party_id)（幂等——同方重复
--       consent 信令零新行零重复事件）。
--
-- msg_client_id 列不加（简报逐字裁定）：W1 客户端幂等=网关内存 LRU（per-connection 256）；
-- DB 列持久幂等=W2 评审裁量，D5 §3 无该列禁自加。
-- 冷存水位列不加（简报逐字裁定）：COLD_ARCHIVE recheckAnchor=扫描时刻（进程内+job detail
-- 承载），表列禁自发明。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 fulfillment 表。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V37）可重复执行。
-- 注释纪律：本文件注释以连字符指称他域表名，规避 check-schema-refs 的点分词形扫描误报；
--   DDL 本体一律全限定名不受此限。

-- ---------- fulfillment.conversations：统一会话（room/private/one_on_one 三形态） ----------
CREATE TABLE IF NOT EXISTS fulfillment.conversations (
    id         bigserial     PRIMARY KEY,
    type       varchar(12)   NOT NULL,
                              -- room|private|one_on_one（ck 值域，§2 会话形态三分）
    ref_id     bigint        NOT NULL,
                              -- room=rooms 表 id / one_on_one=订单 id（裸引用，跨域禁 FK）
    next_seq   bigint        NOT NULL DEFAULT 0,
                              -- PG 发号列（⚠W1-3）：行锁 UPDATE 单调递增，Redis INCR=换装缝
    created_at timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_conversations_type CHECK (type IN ('room', 'private', 'one_on_one')),
    CONSTRAINT ux_conversations_type_ref UNIQUE (type, ref_id)
                              -- 会话幂等键（type+ref）：OneOnOnePaid 重放/开房重放 DB 真兜底
);

COMMENT ON TABLE fulfillment.conversations IS 'D5 统一会话模型（room/private/one_on_one）：next_seq=PG 发号列（行锁 UPDATE 单调，⚠W1-3）；UNIQUE(type,ref_id)=会话幂等键';
COMMENT ON COLUMN fulfillment.conversations.next_seq IS '会话内 seq 发号水位（UPDATE next_seq=next_seq+1 RETURNING，事务内行锁串行；Redis INCR 换装=SeqIssuer 接口缝）';

-- ---------- fulfillment.messages：消息（seq 会话内单调；风控标记；语料溯源） ----------
CREATE TABLE IF NOT EXISTS fulfillment.messages (
    id               bigserial     PRIMARY KEY,
    conversation_id  bigint        NOT NULL,
                                   -- fulfillment.conversations 表 id 同域裸引用
    seq              bigint        NOT NULL,
                                   -- 会话内单调（发号锚=conversations 行锁；ux 兜底无洞无重）
    sender_id        bigint        NOT NULL,
                                   -- 发送者（identity 域用户 id 裸引用；system 消息=0 锚）
    sender_role      varchar(12)   NOT NULL,
                                   -- user|lawyer|agent|system（agent 仅内部 API 可写——隔离铁律）
    type             varchar(12)   NOT NULL,
                                   -- text|system（系统消息=须知/提醒/存证告知）
    content          text          NOT NULL,
    mention          varchar(12)   NULL,
                                   -- agent|lawyer（@Agent=W3 E1 管线；@律师=律师端待办高亮）
    risk_flag        varchar(12)   NULL,
                                   -- PASS|BLOCKED|REVIEW（BLOCKED 不可达=拦截即拒无行，词汇完整性）
    source_msg_id    char(36)      NULL,
                                   -- 训练语料溯源标记（撤回删除反查锚，R-04）
    created_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_messages_sender_role CHECK (sender_role IN ('user', 'lawyer', 'agent', 'system')),
    CONSTRAINT ck_messages_type CHECK (type IN ('text', 'system')),
    CONSTRAINT ck_messages_mention CHECK (mention IN ('agent', 'lawyer')),
    CONSTRAINT ck_messages_risk_flag CHECK (risk_flag IN ('PASS', 'BLOCKED', 'REVIEW')),
    CONSTRAINT ux_messages_conv_seq UNIQUE (conversation_id, seq)
                                   -- seq 连续无洞无重的 DB 兜底（断线补拉正确性锚）
);

COMMENT ON TABLE fulfillment.messages IS 'D5 消息表：seq 会话内单调（conversations 行锁发号+UNIQUE 兜底）；risk_flag=H5 同步判定结果（BLOCKED 即拒无行）；source_msg_id=训练语料撤回删除反查锚（R-04）';
COMMENT ON COLUMN fulfillment.messages.source_msg_id IS '训练语料溯源标记（char(36)）：TrainingConsentRevoked 按 IS NOT NULL+sender_id 反查物理删除（hot 侧，R-04）；冷存行删除=I3 协作（W2+ 联调）';

-- ---------- 派生索引（冷存扫描 / 撤回反查，附录 A.3 逐字） ----------
CREATE INDEX IF NOT EXISTS ix_messages_conv_time ON fulfillment.messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ix_messages_source ON fulfillment.messages (source_msg_id);

-- ---------- fulfillment.consent_records：录制/房间级训练授权（UNIQUE 幂等） ----------
CREATE TABLE IF NOT EXISTS fulfillment.consent_records (
    id          bigserial     PRIMARY KEY,
    ref_type    varchar(16)   NOT NULL,
                              -- recording|training_room（ck 值域；W1 落 recording，training_room=A2 消费位）
    ref_id      bigint        NOT NULL,
                              -- recording=conversations 表 id / training_room=rooms 表 id
    party_id    bigint        NOT NULL,
                              -- 授权方（identity 域用户 id 裸引用）
    version     varchar(32)   NOT NULL,
                              -- 授权版本锚（录制同意=信令版本；训练授权=A2 policy_version）
    granted_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_consent_records_ref_type CHECK (ref_type IN ('recording', 'training_room')),
    CONSTRAINT ux_consent_records_ref UNIQUE (ref_type, ref_id, party_id)
                              -- 幂等：同方重复信令零新行零重复事件（§5 recording-consent 幂等）
);

COMMENT ON TABLE fulfillment.consent_records IS 'D5 授权记录（录制前置信令+房间级训练授权）：UNIQUE(ref_type,ref_id,party_id)=同方幂等；录制双门=双方齐才调 RTC 云录制（R-03，仅 one_on_one——拼单默认不录制 D10）';

-- ---------- 权限（沿 V35 口径：GRANT 收窄形态，只授所需） ----------
-- conversations 需 UPDATE（next_seq 发号推进）；messages 需 DELETE（冷存热删+撤回语料物理删除，
-- R-04 撤回删除语义=物理 DELETE 非 tombstone）；consent_records 无 UPDATE/DELETE（授权行留痕）。
GRANT SELECT, INSERT, UPDATE ON fulfillment.conversations TO ljr_fulfillment;
GRANT SELECT, INSERT, DELETE ON fulfillment.messages TO ljr_fulfillment;
GRANT SELECT, INSERT ON fulfillment.consent_records TO ljr_fulfillment;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fulfillment TO ljr_fulfillment;
