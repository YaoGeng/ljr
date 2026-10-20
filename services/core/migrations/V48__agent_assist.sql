-- M2-W3 V48：agent_assist 模块追加（E1 Agent 草稿气泡管线·T4）——drafts + agent_review_logs 两表。
--
-- 事实源：docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md（§3 领域模型 / §4 管线 / §7 R-01~R-07 /
-- §8 各段打点）+ docs/plans/M2-W3-执行计划.md 附录 A.3 V48 蓝图（T0 契约冻结，列级逐字对齐）。
-- schema agent_assist / role ljr_agent_assist 已由 V1 建好（禁增删 schema/role，本文件不触碰）；
-- V1~V47 冻结。
--
-- 列清单与蓝图对照（A.3 逐字 + 四处增补列理由，头注钉住）：
--   agent_assist-drafts（E1 §3 逐字）：
--     id bigserial PK / room_id bigint NOT NULL（本域外 fulfillment-rooms 的 id 裸引用——
--       消费侧经 fulfillment 导出接口取得，无 FK 跨 schema）/ conversation_id bigint NOT NULL
--       【增补理由：源会话锚——消息回查（消费回读）与气泡推送（hub publishTo）都需会话 id，
--       E1 §3 裸列未列（模块文档时序早于 D5 统一会话模型）；消费面=A.4 导出面清单】/
--       target_user_id bigint NOT NULL（identity 域用户 id 裸引用——R-06 每用户最新去重的
--       分组键半边）/ question_digest text NOT NULL（脱敏后问题摘要——R-02：原文（含 PII）
--       禁入本表，占位符形态是唯一落库形态）/ content text NOT NULL（草稿正文，含「AI 辅助，
--       仅供参考」标记——R-04）/ placeholders jsonb NOT NULL DEFAULT '{}'::jsonb（占位符→原文
--       映射，对象形态 {token: 原文}；仅律师端气泡还原显示用，禁入 RAG/LLM 载荷——R-02）/
--       status varchar(12) NOT NULL ck 五值（PENDING|SENT|EDITED_SENT|DISCARDED|EXPIRED——
--       §3 状态词汇；禁裸写：经守卫+STL entity_type='draft'）/ answered boolean NOT NULL
--       DEFAULT false（待办标记（E2），本批无写面）/ latency_ms int NULL【增补理由：总延迟
--       打点（§8 总 P95≤8s / H4 草稿延迟口径）——事件载荷 latency_ms 的落库锚】/
--       segment_ms jsonb NULL【增补理由：各段打点 {sanitize,intent,rag,llm}（§8 预算口径
--       1s/1s/2s/4s）——事件载荷 segment_ms 的落库锚】/ created_at timestamptz NOT NULL
--       DEFAULT now() / replied_at timestamptz NULL（动作时刻——review_ms 的区间终点）。
--   agent_assist-agent_review_logs（E1 §3 逐字）：
--     id bigserial PK / draft_id bigint NOT NULL（本域 drafts 表 id 同域裸引用）/ lawyer_id
--       bigint NOT NULL【增补理由：动作归属——审计面（哪位律师审查）与 H4 律师维度口径；
--       E1 §3 裸列未列（§5 契约动作发起方=律师端）】/ action varchar(12) NOT NULL ck 三值
--       （send|edit_send|discard）/ edited_content text NULL（edit_send 的编辑稿；send/discard
--       恒 NULL）/ review_ms int NOT NULL（created_at→动作时刻耗时，§8 审查耗时）/ sent_at
--       timestamptz NULL（send/edit_send=消息发出时刻；discard 恒 NULL）/ created_at
--       timestamptz NOT NULL DEFAULT now()。
--
-- 派生索引与幂等键（A.3 逐字 + 理由）：
--   ix_drafts_room(room_id, status)——R-06 每用户最新去重的 (room_id,status='PENDING') 扫描面
--     + 律师端按房间补拉面；
--   ix_drafts_target(target_user_id, status)——用户维度草稿检索面（E2 待办消费位）；
--   ix_agent_review_logs_draft(draft_id)——审查日志按草稿回查面；
--   ux_agent_review_logs_draft_action(draft_id, action) UNIQUE——§5 幂等键=draft+action 的
--     DB 兜底（重复同动作幂等返回；同草稿不同动作各占一行——三动作至多三行）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 agent_assist.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放 V1→V48）可重复执行。
-- 注释纪律：本文件注释以连字符指称跨域表（fulfillment-rooms 等），规避 check-schema-refs
--   的点分词形扫描误报；DDL 本体一律全限定名不受此限。
-- 权限：drafts 需 UPDATE（状态经守卫推进+replied_at 回填）；agent_review_logs 只 INSERT/SELECT
--   （审查日志不可变——错误修正=整行重放，无 UPDATE 面）；无 DELETE（合规留痕）。

