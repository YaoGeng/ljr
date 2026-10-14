/**
 * E3 知识库类型契约（施工规格 docs/modules/E-AI辅助/E3-专项配置与知识库.md §3/§4/§5/§8）。
 *
 * 领域模型（§3）：knowledge_docs(source_type/license_status/file_ref) + knowledge_chunks
 * (chunk/embedding/metadata)。枚举与状态：
 *   source_type   = official|firm_authorized|anonymized（§2 三类知识来源）
 *   license_status= granted|pending|revoked（R-02 授权状态登记三态；仅 granted 入检索池——
 *                   §9「未登记授权状态的语料入检索池」禁令的执行面；缺失/非法=400 无法入库）
 *   process_status= PENDING|READY|FAILED（§8 异步向量化状态位，V9 追加列；检索池只取 READY）
 *   active        = 文档禁用位（§4「文档禁用即检索过滤」，V9 追加列）
 *
 * 检索内部 API（§5「E1 调用，top_k=8，cosine」——Task 7 E1 消费，最终签名随任务报告交付）：
 *   KnowledgeService.retrieve({specialty, query, topK?}) → KnowledgeHit[]
 */

export const SOURCE_TYPES = ['official', 'firm_authorized', 'anonymized'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const LICENSE_STATUSES = ['granted', 'pending', 'revoked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** 入检索池的唯一授权状态（R-02/§9：pending/revoked 登记在册但被检索过滤） */
export const RETRIEVABLE_LICENSE_STATUS: LicenseStatus = 'granted';

export const PROCESS_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

/** knowledge_docs 行视图（机制/管理面） */
export interface KnowledgeDocView {
  readonly id: number;
  readonly specialty: string;
  readonly title: string;
  readonly sourceType: SourceType;
  readonly licenseStatus: LicenseStatus;
  readonly processStatus: ProcessStatus;
  readonly active: boolean;
  readonly fileHash: string;
  readonly createdAt: Date;
}

/** POST /admin/specialty/{key}/knowledge 出参（§5 {doc_id} 逐字 + additive 幂等/状态字段） */
export interface UploadKnowledgeDocResult {
  readonly doc_id: number;
  /** true=新建；false=同 file_hash 幂等回读（§5 幂等键=file_hash） */
  readonly created: boolean;
  readonly process_status: ProcessStatus;
}

/** 检索命中（§5 检索内部 API 出参形态：{chunk, score, doc 元数据}） */
export interface KnowledgeHit {
  /** 分块正文 */
  readonly chunk: string;
  /** cosine 相似度 [-1,1]，降序（同分按 docId,chunkIndex 稳定序） */
  readonly score: number;
  readonly docId: number;
  readonly docTitle: string;
  readonly sourceType: SourceType;
  readonly chunkIndex: number;
  readonly metadata: Record<string, unknown>;
}

export interface RetrieveKnowledgeInput {
  readonly specialty: string;
  readonly query: string;
  /** 缺省 8（§5 top_k=8）；正整数 */
  readonly topK?: number;
}
