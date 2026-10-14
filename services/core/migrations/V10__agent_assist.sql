-- M1-W1 V10：agent_assist 模块追加（E1 实时脱敏层·Task 7 切片）——sanitize_audit 一表。
--
-- 施工规格：docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md（§4 管线脱敏段 / §7 R-02 / §8 ≤1s /
-- §9 漏杀回归集 / §10 验收①「PII 回归集 0 漏杀（进入 LLM 的载荷抽检断言）」）；schema
-- agent_assist / role ljr_agent_assist 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- 最小表原则裁决（控制者授权裁量，论证见任务报告）：
--   本批只建 sanitize_audit 一表；sanitize_rules 不建——脱敏规则集是合规关键路径（运行时误
--   编辑=R-02 违规，原文泄入 LLM），其变更必须走代码评审+回归集门槛而非运营可配（对齐架构
--   §4.6「与训练管线同源」：规则集/回归集为纯代码常量（模块文件 sanitize-rules /
--   sanitize-regression，连字符指称以避跨 schema 静态检查对注释点分词的误报，V9 同款），
--   M2 训练管线直接同源复用；DB 表反而使训练管线依赖运行时状态或形成第二份规则）；版本锚点
--   =SANITIZE_RULESET_VERSION 常量，随每条审计行留痕（rule_version 列）。E1 §3 的
--   drafts / agent_review_logs 属 M2 管线批次，本批不建。
--
-- sanitize_audit（抽检审计，§10「进入 LLM 的载荷抽检断言」的落库支撑）：
--   ① 原文零明文：只存 sha256 摘要（input_digest=原文摘要 / output_digest=脱敏后文本摘要）+
--     命中类型计数（hit_types jsonb，不含命中值）+ 耗时（duration_ms，§8 各段打点/P95 证据）+
--     规则集版本（rule_version，审计锚点）——这条是本模块的存在意义（架构 §4.6 合规 R4）。
--   ② 写入时机=仅命中（hits>0）且调用方未显式关闭（persistAudit!==false）：无命中行不入库
--     （防表膨胀）；行不可变（只 INSERT，无 UPDATE/DELETE 授权——与 risk_records 的人审回填
--     不同，脱敏审计无回填面；错误修正=整行重放新行）。
--   ③ hit_types CHECK 非空数组：服务面是唯一写入方，恒命中才落行（不变量固化，防旁路写入
--     空审计）；duration_ms CHECK ≥0。
--   派生索引（超出最小列清单，理由）：ix_sanitize_audit_created(created_at)——抽检采样
--   「最近 N 行」扫描面（§10 抽检断言的查询形态）。
--   ⚠M2 后置位：若草稿管线需要行级关联锚点（room_id/target_user_id），由 M2 迁移以可空列
--   追加（V 表加列先例 V7→V8 同款）；本批不预建（无消费方，最小表原则）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 agent_assist.<table>。
-- 幂等性：IF NOT EXISTS，reset 演练（drop schema 后整库重放）可重复执行。

-- ---------- agent_assist.sanitize_audit：实时脱敏命中审计（§10①抽检断言 / §8 耗时打点） ----------
CREATE TABLE IF NOT EXISTS agent_assist.sanitize_audit (
    id             bigserial    PRIMARY KEY,
    rule_version   varchar(16)  NOT NULL,
                   -- 命中所依据的脱敏规则集版本（SANITIZE_RULESET_VERSION，审计锚点）
    input_digest   varchar(64)  NOT NULL,
                   -- sha256 hex（原文 UTF-8）——原文不落明文（架构 §4.6 合规 R4）
    output_digest  varchar(64)  NOT NULL,
                   -- sha256 hex（脱敏后文本 UTF-8；进入 RAG/LLM 的载荷摘要，抽检比对锚）
    hit_types      jsonb        NOT NULL,
                   -- 按类型命中计数 [{type: name|id_card|phone|address|bank_card, count}]，不含命中值
    duration_ms    int          NOT NULL,
                   -- 本次脱敏耗时（毫秒，只含脱敏本体不含审计写；§8 ≤1s 预算打点）
    created_at     timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_sanitize_audit_hit_types CHECK (jsonb_typeof(hit_types) = 'array' AND jsonb_array_length(hit_types) > 0),
    CONSTRAINT ck_sanitize_audit_duration CHECK (duration_ms >= 0)
);

-- 抽检采样「最近 N 行」扫描面（§10 抽检断言查询形态）
CREATE INDEX IF NOT EXISTS ix_sanitize_audit_created
    ON agent_assist.sanitize_audit (created_at);

COMMENT ON TABLE agent_assist.sanitize_audit IS 'E1 实时脱敏命中审计（仅命中行；原文零明文=只存前后 sha256 摘要/类型计数/耗时/规则集版本，§10 载荷抽检断言事实源；规则集正文=代码常量（模块文件 sanitize-rules），同训练管线同源）';
COMMENT ON COLUMN agent_assist.sanitize_audit.input_digest IS 'sha256 hex（原文）——原文明文禁入本表及一切日志（R-02）；哈希仅用于确定性比对与抽检，不可逆原文';
COMMENT ON COLUMN agent_assist.sanitize_audit.output_digest IS 'sha256 hex（脱敏后文本）——进入 RAG/LLM 载荷的摘要锚（§10「进入 LLM 的载荷抽检断言」比对基线）';
COMMENT ON COLUMN agent_assist.sanitize_audit.hit_types IS '[{type, count}]（name|id_card|phone|address|bank_card）；恒非空数组（仅命中落行，CHECK 固化）；不含命中值/原文片段';
COMMENT ON COLUMN agent_assist.sanitize_audit.rule_version IS '脱敏规则集版本（代码常量 SANITIZE_RULESET_VERSION）；规则变更必须升版并同批演进回归集（模块文件 sanitize-regression）';

-- ---------- 权限（M0 占位口径，同 V1-V9 头注：应用账号接线与完整授权是 M1 接线决策） ----------
-- 审计行不可变：只授 SELECT/INSERT（无 UPDATE/DELETE——头注②）
GRANT SELECT, INSERT ON agent_assist.sanitize_audit TO ljr_agent_assist;
-- V10 新增 bigserial 序列（V9 的 ALL SEQUENCES 授权只覆盖当时存在的序列）
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_assist TO ljr_agent_assist;
