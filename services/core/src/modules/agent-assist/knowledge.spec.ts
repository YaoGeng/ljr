import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { KNOWLEDGE_CONFIG, KNOWLEDGE_DEFAULT_CONFIG } from './knowledge.config';
import { chunkText } from './knowledge.chunker';
import { EMBEDDING_PROVIDER } from './knowledge.embedding';
import { KNOWLEDGE_UPDATED_TOPIC } from './knowledge.events';
import { detectEmbeddingColumnMode } from './knowledge.vector';
import { SpecialtyKnowledgeModule } from './specialty.module';
import { KnowledgeService } from './knowledge.service';

/**
 * E3 知识库 e2e（需 PG）：§5 上传契约（幂等键=file_hash、400 BAD_FORMAT）/ §8 异步向量化
 * 可观测完成（≤5min 预算内，waitIdle 回调非 sleep）/ §9 附加用例（分块确定性 e2e 层、缓存失效
 * 事件、禁用文档不出现在检索结果、无授权状态文档无法入库）/ R-02 授权门 / §10 验收 + E1 检索
 * 内部 API（top_k=8 cosine）+ R4 双路径（本环境=jsonb 兜底，真 pgvector 随 docker ⚠）。
 *
 * 测试配置注入小维度（dim=16）与小窗口（64/16）压低用例耗时；生产配置见 KNOWLEDGE_DEFAULT_CONFIG。
 */

const SPEC_OPTS = {
  // embeddingDim 不覆写：继承默认 1024，与 V9 列型 vector(1024) 对齐——路径①（真 pgvector）
  // 列强校验维度，测试注入小维度会在 CI 挂（路径② jsonb 不校验维度，本地测不出）
  ...KNOWLEDGE_DEFAULT_CONFIG,
  chunkTokenSize: 64,
  chunkOverlapTokens: 16,
  maxInlineChars: 20_000,
};

const DOC_A = [
  '第一段：申请人周女士与被申请人某科技公司存在劳动关系，入职时间为 2024 年 3 月。',
  '第二段：被申请人自 2025 年 1 月起拖欠工资，每月应发一万元整。',
  '第三段：申请人请求裁决解除劳动合同经济补偿金。',
].join('\n');

const DOC_B = '独立文档乙：关于加班费计算基数的说明文字，用于检索命中隔离验证。';

interface UploadInput {
  readonly fileRef: string;
  readonly sourceType: string;
  readonly licenseStatus: string;
  readonly title?: string;
}

const outboxOf = async (pool: Pool, topic: string) => {
  const res = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
    [topic],
  );
  return res.rows;
};

