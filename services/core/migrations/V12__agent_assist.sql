-- V12（agent_assist 域）—— E3 pgvector 扩展归位 public（CI db-check 路径①修复）
--
-- 根因（CI run#9 db-check，2026-10-15）：Flyway 13 迁移会话 search_path 首位=defaultSchema
--（探针实测 = flyway, $user, public），V9 迁移的 CREATE EXTENSION 无 WITH SCHEMA → 扩展落进
-- flyway schema，且 V9 建表语句的 vector(1024) 列型绑定 flyway schema 的 vector 类型。应用
-- 连接 search_path 不含 flyway → 参数 cast 解析失败（type "vector" does not exist）→ ingest
-- 全部置 FAILED。portable 轨无 pgvector 走路径②（jsonb）不受影响，故本地全绿、仅 CI（pgvector
-- 镜像）暴露。
--
-- 本迁移：把扩展归位 public（事务级 set_config 把 search_path 置 public 优先，摆脱会话依赖），
-- 并把列型重绑 public 的 vector + 重建 ivfflat。幂等三态：
--   ① 无 pgvector 环境（portable 路径②）：扩展不存在 → 直接 RETURN，jsonb 兜底不动；
--   ② 扩展已归位 public（重放第二次到达）：列型已 vector → 跳过重绑；
--   ③ 扩展错位 flyway schema（CI 现场）：删索引 → 列降 jsonb（vector 文本即合法 jsonb 数组）
--      → 摘扩展 → search_path=public 重装 → 列升 vector(1024) → 重建 ivfflat。
-- 回放推演（整库重放口径）：drop 业务 schema → flyway clean 只清 flyway schema（错位扩展已被
-- 本迁移摘除；public 扩展不受 clean 影响）→ 重放 V9：CREATE EXTENSION IF NOT EXISTS 命中
-- public 已装 = no-op（不再错位），建表的 vector(1024) 经 search_path 尾位解析到 public ✓ →
-- V12 第二到达 = 状态② no-op ✓。
-- SQL 机制已用 hstore 替身在探针库验证（错位→归位→重绑→索引重建全绿，2026-10-15）。
-- 注：全文不使用「别名.列」「public.类型」形态（check-schema-refs 规则 C 静态扫描口径），
--     类型解析走事务级 search_path；目录查询用无别名单表 + regnamespace 转型。

DO $$
DECLARE
  ext_ns   text;
  col_type text;
BEGIN
  -- ① 扩展是否存在 + 装在哪个 schema（无别名：转型 regnamespace 取名）
  SELECT extnamespace::regnamespace::text INTO ext_ns
    FROM pg_extension
   WHERE extname = 'vector';

  IF ext_ns IS NULL THEN
    RETURN; -- ① 无 pgvector 环境：路径② jsonb 兜底维持原状
  END IF;

  -- ③ 扩展错位（非 public）：解除依赖后摘除重装
  IF ext_ns <> 'public' THEN
    EXECUTE 'DROP INDEX IF EXISTS agent_assist.ix_chunks_vec';
    EXECUTE 'ALTER TABLE agent_assist.knowledge_chunks
              ALTER COLUMN embedding TYPE jsonb USING embedding::text::jsonb';
    EXECUTE 'DROP EXTENSION vector';
  END IF;

  -- ② 归位 public：事务级 search_path（local=true，提交后即还原，不污染 Flyway 会话）
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  CREATE EXTENSION IF NOT EXISTS vector;

  -- 列型重绑（仅当仍处 jsonb——错位重装路径或理论中间态；IF NOT EXISTS 兜并发/中间态残留）
  SELECT format_type(atttypid, atttypmod) INTO col_type
    FROM pg_attribute
   WHERE attrelid = 'agent_assist.knowledge_chunks'::regclass
     AND attname = 'embedding';
  IF col_type = 'jsonb' THEN
    EXECUTE 'ALTER TABLE agent_assist.knowledge_chunks
              ALTER COLUMN embedding TYPE vector(1024) USING embedding::text::vector';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_chunks_vec
              ON agent_assist.knowledge_chunks USING ivfflat (embedding vector_cosine_ops)';
  END IF;
END
$$;
