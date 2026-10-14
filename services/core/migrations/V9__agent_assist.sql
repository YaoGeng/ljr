-- M1-W1 V9：agent_assist 模块追加（E3 专项配置与知识库·W1 配置基建切片）——
-- specialty_configs / knowledge_docs / knowledge_chunks 三表（§3 领域模型）。
--
-- 施工规格：docs/modules/E-AI辅助/E3-专项配置与知识库.md；schema agent_assist / role
-- ljr_agent_assist 已由 V1 建好（禁增删 schema/role，本文件不触碰）。
--
-- R4 裁决落地（pgvector 兜底，M1-W1 执行计划 Task 6）：portable 栈无 pgvector 扩展。本迁移按
-- §3 用 pgvector 语法表达，执行期双路径（行为差异=embedding 物理列型与检索执行位置；服务层
-- 出参契约 KnowledgeHit{chunk,score,...} 两路完全一致）：
--   路径①（CREATE EXTENSION vector 成功：docker 轨/带 pgvector 的 PG）
--     embedding 列 = vector(1024)（§3 逐字）+ ivfflat 余弦索引 ix_chunks_vec（§3 逐字）；
--     检索 = SQL 侧 `<=>` 余弦距离排序（score = 1 - distance），写入 = `'{...}'::vector` 字面量。
--   路径②（扩展不可用：portable 轨，本仓 dev 现状）→ 降级不失败（头注红线：禁止因 extension
--     缺失让迁移整体失败）
--     embedding 列 = jsonb（float 数组等价承载；维度语义 1024 由服务层写入守卫保证）；
--     ix_chunks_vec 跳过（本标注即该降级的可追溯标记）；检索 = 进程内余弦（候选集经
--     ix_knowledge_docs_pool 部分索引收敛到检索池，dev 语料量级 P95 预算内 ⚠ 生产换路径①）。
--   运行时分派：服务层启动后内省 information_schema.columns 的列型（'vector'|'jsonb'）——
--   实现见 src/modules/agent-assist/knowledge-vector（模块文件 knowledge 点 vector，注：为避开
--   跨 schema 静态检查对注释中点分词的误报，此处以连字符指称文件名）。⚠决策位（Ruling-4）：
--   真 pgvector E2E 随 docker 环境补跑；本仓当前验证环境=路径②。
-- 注：两分支的 CREATE TABLE 文本均会被 gen-table-manifest 正则命中（同名表先到先记，无影响）。
--
-- 表清单与文档对照（§3 原文列逐字 + 口径归一/最小追加，沿 V4~V8 同款先例）：
--   specialty_configs：
--   ① active 补 NOT NULL DEFAULT true（§3 裸列）；created_at/updated_at 补 timestamptz
--     NOT NULL DEFAULT now()（§3 无；变更留痕/排障，V7/V8 归一③同款）。
--   ② 追加列 question_tree_version / prompts_version int NOT NULL DEFAULT 0：§5 PUT 返回
--     {version} 且幂等键=key+base_version 的最小承载（控制者裁决允许加字段）；prompts 变更记
--     version=R-03「提示词变更只影响后续生成」的版本锚点（W1 无生成消费方，结构留位）。
--   ③ seed：INSERT labor_arbitration 唯一行（R-04：V1 仅此专项；ON CONFLICT 幂等，reset 整库
--     重放安全）。管理面 PUT 另有首写创建兜底（行缺失时自愈，见 agent-assist 配置服务）。
--   knowledge_docs：
--   ④ 追加列 file_hash varchar(64) NOT NULL + UNIQUE(specialty, file_hash)：§5「幂等键=
--     file_hash」的承载（§3 裸列清单没有；sha256 hex 64 位，对解析后正文取哈希）。
--   ⑤ 追加列 process_status varchar(12) NOT NULL DEFAULT 'PENDING' + CHECK：§8「文档上传异步
--     处理（≤5min）」的状态位可观测承载（PENDING→READY|FAILED）；检索池只取 READY——
--     §10「新文档入库后 E1 检索可见」以状态位+检索 API 断言，非 sleep 等待。
--   ⑥ 追加列 active bool NOT NULL DEFAULT true：§4「文档禁用即检索过滤」/§10 验收的最小承载
--     （禁用=置 false 并同事务出 KnowledgeUpdated；管理面 REST M2 接线，机制面 setDocActive 先行）。
--   ⑦ title 补 NOT NULL varchar(256)（§3 裸列）；file_ref 补 NOT NULL text——W1 最小形态=
--     'inline:'+UTF-8 纯文本（控制者裁决；pdf/docx 解析与 I3 文件存储引用 M2 开放，⚠决策位；
--     未知形态 400 拒收，不静默收下无法解析的引用）；uploaded_by 可空（§3 裸列；W1 无 admin
--     鉴权接线 → NULL，W2+ 回填）；created_at 归一③；三枚举 CHECK 固化：
--     source_type=official|firm_authorized|anonymized（§2 三类知识来源）；
--     license_status=granted|pending|revoked（「授权状态登记」三态：仅 granted 入检索池，
--     pending/revoked 登记在册但被检索过滤=§9「未登记授权状态的语料入检索池」禁令的执行面；
--     缺失/非法枚举=400 无法入库，§10 验收④）。
--   knowledge_chunks：
--   ⑧ doc_id 补 NOT NULL + 同 schema FK → knowledge_docs(id)（§3 裸列；引用完整性，分块随
--     文档生命周期，W1 无删除路径）；metadata 补 NOT NULL DEFAULT '{}'（§3 裸列；形态
--     {chunk_index, char_start, char_end}=码点偏移，服务层写入保证）。
--   ⑨ embedding 保持可空（§3 裸列语义；服务面分块行恒带向量=ingest 原子写，NULL 仅 DDL 裂隙
--     非产物）。
--   派生索引（超出 §3 清单，理由）：
--     ix_chunks_doc(doc_id)                 —— 按文档的分块清理/统计扫描面（两路径共用）；
--     ix_knowledge_docs_pool(specialty)     —— 检索池部分索引（active AND READY AND granted，
--                                              jsonb 路径候选集收敛面，路径①下亦加速存在性判断）；
--     ix_chunks_vec                          —— 路径①专属（§3 逐字），路径②跳过（见 R4 注）。
--     ⚠ ivfflat lists 参数留 PG 默认（100），真实语料量级落位后随供应商接入调优（M2-W3 ⚠）。
--
-- 注意：flyway.conf defaultSchema=flyway —— 所有 DDL 一律全限定 agent_assist.<table>。
-- 幂等性：全部 IF NOT EXISTS / ON CONFLICT DO NOTHING，reset 演练（drop schema 后整库重放）
-- 可重复执行；CREATE EXTENSION 失败被 DO 块子事务捕获（不毒化迁移事务）。

