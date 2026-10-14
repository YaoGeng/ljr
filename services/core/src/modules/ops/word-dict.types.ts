/**
 * H5 风控与敏感词管理——W1 词库切片类型契约（施工规格 docs/modules/H-运营后台/H5-风控与敏感词管理.md
 * §2/§3/§5/§6）。
 *
 * R14 裁决落地形态（控制者裁决，论证见任务报告）：**词库正文的版本化唯一事实源 = ops.rule_definitions
 * （H7 机制，rule_key=wordlist.<dict_type>，经 createLexiconVersion 免公示通道写入）**；不建
 * sensitive_words 物化展开表——判定引擎把当前生效版本 content 加载进进程内 AC 自动机（版本号比对
 * 驱动重建）；ops.risk_records 照 §3 照建（REVIEW 命中落记录，人审队列/处置 REST 后置 M2-W2）。
 *
 * 消费方：D5（M2 消息链路调 CHECK_RISK 同步判定）、E1（Task 7 敏感话术硬拦取 BLOCK 词集，
 * currentBlockWords）。
 */

/** 双词库（§2）：illegal_content=涉政/色情/暴恐/诈骗；legal_industry=承诺结果/包赢/私下交易/加微信/个人收款 */
export const DICT_TYPES = ['illegal_content', 'legal_industry'] as const;
export type DictType = (typeof DICT_TYPES)[number];

/** 词级处置三级（§2）：BLOCK→同步拦截；REVIEW→放行+risk_records 记录（人审队列 M2）；MARK→放行+标记 */
export const WORD_ACTIONS = ['BLOCK', 'REVIEW', 'MARK'] as const;
export type WordAction = (typeof WORD_ACTIONS)[number];

/** 严重度序（多词命中聚合取最高；值越大越严重） */
export const WORD_ACTION_SEVERITY: Readonly<Record<WordAction, number>> = {
  BLOCK: 3,
  REVIEW: 2,
  MARK: 1,
};

/** 无命中时的聚合结果（§5 出参 {action, hits} 的空集语义；报告「content jsonb 结构」节明示） */
export type RiskAction = WordAction | 'PASS';

/** H5 词库占用的 H7 rule_key 前缀（V7 迁移注释预留：wordlist.*） */
export const WORDLIST_KEY_PREFIX = 'wordlist';

/** dict_type → H7 rule_key（wordlist.illegal_content / wordlist.legal_industry，均 ≤32 位） */
export function wordlistRuleKey(dictType: DictType): string {
  return `${WORDLIST_KEY_PREFIX}.${dictType}`;
}

/** 类型收窄守卫（REST 入参/事件消费校验用） */
export function isDictType(value: string): value is DictType {
  return (DICT_TYPES as readonly string[]).includes(value);
}

export function isWordAction(value: string): value is WordAction {
  return (WORD_ACTIONS as readonly string[]).includes(value);
}

// ---------- 词库 content jsonb 结构（H5 定义，存于 ops.rule_definitions.content；报告明示） ----------

/**
 * rule_key=wordlist.<dict_type> 的 content jsonb 结构：
 *   { "words": [{ "word": string(规范化小写, 1..64), "action": "BLOCK"|"REVIEW"|"MARK" }, ...] }
 * 约定（写入端 putDictionary 保证，读取端 parseLexiconContent 防御）：
 *   - word 统一小写规范形（匹配大小写不敏感；重复词按规范形判定 → 400 E_DUP_WORD）；
 *   - words 按 word 升序排序存储（词库是集合语义：与提交顺序无关，幂等重放的全等判定因此确定）；
 *   - 空 words 合法（=清空词库的版本）。
 * dict_type 不入 content：rule_key 本身编码词库（单库一 key，独立版本线/独立热更新）。
 */
export interface LexiconWordEntry {
  readonly word: string;
  readonly action: WordAction;
}

/**
 * type alias（非 interface）：须可赋值给 Record<string, unknown>（H7 content 入参/类型谓词），
 * TS 仅对 type alias 的对象字面量类型给隐式索引签名。
 */
export type LexiconContent = {
  readonly words: readonly LexiconWordEntry[];
};

// ---------- 管理面（§5 GET/PUT /admin/risk/dictionaries，幂等键=dict+base_version） ----------

export interface PutDictionaryInput {
  readonly dictType: DictType;
  /** 调用方所见的当前版本号（0=尚无版本）；写入版本恒=base_version+1（乐观并发，过期基数 409） */
  readonly baseVersion: number;
  readonly words: readonly { readonly word: string; readonly action: WordAction }[];
}

export interface PutDictionaryResult {
  readonly dictType: DictType;
  readonly ruleKey: string;
  /** 本次写入（或重放命中）的版本号 */
  readonly version: number;
  readonly effectiveAt: Date;
  readonly wordCount: number;
  /** true=新建版本；false=同 dict+base_version 重放（内容全等）幂等回读既有版本（§5 幂等键语义） */
  readonly created: boolean;
}

/** GET /admin/risk/dictionaries 出参：词库当前生效版本视图（无版本时 version=0、words=[]） */
export interface DictionaryView {
  readonly dictType: DictType;
  readonly ruleKey: string;
  readonly version: number;
  /** 当前生效版本的生效时刻；version=0（尚无版本）时为 null */
  readonly effectiveAt: Date | null;
  readonly words: readonly LexiconWordEntry[];
}

// ---------- 同步判定（§5 CHECK_RISK 内部 API，无 HTTP；D5 发送路径消费） ----------

export interface CheckRiskInput {
  /** 会话上下文（可选 ⚠：D5 M2 接入时若会话主键非数值形态须迁移 risk_records.conversation_id 列型） */
  readonly conversationId?: number;
  readonly content: string;
}

/** 单词命中（hits 去重：同词多次出现只报一次；跨词库同词各自成条） */
export interface RiskHit {
  readonly word: string;
  readonly action: WordAction;
  readonly dictType: DictType;
}

export interface CheckRiskResult {
  /** 聚合处置=命中里最高 severity（多词命中取最高）；无命中=PASS */
  readonly action: RiskAction;
  readonly hits: readonly RiskHit[];
}

/** ops.risk_records 行视图（§3；W1 只落 action='REVIEW' 行，人审字段由 M2 回填） */
export interface RiskRecordView {
  readonly id: number;
  readonly messageId: number | null;
  readonly conversationId: number | null;
  readonly dictType: DictType;
  /** [{word, action, rule_version}]——该库 REVIEW 命中集 + 命中时词库版本（审计锚点） */
  readonly wordHits: readonly Record<string, unknown>[];
  readonly action: WordAction;
  readonly reviewedBy: number | null;
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
}
