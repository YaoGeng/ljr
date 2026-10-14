import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { AppError } from '@ljr/shared';
import { chunkText, type TextChunk } from './knowledge.chunker';
import { MockEmbeddingProvider } from './knowledge.embedding';
import {
  buildJsonbSearchSql,
  buildVectorSearchSql,
  cosineSimilarity,
  embeddingParam,
  toPgvectorLiteral,
} from './knowledge.vector';

/**
 * E3 知识库纯机制件（无需 PG）：分块器（§4 512 token 重叠 64，token 口径=Unicode 码点）+
 * 确定性 mock embedding（§9/⚠：同文本同向量、维度可注入、零网络）+ 余弦相似度 + R4 双路径
 * 的 SQL/字面量构造件。DB 侧 e2e 见 knowledge.spec.ts / specialty.spec.ts。
 */

describe('E3 分块器（§4：512 token 重叠 64；token 口径=Unicode 码点）', () => {
  const opts = { chunkTokens: 10, overlapTokens: 3 };

  it('§9 分块确定性：同文件同分块（同输入两次调用深全等）', () => {
    const text = '劳动仲裁申请请求确认劳动关系，并支付拖欠工资。'.repeat(5);
    const a: TextChunk[] = chunkText(text, opts);
    const b: TextChunk[] = chunkText(text, opts);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
  });

  it('窗口/重叠/步进：stride=chunkTokens-overlap，charStart/charEnd 为码点偏移，index 连续', () => {
    const text = '0123456789'.repeat(2) + 'abcde'; // 25 个码点
    const chunks = chunkText(text, opts); // stride=7 → [0,10) [7,17) [14,24) [21,25)
    expect(chunks.map((c) => [c.charStart, c.charEnd])).toEqual([
      [0, 10],
      [7, 17],
      [14, 24],
      [21, 25],
    ]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => c.text)).toEqual([
      text.slice(0, 10),
      text.slice(7, 17),
      text.slice(14, 24),
      text.slice(21, 25),
    ]);
  });

  it('短于窗口的文本 → 单块；空文本 → 零块', () => {
    expect(chunkText('短文本', opts)).toEqual([
      { index: 0, text: '短文本', charStart: 0, charEnd: 3 },
    ]);
    expect(chunkText('', opts)).toEqual([]);
  });

  it('token 口径=Unicode 码点：代理对（emoji）按 1 token 计，不按 UTF-16 下标切半', () => {
    const text = '😀'.repeat(12);
    const chunks = chunkText(text, { chunkTokens: 10, overlapTokens: 0 });
    expect(chunks).toHaveLength(2);
    expect([...chunks[0]!.text]).toHaveLength(10);
    expect([...chunks[1]!.text]).toHaveLength(2);
    expect(chunks[1]!.charStart).toBe(10);
    expect(chunks[1]!.charEnd).toBe(12);
  });

  it('入参守卫：overlap ≥ chunkTokens / 负值 → 400 E_INVALID_ARGUMENT', () => {
    expect(() => chunkText('x', { chunkTokens: 8, overlapTokens: 8 })).toThrowError(AppError);
    expect(() => chunkText('x', { chunkTokens: 8, overlapTokens: 9 })).toThrowError(AppError);
    expect(() => chunkText('x', { chunkTokens: 0, overlapTokens: 0 })).toThrowError(AppError);
    try {
      chunkText('x', { chunkTokens: 4, overlapTokens: 4 });
      expect.unreachable('应抛出');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.InvalidArgument);
    }
  });
});

describe('E3 余弦相似度（检索打分基元，两路径共用）', () => {
  it('同向=1 / 正交=0 / 反向=-1 / 零向量=0（不产生 NaN）', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 12);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(Number.isNaN(cosineSimilarity([0, 0], [0, 0]))).toBe(false);
  });
});

describe('E3 mock embedding（⚠决策位：确定性桩，真实境内供应商 D11/M2-W3 接入）', () => {
  it('§9 确定性：同文本同向量（跨实例）；不同文本向量不同', async () => {
    const a = new MockEmbeddingProvider(8);
    const b = new MockEmbeddingProvider(8);
    const [va] = await a.embed(['确认劳动关系']);
    const [vb] = await b.embed(['确认劳动关系']);
    const [vc] = await a.embed(['违法解除劳动合同']);
    expect(va).toEqual(vb);
    expect(va).not.toEqual(vc);
  });

  it('维度可注入；输出为单位向量（L2 范数≈1）且分量有限、落在 [-1,1]', async () => {
    const p = new MockEmbeddingProvider(16);
    const [v] = await p.embed(['工资支付标准']);
    expect(v).toHaveLength(16);
    for (const x of v!) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
    }
    const norm = Math.sqrt(v!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 9);
  });

  it('批量入参逐条对应且各自确定', async () => {
    const p = new MockEmbeddingProvider(8);
    const [x, y] = await p.embed(['甲文本', '乙文本']);
    const [x2] = await p.embed(['甲文本']);
    expect(x).toEqual(x2);
    expect(y).not.toEqual(x);
  });
});

describe('E3 pgvector 双路径件（R4 裁决：两路径均可用可测；真 pgvector E2E 随 docker ⚠）', () => {
  it('pgvector 字面量：数值数组 → [a,b,c] 文本（::vector 参数载体）', () => {
    expect(toPgvectorLiteral([0.5, -0.25, 1])).toBe('[0.5,-0.25,1]');
    expect(toPgvectorLiteral([])).toBe('[]');
  });

  it('写入参数按列型分派：vector → ::vector 字面量；jsonb → JSON 数组串', () => {
    expect(embeddingParam('vector', [1, 2])).toEqual({ text: '[1,2]', cast: 'vector' });
    expect(embeddingParam('jsonb', [1, 2])).toEqual({ text: '[1,2]', cast: 'jsonb' });
    JSON.parse(embeddingParam('jsonb', [0.5, -0.25]).text);
  });

  it('路径①检索 SQL：pgvector 语法表达（<=> 余弦距离 + 三重过滤 + LIMIT + 显式 tie-break）', () => {
    const sql = buildVectorSearchSql();
    expect(sql).toContain('agent_assist.knowledge_chunks');
    expect(sql).toContain('agent_assist.knowledge_docs');
    expect(sql).toContain('<=>');
    expect(sql).toContain('::vector');
    expect(sql).toContain('d.specialty = $1');
    expect(sql).toContain('d.active');
    expect(sql).toContain("'READY'");
    expect(sql).toContain("'granted'");
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('LIMIT');
    // 路径①守卫（评审 Important-1）：KnowledgeHit 契约承诺「同分按 docId,chunkIndex 稳定序」，
    // ORDER BY 必须显式 tie-break（doc_id, id），与 jsonb 路径口径一致——同分序不得依赖索引扫描
    expect(sql).toMatch(/ORDER BY\s+c\.embedding <=> \$2::vector, c\.doc_id, c\.id\b/);
  });

  it('路径②检索 SQL：同过滤面、无 pgvector 算子（进程内余弦的候选装载语句）', () => {
    const sql = buildJsonbSearchSql();
    expect(sql).toContain('agent_assist.knowledge_chunks');
    expect(sql).toContain('agent_assist.knowledge_docs');
    expect(sql).toContain('d.specialty = $1');
    expect(sql).toContain('d.active');
    expect(sql).toContain("'READY'");
    expect(sql).toContain("'granted'");
    expect(sql).toContain('embedding');
    expect(sql).not.toContain('<=>');
  });
});