-- ---------- agent_assist.specialty_configs：专项配置包（§3；R-01 配置包唯一事实源） ----------
CREATE TABLE IF NOT EXISTS agent_assist.specialty_configs (
    id                    bigserial    PRIMARY KEY,
    specialty             varchar(32)  NOT NULL,
                          -- 专项 key（§3 UNIQUE；V1 仅 labor_arbitration，R-04）
    question_tree         jsonb        NOT NULL,
                          -- 问题树（§3；结构 {root, nodes:[{id,label,children}]}，服务层校验，
                          -- 空树 {root:'',nodes:[]} 为 seed/清空语义）
    prompts               jsonb        NOT NULL,
                          -- 提示词模板（§3/R-03 版本化；结构 {templates:{<key>:<content>}}）
    active                bool         NOT NULL DEFAULT true,
                          -- §3 裸列；专项停用位（false=整包停用，配置读取面过滤）
    question_tree_version int          NOT NULL DEFAULT 0,
                          -- 追加列（见头注②）：问题树当前版本（0=未编辑过，PUT 幂等键基数）
    prompts_version       int          NOT NULL DEFAULT 0,
                          -- 追加列（见头注②/R-03）：提示词当前版本（变更记 version，只影响后续生成）
    created_at            timestamptz  NOT NULL DEFAULT now(),
    updated_at            timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_specialty_configs_specialty UNIQUE (specialty)
);

