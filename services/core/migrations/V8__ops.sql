-- M1-W1 V8：ops 模块追加（H5 风控与敏感词管理·W1 词库切片）——risk_records 人审记录
--
-- 施工规格：docs/modules/H-运营后台/H5-风控与敏感词管理.md（§3 领域模型 + §4 关键流程）。
-- schema ops / role ljr_ops 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- R14 裁决落地（M1-W1 执行计划 Task 5 控制者裁决）：**不建 sensitive_words 表**——词库正文的
-- 版本化唯一事实源=ops.rule_definitions（V7，rule_key=wordlist.<dict_type>，经 H7 R-03 免公示
-- 通道写入，热更新=新版本行）；判定引擎把当前生效版本 content 加载进进程内 AC 自动机（版本号
-- 比对驱动重建，无需物化展开表）。sensitive_words 的「当前生效版本物化展开」定位被裁决排除
-- （双事实源风险）；词级 action/dict_type 语义由 H7 content 结构承载（服务层类型定义）。
--   ops.risk_records 照 §3 建：REVIEW 命中落记录（同步判定 API 的唯一落库副作用）；人审队列/
--   处置 REST（§5 queue/review）后置 M2-W2，本表先落机制面。词级 action 与双库枚举的运行时
--   结构（content jsonb 形态）由服务层类型定义承载并明示（word_dict_types）。
--
-- 表清单与文档对照（§3 原文列逐字 + 三处口径归一，沿 V4~V7 对同款文档裸列的先例）：
--   ① message_id 可空（§3 裸列未注类型）：CHECK_RISK 是 D5 发送前置判定，W1 无消息上下文；
--     M2 消息链路接入后由 D5 补关联（或携带 message_id 重调）
--   ② conversation_id 追加列（最小满足规格，I1 notification_prefs 增表 R6 同款先例）：W1 链路
--     唯一上下文锚点（CHECK_RISK 入参），M2 人审队列定位会话必需；类型假设=数值主键（全仓 id
--     类键现状），D5 接入时若会话键为文本形态须迁移列型（⚠实现约定，报告明示）
--   ③ created_at 补 NOT NULL DEFAULT now()（§3 为裸列无；V7 口径归一①同款）；
--     ck_risk_records_action/ck_risk_records_dict CHECK 固化枚举（§3 varchar 裸列；V5~V7 同款
--     DB 兜底）。
--   word_hits jsonb 形态（H5 定义，服务层类型定义头注明示）：
--     [{word, action, rule_version}] —— 该库 REVIEW 命中集 + 命中时词库版本（审计锚点：可回溯
--     命中判定所依据的词库版本）。
--
-- 派生索引（超出 §3 清单，理由）：ix_risk_records_open (created_at) WHERE reviewed_at IS NULL
--     ——§4 人审队列「待处置记录」扫描面（M2-W2 消费；未审记录恒为少数，部分索引避免全表）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 ops.<table>。
-- 幂等性：全部 IF NOT EXISTS，reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- ops.risk_records：机审命中记录（§3；REVIEW 命中落记录，人审闭环 M2-W2 消费） ----------
CREATE TABLE IF NOT EXISTS ops.risk_records (
    id              bigserial    PRIMARY KEY,
    message_id      bigint       NULL,
                     -- 消息 id（§3 裸列；发送前置判定无消息上下文 → 可空，M2 由 D5 补关联）
    conversation_id bigint       NULL,
                     -- 会话 id（追加列，见头注②）：CHECK_RISK 入参上下文锚点，M2 人审队列定位用
    dict_type       varchar(20)  NOT NULL,
                     -- 词库：illegal_content|legal_industry（§2 双词库；一次判定跨库命中按库分行）
    word_hits       jsonb        NOT NULL,
                     -- 命中集 [{word, action, rule_version}]（形态见头注；只记该库 REVIEW 命中）
    action          varchar(8)   NOT NULL,
                     -- BLOCK|REVIEW|MARK（§2 词级三级；本表 W1 只落 REVIEW 行=放行+人审队列）
    reviewed_by     bigint       NULL,
                     -- 人审处置人（M2-W2 人审闭环回填；NULL=待审）
    reviewed_at     timestamptz  NULL,
                     -- 人审处置时刻（M2-W2 回填；NULL=待审）
    created_at      timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_risk_records_action CHECK (action IN ('BLOCK', 'REVIEW', 'MARK')),
    CONSTRAINT ck_risk_records_dict CHECK (dict_type IN ('illegal_content', 'legal_industry'))
);

COMMENT ON TABLE ops.risk_records IS 'H5 风控：机审命中记录（REVIEW 放行+人审队列；词库正文版本化事实源=ops.rule_definitions wordlist.*，R14 裁决）';
COMMENT ON COLUMN ops.risk_records.word_hits IS '该库 REVIEW 命中集 [{word, action, rule_version}]，rule_version=命中判定所依据词库版本（审计锚点）';
COMMENT ON COLUMN ops.risk_records.conversation_id IS 'CHECK_RISK 入参会话锚点（W1 追加列）：M2 人审队列定位会话用';

-- 人审队列扫描面（§4 队列「待处置」=reviewed_at IS NULL，M2-W2 消费；未审恒为少数）
CREATE INDEX IF NOT EXISTS ix_risk_records_open
    ON ops.risk_records (created_at) WHERE reviewed_at IS NULL;

-- ---------- 权限（M0 占位口径，同 V1-V7 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE ON ops.risk_records TO ljr_ops;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO ljr_ops;