-- ---------- agent_assist.drafts：E1 草稿（管线产物+五态词汇+打点锚） ----------
CREATE TABLE IF NOT EXISTS agent_assist.drafts (
    id              bigserial    PRIMARY KEY,
    room_id         bigint       NOT NULL,
                                 -- 房间 id（fulfillment 域 rooms 表 id 裸引用——经导出接口取得）
    conversation_id bigint       NOT NULL,
                                 -- 源会话锚（增补：消息回查/气泡推送面）
    target_user_id  bigint       NOT NULL,
                                 -- 目标用户（R-06 去重分组键半边）
    question_digest text         NOT NULL,
                                 -- 脱敏后问题摘要（R-02：原文明文禁入；占位符形态唯一合法）
    content         text         NOT NULL,
                                 -- 草稿正文（含「AI 辅助，仅供参考」标记——R-04）
    placeholders    jsonb        NOT NULL DEFAULT '{}'::jsonb,
                                 -- 占位符→原文映射 {token: 原文}（律师端还原显示；禁入 RAG/LLM）
    status          varchar(12)  NOT NULL,
                                 -- 五值状态词汇（ck 钉死；迁移必经守卫+STL entity_type='draft'）
    answered        boolean      NOT NULL DEFAULT false,
                                 -- 待办标记（E2 消费位，本批无写面）
    latency_ms      int          NULL,
                                 -- 总延迟打点（增补：§8 总预算/H4 口径的事件落库锚）
    segment_ms      jsonb        NULL,
                                 -- 各段打点 {sanitize,intent,rag,llm}（增补：§8 分段预算锚）
    created_at      timestamptz  NOT NULL DEFAULT now(),
    replied_at      timestamptz  NULL,
                                 -- 律师动作时刻（review_ms 区间终点）
    CONSTRAINT ck_drafts_status CHECK (status IN ('PENDING', 'SENT', 'EDITED_SENT', 'DISCARDED', 'EXPIRED')),
    CONSTRAINT ck_drafts_latency CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

COMMENT ON TABLE agent_assist.drafts IS 'E1 Agent 草稿：管线（脱敏→硬拦→意图→RAG→LLM）产物；question_digest=脱敏后摘要（原文明文禁入 R-02）；content 含「AI 辅助，仅供参考」标记（R-04 仅律师端可见）；状态经守卫+STL 推进禁裸写；R-06 每用户最新去重=同 (room_id,target_user_id) 旧 PENDING 置 EXPIRED 再建新行';
COMMENT ON COLUMN agent_assist.drafts.conversation_id IS '源会话锚（增补列）：E1 消费回查与气泡推送（hub publishTo）都会话维度；消费经 fulfillment 导出接口（A.4 清单），禁跨 schema 直读';
COMMENT ON COLUMN agent_assist.drafts.question_digest IS '脱敏后问题摘要（sanitized 文本，占位符形态）——R-02 原文（含 PII）禁入本表；事件载荷不含本字段（消费者按需回查）';
COMMENT ON COLUMN agent_assist.drafts.placeholders IS '占位符→原文映射 {token: 原文}（律师端气泡还原显示专用；禁入 RAG/LLM 载荷——与 question_digest 结构分离是 R-02 铁律）';
COMMENT ON COLUMN agent_assist.drafts.latency_ms IS '总延迟打点（毫秒，增补列）：§8 总 P95≤8s 预算与 H4 草稿延迟口径的事件落库锚';
COMMENT ON COLUMN agent_assist.drafts.segment_ms IS '各段打点 {sanitize,intent,rag,llm}（毫秒，增补列）：§8 分段预算（1s/1s/2s/4s）锚';

-- ---------- agent_assist.agent_review_logs：律师审查动作日志（三动作+耗时） ----------
CREATE TABLE IF NOT EXISTS agent_assist.agent_review_logs (
    id             bigserial    PRIMARY KEY,
    draft_id       bigint       NOT NULL,
                                -- 草稿锚（本域 drafts 表 id 同域裸引用）
    lawyer_id      bigint       NOT NULL,
                                -- 动作归属律师（增补列：审计/H4 律师维度口径）
    action         varchar(12)  NOT NULL,
                                -- send|edit_send|discard（§5 三动作）
    edited_content text         NULL,
                                -- edit_send 的编辑稿（send/discard 恒 NULL）
    review_ms      int          NOT NULL,
                                -- 草稿 created_at→动作时刻耗时（§8 审查耗时）
    sent_at        timestamptz  NULL,
                                -- send/edit_send=消息发出时刻；discard 恒 NULL
    created_at     timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_agent_review_logs_action CHECK (action IN ('send', 'edit_send', 'discard')),
    CONSTRAINT ck_agent_review_logs_review_ms CHECK (review_ms >= 0)
);

COMMENT ON TABLE agent_assist.agent_review_logs IS 'E1 律师审查动作日志（不可变）：三动作 send|edit_send|discard + review_ms 耗时（H4 采用率分子=E2 待办的事实源）；幂等键=draft+action（ux 兜底，重复同动作幂等返回）';
COMMENT ON COLUMN agent_assist.agent_review_logs.lawyer_id IS '动作归属律师（增补列）：审计面（哪位律师审查）与 H4 律师维度口径';
COMMENT ON COLUMN agent_assist.agent_review_logs.edited_content IS 'edit_send 的编辑稿正文（律师修改后实际发送内容——R-05 审查留痕）；send 用草稿原 content、discard 无正文';

-- ---------- 派生索引（见头注理由） ----------
CREATE INDEX IF NOT EXISTS ix_drafts_room
    ON agent_assist.drafts (room_id, status);
CREATE INDEX IF NOT EXISTS ix_drafts_target
    ON agent_assist.drafts (target_user_id, status);
CREATE INDEX IF NOT EXISTS ix_agent_review_logs_draft
    ON agent_assist.agent_review_logs (draft_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_review_logs_draft_action
    ON agent_assist.agent_review_logs (draft_id, action);

-- ---------- 权限（沿 V47 口径：GRANT 收窄形态，只授所需） ----------
GRANT SELECT, INSERT, UPDATE ON agent_assist.drafts TO ljr_agent_assist;
GRANT SELECT, INSERT ON agent_assist.agent_review_logs TO ljr_agent_assist;
-- V48 新增 bigserial 序列（此前 ALL SEQUENCES 授权不覆盖本迁移新序列）
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_assist TO ljr_agent_assist;
