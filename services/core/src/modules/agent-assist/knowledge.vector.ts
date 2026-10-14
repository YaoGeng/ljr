/**
 * E3 向量双路径件（R4 裁决，V9 迁移头注「路径①/②」的运行时执行面）：
 *   - 路径① pgvector：embedding 列=vector(1024)+ivfflat（docker 轨/带扩展的 PG）——写入
 *     `[...]::vector` 字面量、检索 SQL 侧 `<=>` 余弦距离（score=1-distance）。
 *   - 路径② jsonb 兜底（portable 轨，本仓 dev 现状）：embedding 列=jsonb float 数组——写入
 *     `::jsonb`、检索=进程内余弦（候选集经 ix_knowledge_docs_pool 收敛到检索池）。
 * 列型分派=运行时内省 information_schema（一次探测缓存；列型只在迁移时变化）。两路径的出参
 * 契约（KnowledgeHit）完全一致；真 pgvector E2E 随 docker 环境补跑 ⚠（Ruling-4）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';

/** embedding 列物理形态（information_schema.udt_name：'vector'|'jsonb'） */
export type EmbeddingColumnMode = 'vector' | 'jsonb';

/**
 * 探测 knowledge_chunks.embedding 列型（一次调用一查，调用方缓存）。列不存在/未知列型 ⇒
 * InternalError 显性化（迁移未应用或非预期列型——静默挑一路会把脏数据写进错误列型）。
 */
export async function detectEmbeddingColumnMode(exec: SqlExecutor): Promise<EmbeddingColumnMode> {
  const res = await exec.query<{ udt_name: string }>(
    `SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'agent_assist' AND table_name = 'knowledge_chunks'
        AND column_name = 'embedding'`,
  );
  const udt = res.rows[0]?.udt_name;
  if (udt === 'vector') return 'vector';
  if (udt === 'jsonb') return 'jsonb';
  throw new AppError(
    ErrorCode.InternalError,
    `knowledge_chunks.embedding 列缺失或列型未知（迁移未应用？）：${String(udt ?? 'null')}`,
  );
}

/** float 数组 → pgvector 字面量文本（`$n::vector` 参数载体；'[0.5,-0.25]'） */
export function toPgvectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(',')}]`;
}

/** 写入参数按列型分派：两形态的参数文本与 cast 后缀（INSERT 构造用） */
export function embeddingParam(
  mode: EmbeddingColumnMode,
  vec: readonly number[],
): { text: string; cast: 'vector' | 'jsonb' } {
  return mode === 'vector'
    ? { text: toPgvectorLiteral(vec), cast: 'vector' }
    : { text: JSON.stringify(vec), cast: 'jsonb' };
}

/**
 * 余弦相似度（两路径共用打分基元）：零向量约定返回 0（不产生 NaN——零向量无方向，相似度
 * 无定义，取 0 让其排到尾部而非炸检索）。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new AppError(
      ErrorCode.InternalError,
      `向量维度不匹配（${a.length} vs ${b.length}）——embedding 维度漂移，检索结果不可信`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 路径①检索 SQL（pgvector）：`<=>` 为余弦距离（1-余弦相似度），score=1-distance。
 * 过滤面=检索池定义（R-02/§4/§9）：在册专项 + active + READY + granted。
 */
export function buildVectorSearchSql(): string {
  return `SELECT c.id, c.doc_id, c.chunk, c.metadata, d.title, d.source_type,
                 1 - (c.embedding <=> $2::vector) AS score
            FROM agent_assist.knowledge_chunks c
            JOIN agent_assist.knowledge_docs d ON d.id = c.doc_id
           WHERE d.specialty = $1 AND d.active
             AND d.process_status = 'READY' AND d.license_status = 'granted'
           ORDER BY c.embedding <=> $2::vector
           LIMIT $3`;
}

/** 路径②候选装载 SQL（jsonb）：同过滤面；排序/截断在进程内做（余弦+稳定 tie-break） */
export function buildJsonbSearchSql(): string {
  return `SELECT c.id, c.doc_id, c.chunk, c.metadata, d.title, d.source_type, c.embedding
            FROM agent_assist.knowledge_chunks c
            JOIN agent_assist.knowledge_docs d ON d.id = c.doc_id
           WHERE d.specialty = $1 AND d.active
             AND d.process_status = 'READY' AND d.license_status = 'granted'`;
}