describe('E3 知识库机制（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: KnowledgeService;

  const upload = (input: UploadInput) =>
    svc.uploadDocument({
      specialty: 'labor_arbitration',
      fileRef: input.fileRef,
      sourceType: input.sourceType,
      licenseStatus: input.licenseStatus,
      title: input.title,
    });

  const docRow = async (id: number) => {
    const res = await pool.query<{
      id: string;
      specialty: string;
      title: string;
      process_status: string;
      active: boolean;
      license_status: string;
      file_hash: string;
    }>(`SELECT * FROM agent_assist.knowledge_docs WHERE id = $1`, [id]);
    return res.rows[0];
  };

  const chunksOf = async (docId: number) => {
    const res = await pool.query<{
      id: string;
      doc_id: string;
      chunk: string;
      embedding: unknown;
      metadata: Record<string, unknown>;
    }>(`SELECT * FROM agent_assist.knowledge_chunks WHERE doc_id = $1 ORDER BY id`, [docId]);
    return res.rows;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [SpecialtyKnowledgeModule] })
      .overrideProvider(KNOWLEDGE_CONFIG)
      .useValue(SPEC_OPTS)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(KnowledgeService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await svc.waitIngestIdle(); // 在队 ingest 排空后再清场（TRUNCATE 与在途 ingest 行锁互斥）
    await truncateAll(pool);
  });

  it('§10/R-02 无授权状态文档无法入库：缺 license_status/非法枚举 → 400 E_BAD_FORMAT 且零落库', async () => {
    await expect(
      upload({ fileRef: 'inline:正文', sourceType: 'official', licenseStatus: '' }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat });
    await expect(
      upload({ fileRef: 'inline:正文', sourceType: 'official', licenseStatus: 'unknown' }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat });
    await expect(
      // @ts-expect-error 故意缺参（HTTP 面可缺，机制面断言同口径）
      svc.uploadDocument({
        specialty: 'labor_arbitration',
        fileRef: 'inline:正文',
        sourceType: 'official',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat });
    const rows = await pool.query(`SELECT * FROM agent_assist.knowledge_docs`);
    expect(rows.rowCount).toBe(0);
  });

  it('§5 上传格式门（400 E_BAD_FORMAT）：file_ref 非 inline: 形态/空正文/超长；source_type 枚举；R-04 未知专项 400', async () => {
    await expect(
      upload({ fileRef: 'i3://file-123', sourceType: 'official', licenseStatus: 'granted' }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat }); // pdf/docx/i3 解析 M2 开放
    await expect(
      upload({ fileRef: 'inline:   ', sourceType: 'official', licenseStatus: 'granted' }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat });
    await expect(
      upload({
        fileRef: `inline:${'字'.repeat(SPEC_OPTS.maxInlineChars + 1)}`,
        sourceType: 'official',
        licenseStatus: 'granted',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat });
    await expect(
      upload({ fileRef: 'inline:正文', sourceType: 'weibo', licenseStatus: 'granted' }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat });
    await expect(
      upload({ fileRef: 'inline:正文', sourceType: '', licenseStatus: 'granted' }),
    ).rejects.toMatchObject({ code: ErrorCode.KnowledgeBadFormat });
    await expect(
      svc.uploadDocument({
        specialty: 'trade',
        fileRef: 'inline:正文',
        sourceType: 'official',
        licenseStatus: 'granted',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.SpecialtyUnsupported });
  });

  it('§5 幂等键=file_hash：同文重传同 doc_id created:false 零重复行；异文新 doc', async () => {
    const first = await upload({
      fileRef: `inline:${DOC_B}`,
      sourceType: 'firm_authorized',
      licenseStatus: 'granted',
    });
    expect(first.created).toBe(true);
    const replay = await upload({
      fileRef: `inline:${DOC_B}`,
      sourceType: 'firm_authorized',
      licenseStatus: 'granted',
    });
    expect(replay.doc_id).toBe(first.doc_id);
    expect(replay.created).toBe(false);
    const other = await upload({
      fileRef: `inline:${DOC_B}（修订版）`,
      sourceType: 'official',
      licenseStatus: 'granted',
    });
    expect(other.doc_id).not.toBe(first.doc_id);
    expect(other.created).toBe(true);
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_assist.knowledge_docs`,
    );
    expect(rows.rows[0]!.n).toBe(2);
    // file_hash=sha256 hex 64 位落库（UNIQUE(specialty,file_hash) 为幂等承载）
    const row = await docRow(first.doc_id);
    expect(row!.file_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('§8 异步向量化可观测完成：PENDING→READY（waitIdle 回调非 sleep）；分块/向量/metadata 落库；KnowledgeUpdated 同事务出箱', async () => {
    const up = await upload({
      fileRef: `inline:${DOC_A}`,
      sourceType: 'official',
      licenseStatus: 'granted',
      title: '劳动关系争议材料',
    });
    expect(up.process_status).toBe('PENDING');
    let row = await docRow(up.doc_id);
    expect(row!.process_status).toBe('PENDING');
    await svc.waitIngestIdle(); // 完成回调形态的可观测完成（§8 ≤5min 的断言承载）
    row = await docRow(up.doc_id);
    expect(row!.process_status).toBe('READY');
    expect(row!.title).toBe('劳动关系争议材料');
    // 分块落库：DOC_A=约 66 码点 → 窗口 64/重叠 16（stride 48）→ 2 块
    const chunks = await chunksOf(up.doc_id);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.metadata).toEqual({ chunk_index: 0, char_start: 0, char_end: 64 });
    expect(chunks[1]!.metadata).toEqual({ chunk_index: 1, char_start: 48, char_end: DOC_A.length });
    expect(chunks[0]!.chunk).toBe(DOC_A.slice(0, 64));
    expect(chunks[1]!.chunk).toBe(DOC_A.slice(48));
    // 向量落库双路径（R4）：jsonb=路径②读回数组；vector=路径①读回 '[..]' 文本（pgvector 文本
    // 形态即合法 JSON 数组）——统一解析后断言维度=config.embeddingDim
    const raw = chunks[0]!.embedding as number[] | string;
    const embedding: number[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding).toHaveLength(SPEC_OPTS.embeddingDim);
    // §6：KnowledgeUpdated 与 READY 同事务出箱（载荷 specialty 逐字 + additive 定位字段）
    const events = await outboxOf(pool, KNOWLEDGE_UPDATED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      specialty: 'labor_arbitration',
      doc_id: up.doc_id,
      reason: 'ready',
    });
    // 终审 Important-1：READY 迁移经状态机守卫与业务同事务留 STL（状态禁裸写）
    const readyLog = await pool.query<{
      allowed: boolean;
      from_status: string;
      to_status: string;
      reason: string;
    }>(
      `SELECT allowed, from_status, to_status, reason FROM platform.state_transition_log
        WHERE entity_type = 'knowledge_doc' AND entity_id = $1 ORDER BY id`,
      [up.doc_id],
    );
    expect(readyLog.rows).toHaveLength(1);
    expect(readyLog.rows[0]).toMatchObject({
      allowed: true,
      from_status: 'PENDING',
      to_status: 'READY',
      reason: 'ingest_ready',
    });
  });

  it('§9 分块确定性（e2e 层）：落库分块行与纯函数 chunkText 输出全等（同文件同分块）', async () => {
    const up = await upload({
      fileRef: `inline:${DOC_A}`,
      sourceType: 'official',
      licenseStatus: 'granted',
    });
    await svc.waitIngestIdle();
    const chunks = await chunksOf(up.doc_id);
    const expected = chunkText(DOC_A, {
      chunkTokens: SPEC_OPTS.chunkTokenSize,
      overlapTokens: SPEC_OPTS.chunkOverlapTokens,
    });
    expect(chunks.map((c) => c.chunk)).toEqual(expected.map((c) => c.text));
    expect(chunks.map((c) => c.metadata)).toEqual(
      expected.map((c) => ({ chunk_index: c.index, char_start: c.charStart, char_end: c.charEnd })),
    );
  });

  it('E1 检索内部 API：精确命中 chunk score≈1 置顶；出参形态；topK 缺省 8 生效；空池 []', async () => {
    const a = await upload({
      fileRef: `inline:${DOC_A}`,
      sourceType: 'official',
      licenseStatus: 'granted',
    });
    const bDoc = await upload({
      fileRef: `inline:${DOC_B}`,
      sourceType: 'firm_authorized',
      licenseStatus: 'granted',
    });
    await svc.waitIngestIdle();
    const query = DOC_A.slice(48); // 恰为第二块全文（mock embedding：同文=同向量 → score≈1）
    const hits = await svc.retrieve({ specialty: 'labor_arbitration', query });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.docId).toBe(a.doc_id);
    expect(hits[0]!.chunk).toBe(DOC_A.slice(48));
    expect(hits[0]!.score).toBeGreaterThan(0.999);
    // 出参形态（§5 检索内部 API：{chunk, score, doc 元数据}）
    expect(Object.keys(hits[0]!).sort()).toEqual([
      'chunk',
      'chunkIndex',
      'docId',
      'docTitle',
      'metadata',
      'score',
      'sourceType',
    ]);
    expect(hits[0]!.sourceType).toBe('official');
    expect(typeof hits[0]!.docTitle).toBe('string');
    // 降序 + topK 生效
    for (let i = 1; i < hits.length; i++)
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    const one = await svc.retrieve({ specialty: 'labor_arbitration', query, topK: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.docId).toBe(a.doc_id); // 置顶者即精确命中块
    // 空池：无 READY 授权文档 → []（两 doc 全禁用后池空）
    await svc.setDocActive(a.doc_id, false);
    await svc.setDocActive(bDoc.doc_id, false);
    expect(await svc.retrieve({ specialty: 'labor_arbitration', query: DOC_A.slice(48) })).toEqual(
      [],
    );
  });

  it('§9/R-02 未授权语料不入检索池：pending/revoked 正常处理（READY，登记在册）但检索过滤', async () => {
    const pending = await upload({
      fileRef: `inline:${DOC_B}`,
      sourceType: 'firm_authorized',
      licenseStatus: 'pending',
    });
    await svc.waitIngestIdle();
    expect((await docRow(pending.doc_id))!.process_status).toBe('READY'); // 处理完成=登记在册
    expect(await svc.retrieve({ specialty: 'labor_arbitration', query: DOC_B })).toEqual([]); // 但不入池
    const revoked = await upload({
      fileRef: `inline:${DOC_B}（授权已撤回）`,
      sourceType: 'anonymized',
      licenseStatus: 'revoked',
    });
    await svc.waitIngestIdle();
    expect((await docRow(revoked.doc_id))!.license_status).toBe('revoked');
    // 授权语料入库后同查询命中且只含授权文档（pool 唯一性=license_status 门）
    const granted = await upload({
      fileRef: `inline:${DOC_B}（授权版附注：计算基数按合同约定）`,
      sourceType: 'firm_authorized',
      licenseStatus: 'granted',
    });
    await svc.waitIngestIdle();
    const hits = await svc.retrieve({ specialty: 'labor_arbitration', query: DOC_B });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.docId === granted.doc_id)).toBe(true);
  });

  it('§10 禁用文档被检索过滤：setDocActive false → 检索排除 + KnowledgeUpdated{reason:disabled}；恢复 → 重新可见（enabled）', async () => {
    const a = await upload({
      fileRef: `inline:${DOC_A}`,
      sourceType: 'official',
      licenseStatus: 'granted',
    });
    await svc.waitIngestIdle();
    expect(
      (await svc.retrieve({ specialty: 'labor_arbitration', query: DOC_A })).length,
    ).toBeGreaterThan(0);
    const disabled = await svc.setDocActive(a.doc_id, false);
    expect(disabled.active).toBe(false);
    expect(await svc.retrieve({ specialty: 'labor_arbitration', query: DOC_A })).toEqual([]);
    await expect(svc.setDocActive(a.doc_id, false)).resolves.toMatchObject({ active: false }); // 幂等短路
    const reEnabled = await svc.setDocActive(a.doc_id, true);
    expect(reEnabled.active).toBe(true);
    expect(
      (await svc.retrieve({ specialty: 'labor_arbitration', query: DOC_A })).length,
    ).toBeGreaterThan(0);
    const events = await outboxOf(pool, KNOWLEDGE_UPDATED_TOPIC);
    expect(events.map((e) => e.payload['reason'])).toEqual(['ready', 'disabled', 'enabled']);
    await expect(svc.setDocActive(99999, true)).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('R4 双路径落库形态：embedding 列型与探针判定一致（jsonb=路径② / vector=路径①归位 public）；检索入参校验', async () => {
    const col = await pool.query<{ udt_name: string }>(
      `SELECT udt_name FROM information_schema.columns
        WHERE table_schema='agent_assist' AND table_name='knowledge_chunks' AND column_name='embedding'`,
    );
    // 断言「物理列型 = 应用探针判定」的一致性（真实 DB 行为），不钉具体环境：
    // portable 轨=jsonb（路径②）、pgvector 镜像=vector（路径①，V12 归位 public 后可真跑）
    const detected = await detectEmbeddingColumnMode(pool);
    expect(col.rows[0]!.udt_name).toBe(detected);
    await expect(
      svc.retrieve({ specialty: 'labor_arbitration', query: '   ' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      svc.retrieve({ specialty: 'labor_arbitration', query: 'q', topK: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(svc.retrieve({ specialty: 'trade', query: 'q' })).rejects.toMatchObject({
      code: ErrorCode.SpecialtyUnsupported,
    });
  });
});

describe('E3 知识库 FAILED 路径（embedding 供应商故障注入，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: KnowledgeService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [SpecialtyKnowledgeModule] })
      .overrideProvider(KNOWLEDGE_CONFIG)
      .useValue(SPEC_OPTS)
      // 故障注入：供应商抛错（真实供应商故障/超时的形态；⚠ D11/M2-W3 换真适配器后重验）
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue({
        dim: SPEC_OPTS.embeddingDim,
        embed: async () => {
          throw new Error('供应商故障注入');
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(KnowledgeService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await svc.waitIngestIdle(); // 在队 ingest 排空后再清场
    await truncateAll(pool);
  });

  it('上传不被阻塞（返回 PENDING）；ingest 失败 → 状态位 FAILED、检索排除、无 KnowledgeUpdated', async () => {
    const up = await svc.uploadDocument({
      specialty: 'labor_arbitration',
      fileRef: `inline:${DOC_A}`,
      sourceType: 'official',
      licenseStatus: 'granted',
    });
    expect(up.process_status).toBe('PENDING'); // §8 异步：供应商故障不阻塞上传应答
    await svc.waitIngestIdle();
    const res = await pool.query<{ process_status: string }>(
      `SELECT process_status FROM agent_assist.knowledge_docs WHERE id = $1`,
      [up.doc_id],
    );
    expect(res.rows[0]!.process_status).toBe('FAILED');
    // 池排除断言：分块零落库（故障点在向量化，事务回滚）+ 检索池状态过滤已由 READY 面用例覆盖；
    // 本 app 的供应商为故障桩，retrieve 自身会随供应商抛错（此处断言其不静默成功）
    const chunkCnt = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_assist.knowledge_chunks WHERE doc_id = $1`,
      [up.doc_id],
    );
    expect(chunkCnt.rows[0]!.n).toBe(0);
    await expect(
      svc.retrieve({ specialty: 'labor_arbitration', query: DOC_A.slice(48) }),
    ).rejects.toThrow();
    expect(await outboxOf(pool, KNOWLEDGE_UPDATED_TOPIC)).toHaveLength(0); // 无 READY 即无事件
    // 终审 Important-1：FAILED 亦经守卫留痕（独立连接写 STL——业务事务已回滚，审计不得随之丢失）
    const failedLog = await pool.query<{
      allowed: boolean;
      from_status: string;
      to_status: string;
      reason: string;
    }>(
      `SELECT allowed, from_status, to_status, reason FROM platform.state_transition_log
        WHERE entity_type = 'knowledge_doc' AND entity_id = $1 ORDER BY id`,
      [up.doc_id],
    );
    expect(failedLog.rows).toHaveLength(1);
    expect(failedLog.rows[0]).toMatchObject({
      allowed: true,
      from_status: 'PENDING',
      to_status: 'FAILED',
      reason: 'ingest_failed',
    });
  });
});