COMMENT ON TABLE agent_assist.specialty_configs IS 'E3 专项配置包（R-01：知识库+问题树+提示词+词表引用按专项收敛；V1 仅 labor_arbitration，R-04；词表引用经 H5 词库机制 API，本表不冗余存储）';
COMMENT ON COLUMN agent_assist.specialty_configs.question_tree IS '问题树 {root, nodes:[{id,label,children:[]}]}；空树 {root:"",nodes:[]}（seed/清空）；C2 引导页经 GET /specialty/question-tree 消费';
COMMENT ON COLUMN agent_assist.specialty_configs.prompts IS '提示词模板 {templates:{<key 1..64>:<content 1..20000>}}；R-03 变更记 prompts_version，只影响后续生成';

-- R-04：V1 仅 labor_arbitration（seed 唯一行；空树/空模板为初始态，C2/E1 消费面按 version=0 识别）
INSERT INTO agent_assist.specialty_configs (specialty, question_tree, prompts)
VALUES ('labor_arbitration', '{"root":"","nodes":[]}'::jsonb, '{"templates":{}}'::jsonb)
ON CONFLICT (specialty) DO NOTHING;

-- ---------- agent_assist.knowledge_docs：知识库文档（§3 + 头注④~⑦） ----------
CREATE TABLE IF NOT EXISTS agent_assist.knowledge_docs (
    id             bigserial    PRIMARY KEY,
    specialty      varchar(32)  NOT NULL,
                   -- 专项 key（写入面校验在册专项，R-04；不 FK configs——配置行缺失由管理面自愈兜底）
    title          varchar(256) NOT NULL,
                   -- §3 裸列；缺省取正文首行截 64 码点（服务层派生）
    source_type    varchar(16)  NOT NULL,
                   -- official|firm_authorized|anonymized（§2 三类知识来源）
    license_status varchar(12)  NOT NULL,
                   -- granted|pending|revoked（授权状态登记，R-02；仅 granted 入检索池，§9 禁令）
    file_ref       text         NOT NULL,
                   -- W1='inline:'+UTF-8 纯文本；pdf/docx/i3 引用 M2 接 I3 后开放（头注⑦ ⚠）
    file_hash      varchar(64)  NOT NULL,
                   -- 追加列（头注④）：解析后正文 sha256 hex（§5 幂等键=file_hash）
    process_status varchar(12)  NOT NULL DEFAULT 'PENDING',
                   -- 追加列（头注⑤）：PENDING→READY|FAILED（异步向量化状态位，§8 ≤5min 可观测）
    active         bool         NOT NULL DEFAULT true,
                   -- 追加列（头注⑥）：false=禁用（检索过滤，§4/§10）
    uploaded_by    bigint       NULL,
                   -- §3 裸列；W1 无 admin 鉴权接线 → NULL（W2+ 回填）
    created_at     timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_knowledge_docs_specialty_hash UNIQUE (specialty, file_hash),
    CONSTRAINT ck_knowledge_docs_source CHECK (source_type IN ('official', 'firm_authorized', 'anonymized')),
    CONSTRAINT ck_knowledge_docs_license CHECK (license_status IN ('granted', 'pending', 'revoked')),
    CONSTRAINT ck_knowledge_docs_process CHECK (process_status IN ('PENDING', 'READY', 'FAILED'))
);

