/**
 * E3 知识库服务（机制核心）：文档上传（§5 幂等键=file_hash）→ 分块（§4，knowledge.chunker）→
 * 向量化（mock 供应商 ⚠，knowledge.embedding）→ 入库（异步，knowledge.ingest 同进程队列）→
 * 检索内部 API（§5「E1 调用，top_k=8，cosine」——Task 7 E1 消费）。
 *
 * 授权门（R-02/§9）：license_status 三态枚举校验（缺失/非法=400 无法入库，§10 验收④）；
 * 检索池过滤=active AND process_status='READY' AND license_status='granted'——pending/revoked
 * 登记在册（正常处理）但不入池。禁用（§4「文档禁用即检索过滤」）走 setDocActive（机制面；
 * 管理 REST M2 接线 ⚠），禁用/恢复同事务出 KnowledgeUpdated（§6 →E1 缓存失效）。
 *
 * R4 双路径（V9 头注）：写入/检索按 embedding 列型分派（information_schema 内省一次缓存）——
 * vector 列型=pgvector SQL 侧 `<=>`；jsonb=进程内余弦（本仓 dev 现状，真 pgvector 随 docker ⚠）。
 * 两路径出参契约（KnowledgeHit）完全一致。
 *
 * ⚠M2 后置位：FAILED 文档的 requeue/重处理（当前重传同文=幂等回读 FAILED 行，不自动重试；
 * 处理器注册表随 I3/解析器批次落位）；pdf/docx 解析与 i3:// 引用（file_ref 仅 inline: 形态，
 * 未知形态 400 拒收）；管理面文档列表/删除 REST。
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { PgPoolService } from '../../infrastructure/sql';
import { TRACE_LOGGER } from '../../observability/observability.module';
import type { TraceLogger } from '../../observability/trace-logger';
import { KNOWLEDGE_CONFIG, type KnowledgeConfig } from './knowledge.config';
import { chunkText } from './knowledge.chunker';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './knowledge.embedding';
import {
  KNOWLEDGE_UPDATED_TOPIC,
  type KnowledgeChangeReason,
  type KnowledgeUpdatedPayload,
} from './knowledge.events';
import { IngestQueue } from './knowledge.ingest';
import {
  buildJsonbSearchSql,
  buildVectorSearchSql,
  cosineSimilarity,
  detectEmbeddingColumnMode,
  embeddingParam,
  type EmbeddingColumnMode,
} from './knowledge.vector';
import type {
  KnowledgeDocView,
  KnowledgeHit,
  ProcessStatus,
  RetrieveKnowledgeInput,
  SourceType,
  UploadKnowledgeDocResult,
} from './knowledge.types';
import {
  assertDocTitle,
  assertLicenseStatus,
  assertSourceType,
  assertSupportedSpecialty,
  deriveTitle,
  parseInlineFileRef,
} from './specialty.validate';

const DOC_COLUMNS =
  'id, specialty, title, source_type, license_status, process_status, active, file_hash, created_at';

interface KnowledgeDocRow {
  readonly id: string;
  readonly specialty: string;
  readonly title: string;
  readonly source_type: string;
  readonly license_status: string;
  readonly process_status: string;
  readonly active: boolean;
  readonly file_hash: string;
  readonly created_at: Date;
}

interface ChunkSearchRow {
  readonly id: string;
  readonly doc_id: string;
  readonly chunk: string;
  readonly metadata: Record<string, unknown>;
  readonly title: string;
  readonly source_type: string;
  readonly embedding?: unknown;
  readonly score?: string | number;
}

function toDocView(row: KnowledgeDocRow): KnowledgeDocView {
  return {
    id: Number(row.id),
    specialty: row.specialty,
    title: row.title,
    sourceType: row.source_type as SourceType,
    licenseStatus: row.license_status as KnowledgeDocView['licenseStatus'],
    processStatus: row.process_status as ProcessStatus,
    active: row.active,
    fileHash: row.file_hash,
    createdAt: new Date(row.created_at),
  };
}

@Injectable()
export class KnowledgeService implements OnApplicationShutdown {
  private readonly queue: IngestQueue;
  /** 列型探测缓存（列型只在迁移时变化；探测失败不缓存，修复后下次调用自愈） */
  private modePromise?: Promise<EmbeddingColumnMode>;

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    @Inject(KNOWLEDGE_CONFIG) private readonly config: KnowledgeConfig,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    // FAILED 的运维侧 warn（状态位是事实源；logger 为增益，测试注桩/可缺省）
    @Inject(TRACE_LOGGER) private readonly logger: TraceLogger,
  ) {
    // 队列惰性驱动：首条 enqueue 即 setImmediate，无需常驻轮询（§8 异步语义的最小形态）
    this.queue = new IngestQueue((docId) => this.processDocument(docId));
  }

  /** 测试/观测：等待在队文档全部到达终态（READY|FAILED）——§8 ≤5min 的可观测完成口（非 sleep） */
  waitIngestIdle(): Promise<void> {
    return this.queue.waitIdle();
  }

  onApplicationShutdown(): void {
    this.queue.onApplicationShutdown();
  }

  // ---------- 上传（§5 POST /admin/specialty/{key}/knowledge，幂等键=file_hash） ----------

  /**
   * 文档登记（PENDING）+ 异步向量化入队。授权门（R-02）：source_type/license_status 枚举校验
   * （违例=400 E_BAD_FORMAT，零落库）；file_ref 仅 inline: 形态（W1，M2 接解析器 ⚠）。
   * 幂等：UNIQUE(specialty, file_hash)——重传同文回读首行 created:false（不重复入队）；已
   * READY/FAILED 的行亦原样回读（重处理=M2 requeue 位，见类注）。
   */
  async uploadDocument(input: {
    readonly specialty: string;
    readonly title?: string;
    readonly fileRef: unknown;
    readonly sourceType: unknown;
    readonly licenseStatus: unknown;
  }): Promise<UploadKnowledgeDocResult> {
    assertSupportedSpecialty(input.specialty);
    assertSourceType(input.sourceType);
    assertLicenseStatus(input.licenseStatus);
    const text = parseInlineFileRef(input.fileRef, {
      maxChars: this.config.maxInlineChars,
      mode: 'upload',
    });
    let title: string;
    if (input.title === undefined) {
      title = deriveTitle(text);
    } else {
      assertDocTitle(input.title);
      title = input.title.trim();
    }
    const fileHash = createHash('sha256').update(text, 'utf8').digest('hex');
    const { row, created } = await this.pool.withTransaction(async (uow) => {
      // ON CONFLICT DO NOTHING（非裸 23505）：幂等重放走干净回读路径，不打 aborted
      const inserted = await uow.query<KnowledgeDocRow>(
        `INSERT INTO agent_assist.knowledge_docs
           (specialty, title, source_type, license_status, file_ref, file_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (specialty, file_hash) DO NOTHING
         RETURNING ${DOC_COLUMNS}`,
        [input.specialty, title, input.sourceType, input.licenseStatus, input.fileRef, fileHash],
      );
      const row = inserted.rows[0];
      if (row) return { row, created: true };
      const existing = await uow.query<KnowledgeDocRow>(
        `SELECT ${DOC_COLUMNS} FROM agent_assist.knowledge_docs WHERE specialty = $1 AND file_hash = $2`,
        [input.specialty, fileHash],
      );
      const found = existing.rows[0];
      if (!found) {
        throw new AppError(ErrorCode.InternalError, '文档冲突后回读不可见（不变量破坏）');
      }
      return { row: found, created: false };
    });
    if (created) {
      this.queue.enqueue(Number(row.id)); // §8 异步：向量化不占上传应答；状态位/事件见 processDocument
    }
    return {
      doc_id: Number(row.id),
      created,
      process_status: row.process_status as ProcessStatus,
    };
  }

  // ---------- 禁用/恢复（§4「文档禁用即检索过滤」；机制面，管理 REST M2 接线 ⚠） ----------

  /**
   * 置 active：禁用即检索池排除（§10 验收③）；幂等短路（同值重放不出事件）；状态变化与
   * KnowledgeUpdated{reason:disabled|enabled} 同事务（§6 →E1 缓存失效）。
   */
  async setDocActive(docId: number, active: boolean): Promise<KnowledgeDocView> {
    if (!Number.isSafeInteger(docId) || docId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `docId 须为正整数：${String(docId)}`);
    }
    return this.pool.withTransaction(async (uow) => {
      const res = await uow.query<KnowledgeDocRow>(
        `SELECT ${DOC_COLUMNS} FROM agent_assist.knowledge_docs WHERE id = $1 FOR UPDATE`,
        [docId],
      );
      const row = res.rows[0];
      if (!row) {
        throw new AppError(ErrorCode.NotFound, `文档不存在：${String(docId)}`);
      }
      if (row.active === active) return toDocView(row);
      await uow.query(`UPDATE agent_assist.knowledge_docs SET active = $2 WHERE id = $1`, [
        docId,
        active,
      ]);
      const reason: KnowledgeChangeReason = active ? 'enabled' : 'disabled';
      await this.outbox.recordOutbox(uow, {
        type: KNOWLEDGE_UPDATED_TOPIC,
        payload: {
          specialty: row.specialty,
          doc_id: docId,
          reason,
        } satisfies KnowledgeUpdatedPayload,
      });
      return toDocView({ ...row, active });
    });
  }

  /** 文档视图（机制面；管理列表 REST M2 接线 ⚠） */
  async getDoc(docId: number): Promise<KnowledgeDocView> {
    if (!Number.isSafeInteger(docId) || docId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `docId 须为正整数：${String(docId)}`);
    }
    const res = await this.pool.query<KnowledgeDocRow>(
      `SELECT ${DOC_COLUMNS} FROM agent_assist.knowledge_docs WHERE id = $1`,
      [docId],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.NotFound, `文档不存在：${String(docId)}`);
    return toDocView(row);
  }

  // ---------- 检索内部 API（§5「E1 调用，top_k=8，cosine」；Task 7 E1 消费，签名随报告） ----------

  /**
   * 知识检索：query 向量化后在检索池（在册专项 + active + READY + granted，R-02/§9 授权门）
   * 内按 cosine 相似度取 top_k（缺省 8）。R4 双路径分派（vector=SQL 侧 <=> / jsonb=进程内
   * 余弦），出参一致；jsonb 路径同分 tie-break=(score desc, docId, chunkId) 确定性。
   */
  async retrieve(input: RetrieveKnowledgeInput): Promise<KnowledgeHit[]> {
    assertSupportedSpecialty(input.specialty);
    if (typeof input.query !== 'string' || input.query.trim().length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, `query 须为非空字符串`);
    }
    const topK = input.topK ?? this.config.retrievalTopK;
    if (!Number.isSafeInteger(topK) || topK < 1) {
      throw new AppError(ErrorCode.InvalidArgument, `topK 须为正整数：${String(input.topK)}`);
    }
    const queryText = [...input.query.trim()].slice(0, this.config.maxQueryCodepoints).join('');
    const queryVec = (await this.embedAll([queryText]))[0]!;
    const mode = await this.embeddingMode();
    if (mode === 'vector') {
      const param = embeddingParam('vector', queryVec);
      const res = await this.pool.query<ChunkSearchRow>(buildVectorSearchSql(), [
        input.specialty,
        param.text,
        topK,
      ]);
      return res.rows.map((r) => this.toHit(r, Number(r.score)));
    }
    const res = await this.pool.query<ChunkSearchRow>(buildJsonbSearchSql(), [input.specialty]);
    const ranked = res.rows.map((row) => {
      const vec = row.embedding;
      if (!Array.isArray(vec)) {
        throw new AppError(
          ErrorCode.InternalError,
          `分块向量脏数据（非数组；只能经 ingest 写入）：doc ${row.doc_id}`,
        );
      }
      return { row, score: cosineSimilarity(queryVec, vec as number[]) };
    });
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.row.doc_id) - Number(b.row.doc_id) ||
        Number(a.row.id) - Number(b.row.id),
    );
    return ranked.slice(0, topK).map((h) => this.toHit(h.row, h.score));
  }

  // ---------- 内部件：向量化处理（ingest 队列处理器） ----------

  /**
   * 单文档处理（PENDING→READY，终态幂等）：行锁下重验状态 → 解析 inline 正文 → 分块 →
   * 向量 → 分块行+READY+KnowledgeUpdated 同事务（业务失败则全回滚，状态位保持 PENDING 由
   * catch 置 FAILED）；FAILED 不出事件（检索池未变化）。
   */
  private async processDocument(docId: number): Promise<void> {
    try {
      await this.pool.withTransaction(async (uow) => {
        const res = await uow.query<KnowledgeDocRow & { file_ref: string }>(
          `SELECT ${DOC_COLUMNS}, file_ref FROM agent_assist.knowledge_docs WHERE id = $1 FOR UPDATE`,
          [docId],
        );
        const row = res.rows[0];
        if (!row || row.process_status !== 'PENDING') return; // 幂等：消失/已处理（重放入队）
        const text = parseInlineFileRef(row.file_ref, {
          maxChars: this.config.maxInlineChars,
          mode: 'stored',
        });
        const chunks = chunkText(text, {
          chunkTokens: this.config.chunkTokenSize,
          overlapTokens: this.config.chunkOverlapTokens,
        });
        if (chunks.length > this.config.maxChunksPerDoc) {
          throw new AppError(
            ErrorCode.KnowledgeBadFormat,
            `分块数超限（${chunks.length} > ${this.config.maxChunksPerDoc}）`,
          );
        }
        const vectors = await this.embedAll(chunks.map((c) => c.text));
        const mode = await this.embeddingMode();
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const param = embeddingParam(mode, vectors[i]!);
          await uow.query(
            `INSERT INTO agent_assist.knowledge_chunks (doc_id, chunk, embedding, metadata)
             VALUES ($1, $2, $3::${param.cast}, $4::jsonb)`,
            [
              docId,
              chunk.text,
              param.text,
              JSON.stringify({
                chunk_index: chunk.index,
                char_start: chunk.charStart,
                char_end: chunk.charEnd,
              }),
            ],
          );
        }
        await uow.query(
          `UPDATE agent_assist.knowledge_docs SET process_status = 'READY'
           WHERE id = $1 AND process_status = 'PENDING'`,
          [docId],
        );
        await this.outbox.recordOutbox(uow, {
          type: KNOWLEDGE_UPDATED_TOPIC,
          payload: {
            specialty: row.specialty,
            doc_id: docId,
            reason: 'ready',
          } satisfies KnowledgeUpdatedPayload,
        });
      });
    } catch (e) {
      // 独立事务落 FAILED（业务事务已回滚）；失败不留痕即 PENDING 悬挂，运维不可见
      await this.pool
        .query(
          `UPDATE agent_assist.knowledge_docs SET process_status = 'FAILED'
           WHERE id = $1 AND process_status = 'PENDING'`,
          [docId],
        )
        .catch(() => undefined);
      this.logger?.warn('知识库向量化失败（文档置 FAILED，不入检索池）', {
        doc_id: docId,
        error: String(e),
      });
    }
  }

  /** 批量向量化 + 维度守卫（供应商维度漂移=InternalError 显性化，不静默入库失配向量） */
  private async embedAll(texts: readonly string[]): Promise<number[][]> {
    const vectors = await this.provider.embed(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new AppError(ErrorCode.InternalError, 'embedding 供应商出参与入参数量不一致');
    }
    for (const v of vectors) {
      if (!Array.isArray(v) || v.length !== this.config.embeddingDim) {
        throw new AppError(
          ErrorCode.InternalError,
          `embedding 维度漂移（${Array.isArray(v) ? v.length : typeof v} ≠ 配置 ${this.config.embeddingDim}）`,
        );
      }
    }
    return vectors as number[][];
  }

  private async embeddingMode(): Promise<EmbeddingColumnMode> {
    // 失败不缓存（rejected promise 会永久毒化缓存）：修复迁移后下次调用自愈
    if (this.modePromise === undefined) {
      this.modePromise = detectEmbeddingColumnMode(this.pool).catch((e: unknown) => {
        this.modePromise = undefined;
        throw e;
      });
    }
    return this.modePromise;
  }

  private toHit(row: ChunkSearchRow, score: number): KnowledgeHit {
    const metadata = row.metadata ?? {};
    const chunkIndex = metadata['chunk_index'];
    return {
      chunk: row.chunk,
      score,
      docId: Number(row.doc_id),
      docTitle: row.title,
      sourceType: row.source_type as SourceType,
      chunkIndex: typeof chunkIndex === 'number' ? chunkIndex : -1,
      metadata,
    };
  }
}
