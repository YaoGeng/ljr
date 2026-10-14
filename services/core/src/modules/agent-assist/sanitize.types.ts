/**
 * E1 实时脱敏层——类型契约（施工规格 docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md
 * §4「脱敏层」、§7 R-02、§10 验收①；本批次=实时脱敏切片，管线其余段属 M2-W3）。
 *
 * R-02 铁律的类型表达：PlaceholderBinding.value（占位符→原文映射，仅供律师端气泡还原显示）
 * 与 SanitizePureResult.sanitized（进 RAG/LLM 的唯一合法载荷）是两个互斥结构——hits 只带
 * 类型/占位符/码点偏移，不带原文；测试断言两者分离（sanitize.rules.spec / sanitize.spec）。
 *
 * 最终 API 签名（M2 草稿管线消费，随任务报告交付）：
 *   SanitizeService.sanitize({ text, persistAudit? }) → Promise<SanitizeResult>
 *   纯引擎（同训练管线同源复用锚点）：sanitizeText(text) → SanitizePureResult（无 IO/确定性）
 */

/** PII 类型（控制者裁决口径：中国大陆五类，正则先行；NER 模型 M2 标 ⚠ 追加） */
export const PII_TYPES = ['name', 'id_card', 'phone', 'address', 'bank_card'] as const;
export type PiiType = (typeof PII_TYPES)[number];

/** PII 类型 → 占位符显示词（sanitized 文本中以 [显示词] 形态出现；第 k 次(k≥2)命中=[显示词k]） */
export const PLACEHOLDER_LABELS: Readonly<Record<PiiType, string>> = {
  name: '姓名',
  id_card: '证件号',
  phone: '电话',
  address: '地址',
  bank_card: '银行卡',
};

/** 单条命中（不含原文；偏移=原文 Unicode 码点偏移，与 knowledge_chunks.metadata 同口径） */
export interface PiiHit {
  readonly type: PiiType;
  /** 该命中在 sanitized 文本中的占位符记号（含方括号，如 '[电话2]'，可字面检索） */
  readonly placeholder: string;
  /** 原文码点区间 [start, end) */
  readonly start: number;
  readonly end: number;
}

/** 占位符→原文映射（仅供律师端还原展示；禁入 RAG/LLM 载荷——R-02 铁律） */
export interface PlaceholderBinding {
  /** 含方括号的占位符记号（与 PiiHit.placeholder 一致，如 '[证件号]'） */
  readonly token: string;
  readonly type: PiiType;
  /** 原文片段（原文在出参中的唯一出现位） */
  readonly value: string;
}

/** 纯引擎出参（同输入同输出；零 IO） */
export interface SanitizePureResult {
  /** 脱敏后文本——唯一可进 RAG/LLM 的载荷（E1 §4 管线第一段产物） */
  readonly sanitized: string;
  /** 占位符→原文映射（律师端还原用；与 sanitized 结构分离） */
  readonly placeholders: readonly PlaceholderBinding[];
  /** 命中明细（按原文出现顺序；类型/占位符/码点偏移，无原文） */
  readonly hits: readonly PiiHit[];
  /** 命中时所依据的规则集版本（=SANITIZE_RULESET_VERSION，审计锚点） */
  readonly ruleVersion: string;
}

/** SanitizeService 出参（= 纯出参 + 耗时打点 + 审计行定位；§8 各段打点） */
export interface SanitizeResult extends SanitizePureResult {
  /** 本次脱敏耗时（毫秒，整数 ≥0；只含脱敏本体，不含审计写） */
  readonly durationMs: number;
  /** 命中审计行 id；无命中或 persistAudit:false → null */
  readonly auditId: number | null;
}

export interface SanitizeInput {
  readonly text: string;
  /** 命中时是否落 sanitize_audit（缺省 true；审计行仅存哈希/类型/耗时，无原文明文） */
  readonly persistAudit?: boolean;
}

/** sanitize_audit 行视图（agent_assist.sanitize_audit，V10；抽检断言的事实源） */
export interface SanitizeAuditView {
  readonly id: number;
  readonly ruleVersion: string;
  /** sha256 hex（原文）——原文不落明文 */
  readonly inputDigest: string;
  /** sha256 hex（脱敏后文本） */
  readonly outputDigest: string;
  /** 按类型命中计数（不含命中值） */
  readonly hitTypes: readonly { readonly type: PiiType; readonly count: number }[];
  readonly durationMs: number;
  readonly createdAt: Date;
}