COMMENT ON TABLE agent_assist.knowledge_docs IS 'E3 知识库文档（上传→解析→分块→向量化→入检索池；授权状态登记 R-02，仅 granted+READY+active 入检索池）';
COMMENT ON COLUMN agent_assist.knowledge_docs.license_status IS '授权状态三态：granted=已授权（入检索池）/pending=待确认/revoked=已撤回（后两者登记在册但检索过滤，§9 禁令）';
COMMENT ON COLUMN agent_assist.knowledge_docs.file_ref IS 'W1 最小形态 inline:<UTF-8 纯文本>；pdf/docx/i3:// 形态 M2 随 I3 与解析器开放（未知形态上传 400 拒收）';
COMMENT ON COLUMN agent_assist.knowledge_docs.file_hash IS '解析后正文 sha256 hex（64 位）；UNIQUE(specialty, file_hash)=§5 幂等键=file_hash';

-- ---------- agent_assist.knowledge_chunks：分块+向量（§3；R4 双路径见头注） ----------
-- 派生索引：检索池部分索引（jsonb 路径候选集收敛面；头注⑨）
CREATE INDEX IF NOT EXISTS ix_knowledge_docs_pool
    ON agent_assist.knowledge_docs (specialty)
    WHERE active AND process_status = 'READY' AND license_status = 'granted';

DO $$
DECLARE
    has_vector bool := false;
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
        has_vector := true;
    EXCEPTION WHEN OTHERS THEN
        -- portable 轨：扩展不可用 → 路径②降级（头注 R4 红线：不得让迁移整体失败）
        has_vector := false;
    END;

    IF has_vector THEN
        -- 路径①：pgvector 原生（§3 逐字：vector(1024) + ivfflat 余弦索引；lists 留默认 ⚠ 头注）
        CREATE TABLE IF NOT EXISTS agent_assist.knowledge_chunks (
            id        bigserial     PRIMARY KEY,
            doc_id    bigint        NOT NULL REFERENCES agent_assist.knowledge_docs (id),
            chunk     text          NOT NULL,
            embedding vector(1024),
            metadata  jsonb         NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS ix_chunks_vec
            ON agent_assist.knowledge_chunks USING ivfflat (embedding vector_cosine_ops);
    ELSE
        -- 路径②：降级承载（embedding=jsonb float 数组；ix_chunks_vec 跳过=降级标记，头注 R4）
        CREATE TABLE IF NOT EXISTS agent_assist.knowledge_chunks (
            id        bigserial     PRIMARY KEY,
            doc_id    bigint        NOT NULL REFERENCES agent_assist.knowledge_docs (id),
            chunk     text          NOT NULL,
            embedding jsonb,
            metadata  jsonb         NOT NULL DEFAULT '{}'::jsonb
        );
    END IF;
END
$$;

-- 按文档的分块扫描面（头注⑨；两路径共用）
CREATE INDEX IF NOT EXISTS ix_chunks_doc
    ON agent_assist.knowledge_chunks (doc_id);

COMMENT ON TABLE agent_assist.knowledge_chunks IS 'E3 知识库分块（512 token 重叠 64，token 口径=Unicode 码点；embedding 列型随 R4 双路径：vector(1024)|jsonb）';
COMMENT ON COLUMN agent_assist.knowledge_chunks.metadata IS '{chunk_index, char_start, char_end}（码点偏移，服务层写入保证）';

-- ---------- 权限（M0 占位口径，同 V1-V8 头注：应用账号接线与完整授权是 M1 接线决策） ----------
GRANT SELECT, INSERT, UPDATE ON agent_assist.specialty_configs TO ljr_agent_assist;
GRANT SELECT, INSERT, UPDATE ON agent_assist.knowledge_docs TO ljr_agent_assist;
GRANT SELECT, INSERT, UPDATE ON agent_assist.knowledge_chunks TO ljr_agent_assist;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agent_assist TO ljr_agent_assist;