describe('E3 知识库 REST 契约（§5 POST /admin/specialty/{key}/knowledge，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: KnowledgeService;
  let adminToken: string;
  let userToken: string;

  const adminPost = (url: string) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const jwtSecret = randomBytes(32).toString('hex');
    const identityConfig: IdentityConfig = {
      phoneDataKey: randomBytes(32),
      phoneBlindPepper: randomBytes(32).toString('hex'),
      jwtSecret,
    };
    const moduleRef = await Test.createTestingModule({ imports: [SpecialtyKnowledgeModule] })
      .overrideProvider(KNOWLEDGE_CONFIG)
      .useValue(SPEC_OPTS)
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(identityConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(KnowledgeService);
    const jwt = new JwtService({ secret: jwtSecret });
    adminToken = await jwt.signAsync({ sub: '990013', role: 'user', roles: ['user', 'admin'] });
    userToken = await jwt.signAsync({ sub: '990014', role: 'user', roles: ['user'] });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await svc.waitIngestIdle(); // 在队 ingest 排空后再清场
    await truncateAll(pool);
  });

  it('POST 201 {doc_id,created,process_status}；幂等重放；400 BAD_FORMAT 各形；400 SPECIALTY_UNSUPPORTED', async () => {
    const ok = await adminPost('/admin/specialty/labor_arbitration/knowledge').send({
      file_ref: `inline:${DOC_B}`,
      source_type: 'official',
      license_status: 'granted',
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ created: true, process_status: 'PENDING' });
    expect(typeof ok.body.doc_id).toBe('number');
    await svc.waitIngestIdle();

    const replay = await adminPost('/admin/specialty/labor_arbitration/knowledge').send({
      file_ref: `inline:${DOC_B}`,
      source_type: 'official',
      license_status: 'granted',
    });
    expect(replay.status).toBe(201);
    expect(replay.body.doc_id).toBe(ok.body.doc_id);
    expect(replay.body.created).toBe(false);

    const noLicense = await adminPost('/admin/specialty/labor_arbitration/knowledge').send({
      file_ref: 'inline:正文',
      source_type: 'official',
    });
    expect(noLicense.status).toBe(400);
    expect(noLicense.body.code).toBe('E_BAD_FORMAT');

    const badRef = await adminPost('/admin/specialty/labor_arbitration/knowledge').send({
      file_ref: 's3://bucket/x.pdf',
      source_type: 'official',
      license_status: 'granted',
    });
    expect(badRef.status).toBe(400);
    expect(badRef.body.code).toBe('E_BAD_FORMAT');

    const unsupported = await adminPost('/admin/specialty/trade/knowledge').send({
      file_ref: 'inline:正文',
      source_type: 'official',
      license_status: 'granted',
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('E_SPECIALTY_UNSUPPORTED');

    // 缺省标题派生：正文首行截 64 码点
    const doc = await pool.query<{ title: string }>(
      `SELECT title FROM agent_assist.knowledge_docs WHERE id = $1`,
      [ok.body.doc_id],
    );
    expect(doc.rows[0]!.title).toBe(DOC_B.slice(0, 64));
  });

  it('G-A 精神同款机械接线（评审 Important-1）：未认证 401 / 未持 admin 旗标 403 / admin 201（守卫放行入队）', async () => {
    const body = {
      file_ref: `inline:${DOC_B}`,
      source_type: 'official',
      license_status: 'granted',
    };
    const anon = await request(app.getHttpServer())
      .post('/admin/specialty/labor_arbitration/knowledge')
      .send(body);
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('E_UNAUTHORIZED');

    const asUser = await request(app.getHttpServer())
      .post('/admin/specialty/labor_arbitration/knowledge')
      .set('Authorization', `Bearer ${userToken}`)
      .send(body);
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe('E_ROLE_FORBIDDEN');

    const ok = await adminPost('/admin/specialty/labor_arbitration/knowledge').send(body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ created: true, process_status: 'PENDING' });
    await svc.waitIngestIdle();
  });
});
