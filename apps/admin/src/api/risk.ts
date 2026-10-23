/**
 * H5 风控与敏感词数据面（M3-W3 T4）：人审队列/处置 + 词库管理四端点。
 *
 * 出入参类型为 services/core 实码契约副本（admin 不依赖 core/shared 包——T1 口径，
 * 消费侧出参类型上移 @ljr/shared=独立卡）：每类型头注标注来源文件，core 改口径时本文件
 * 随之同步。词汇纪律：dict_type 两值/action 三值/verdict 三值/请求体键名逐字对照 core 实码，
 * 禁发明字段（队列行无用户原文/姓名/手机号字段=PII 红线——word_hits 只有命中词，如实展示）。
 *
 * 幂等口径（H5 §5 + core 实码）：
 *   - 处置幂等键=record：已处置 409 E_CONFLICT（DONE）不翻案、不再审计——横幅+刷新承载；
 *   - 词库提交幂等键=dict+base_version：同键内容全等重放 → created:false 幂等回读既有版本；
 *     base_version 过期/超前 → 409 E_CONFLICT（乐观并发，重取后重试）；词库内重复词（大小写
 *     不敏感）→ 400 E_DUP_WORD（本地防呆+服务端兜底双层）。
 */
import { apiFetch } from './client';

// ---------------------------------------------------------------------------
// 契约类型副本（对照来源逐字段抄，禁发明）
// ---------------------------------------------------------------------------

/** 双词库（core ops/word-dict.types.ts DICT_TYPES 实码序；H5 §2） */
export type DictType = 'illegal_content' | 'legal_industry';

export const DICT_TYPE_VALUES: readonly DictType[] = ['illegal_content', 'legal_industry'];

/** 词级处置三级（core ops/word-dict.types.ts WORD_ACTIONS 实码序；BLOCK>REVIEW>MARK severity） */
export type WordAction = 'BLOCK' | 'REVIEW' | 'MARK';

export const WORD_ACTION_VALUES: readonly WordAction[] = ['BLOCK', 'REVIEW', 'MARK'];

/** 人审处置结论三值（core ops/risk-review.types.ts REVIEW_VERDICTS 实码序；V45 ck 同源） */
export type ReviewVerdict = 'CONFIRM_BLOCK' | 'FALSE_POSITIVE' | 'MARK_ONLY';

export const REVIEW_VERDICT_VALUES: readonly ReviewVerdict[] = [
  'CONFIRM_BLOCK',
  'FALSE_POSITIVE',
  'MARK_ONLY',
];

/** 处置备注上限（core risk-review.types.ts REVIEW_NOTE_MAX=500 同源；不静默截断） */
export const REVIEW_NOTE_MAX = 500;

/** 词条长度上限（core word-dict.validate.ts WORD_MAX_LEN=64 同源：trim 后 1..64） */
export const WORD_MAX_LEN = 64;

/** 单版本词数上限（core word-dict.validate.ts WORDS_MAX_COUNT 同源；批量导入=M2 后置机制） */
export const WORDS_MAX_COUNT = 10_000;

/** 待审队列行（core ops/risk-review.types.ts RiskQueueItem；word_hits 形态=V8
 *  [{word, action, rule_version}]——命中词+判定时词库版本审计锚，无用户原文字段） */
export interface RiskQueueItem {
  readonly id: number;
  readonly message_id: number | null;
  readonly conversation_id: number | null;
  readonly dict_type: DictType;
  readonly word_hits: readonly Record<string, unknown>[];
  readonly action: WordAction;
  readonly created_at: string;
}

/** 处置出参（core risk-review.types.ts RiskReviewResult——行内回填事实，reviewed_at=DB 钟） */
export interface RiskReviewResult {
  readonly record_id: number;
  readonly verdict: ReviewVerdict;
  readonly reviewed_by: number;
  readonly reviewed_at: string;
}

/** 词库词条（core word-dict.types.ts LexiconWordEntry：word=小写规范形 trim+lowercase） */
export interface LexiconWordEntry {
  readonly word: string;
  readonly action: WordAction;
}

/** 词库当前生效版本视图（core word-dict.types.ts DictionaryView；effectiveAt core=Date|null，
 *  HTTP JSON 序列化后=ISO 串——本副本按线上形态收窄 string|null；无版本库 version=0/words=[]） */
export interface DictionaryView {
  readonly dictType: DictType;
  readonly ruleKey: string;
  readonly version: number;
  readonly effectiveAt: string | null;
  readonly words: readonly LexiconWordEntry[];
}

/** 词库提交出参（core word-dict.types.ts PutDictionaryResult；effectiveAt 同上 JSON 形态；
 *  created=false=同 dict+base_version 内容全等幂等回读既有版本） */
export interface PutDictionaryResult {
  readonly dictType: DictType;
  readonly ruleKey: string;
  readonly version: number;
  readonly effectiveAt: string;
  readonly wordCount: number;
  readonly created: boolean;
}

/** PUT /admin/risk/dictionaries 请求体（core word-dict.http.ts parsePutDictionaryBody 形状；
 *  键 snake_case；base_version=调用方所见当前版本号，0=尚无版本） */
export interface PutDictionaryBody {
  readonly dict_type: DictType;
  readonly base_version: number;
  readonly words: readonly { readonly word: string; readonly action: WordAction }[];
}

// ---------------------------------------------------------------------------
// 展示映射表（文案单源，禁组件散写三元）
// ---------------------------------------------------------------------------

/** 词库类型 → 中文（H5 §2 双词库语义；chip 筛选/词库管理段共用单表） */
export const DICT_TYPE_LABELS: Readonly<Record<DictType, string>> = {
  illegal_content: '违法信息类型',
  legal_industry: '行业违规话术',
};

/** 词级 action → 中文（core WORD_ACTIONS 值域；BLOCK=同步拦截/REVIEW=放行+入队/MARK=放行+标记） */
export const WORD_ACTION_LABELS: Readonly<Record<WordAction, string>> = {
  BLOCK: '拦截',
  REVIEW: '转人审',
  MARK: '标记',
};

/** 人审结论 → 中文（§4 处置三分支；CONFIRM_BLOCK=危险值（对照原型「拦截」按钮红位）→二段确认；
 *  note 逐字对照 core 服务层 V1 副作用边界——不发明补拦截/通知真发语义） */
export const REVIEW_VERDICT_LABELS: Readonly<
  Record<ReviewVerdict, { label: string; note: string; danger: boolean }>
> = {
  CONFIRM_BLOCK: {
    label: '确认拦截',
    note: '机审放行有误：确认该命中应拦截（V1=风险记录置确认态+审计；消息本体不改=D5 撤回面边界）',
    danger: true,
  },
  FALSE_POSITIVE: {
    label: '误拦放行',
    note: '命中判定有误：标记误拦（V1 通知位=直发桩，user 锚点缺失暂不真发——D5 补关联后启用）',
    danger: false,
  },
  MARK_ONLY: {
    label: '仅标记',
    note: '纯记录处置（零副作用），不改判定结论',
    danger: false,
  },
};

/** word_hits 展示条目（jsonb 防御性解析：word=String 化、rule_version 非法数值置 null） */
export interface WordHitEntry {
  readonly word: string;
  readonly action: string;
  readonly rule_version: number | null;
}

/** word_hits jsonb → 展示条目（V8 形态 [{word, action, rule_version}]；只读展示不回传服务端） */
export function parseWordHits(hits: readonly Record<string, unknown>[]): readonly WordHitEntry[] {
  return hits.map((h) => {
    const rv = h['rule_version'];
    return {
      word: typeof h['word'] === 'string' ? h['word'] : JSON.stringify(h['word'] ?? null),
      action: typeof h['action'] === 'string' ? h['action'] : String(h['action'] ?? ''),
      rule_version:
        typeof rv === 'number' && Number.isSafeInteger(rv) && rv >= 0
          ? rv
          : typeof rv === 'string' && /^\d+$/.test(rv)
            ? Number.parseInt(rv, 10)
            : null,
    };
  });
}

// ---------------------------------------------------------------------------
// 纯函数（表单防呆 + 请求体构造 + 词集 diff，bun test 直测；规则逐字对照 core 校验实码双层）
// ---------------------------------------------------------------------------

/** 构造结果：ok=false 附防呆提示（与服务端校验同规则——前端防呆+服务端兜底双层） */
export type BuildResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** 词规范形（core word-dict.validate.ts normalizeWord 同式：trim+lowercase——本地查重与
 *  服务端 E_DUP_WORD 判定同口径，防「本地放行/服务端 400」漂移） */
export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * 词库提交请求体构造（对照 core word-dict.http.ts parsePutDictionaryBody + validate.ts
 * normalizeWordEntries 规则）：dict_type 两值 / base_version 非负整数 / 词条 trim 后 1-64 /
 * action 三值 / 规范形重复词拒（E_DUP_WORD 前端防呆）/ 总量 ≤10000。输出词统一规范形并按
 * word 升序（集合语义——与 core 存储形态一致，幂等重放全等判定确定）。
 */
export function buildPutDictionaryBody(input: {
  readonly dictType: string;
  readonly baseVersion: number;
  readonly words: readonly { readonly word: string; readonly action: string }[];
}): BuildResult<PutDictionaryBody> {
  if (!(DICT_TYPE_VALUES as readonly string[]).includes(input.dictType)) {
    return { ok: false, error: 'dict_type 必须为 illegal_content|legal_industry 之一' };
  }
  const dictType = input.dictType as DictType;
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
    return { ok: false, error: 'base_version 必须为非负整数（0=尚无版本）' };
  }
  if (input.words.length > WORDS_MAX_COUNT) {
    return {
      ok: false,
      error: `单词库版本词数不得超过 ${WORDS_MAX_COUNT}（当前 ${input.words.length}）`,
    };
  }
  const seen = new Map<string, WordAction>();
  for (const raw of input.words) {
    const word = typeof raw.word === 'string' ? raw.word : '';
    if (word.trim().length === 0 || word.trim().length > WORD_MAX_LEN) {
      return {
        ok: false,
        error: `word 必须为 trim 后 1-${WORD_MAX_LEN} 字符：${JSON.stringify(raw.word)}`,
      };
    }
    if (!(WORD_ACTION_VALUES as readonly string[]).includes(raw.action)) {
      return {
        ok: false,
        error: `action 必须为 ${WORD_ACTION_VALUES.join('|')} 之一：${raw.action}`,
      };
    }
    const norm = normalizeWord(word);
    if (seen.has(norm)) {
      // E_DUP_WORD 本地防呆：服务端同规则 400（大小写不敏感判定）
      return {
        ok: false,
        error: `词库内重复词（大小写不敏感）：${JSON.stringify(norm)}——E_DUP_WORD`,
      };
    }
    seen.set(norm, raw.action as WordAction);
  }
  const words = [...seen.entries()]
    .map(([word, action]) => ({ word, action }))
    .sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return { ok: true, value: { dict_type: dictType, base_version: input.baseVersion, words } };
}

/**
 * 处置请求体构造（对照 core risk-review.http.ts parseReviewBody 规则）：verdict 三值；
 * note 可选——trim 后非空才携带（空=不留备注不发键），1..500 不静默截断。
 */
export function buildReviewBody(
  verdict: string,
  note: string,
): BuildResult<{ verdict: ReviewVerdict; note?: string }> {
  if (!(REVIEW_VERDICT_VALUES as readonly string[]).includes(verdict)) {
    return {
      ok: false,
      error: 'verdict 必须为 CONFIRM_BLOCK|FALSE_POSITIVE|MARK_ONLY 之一',
    };
  }
  const trimmed = note.trim();
  if (trimmed === '') return { ok: true, value: { verdict: verdict as ReviewVerdict } };
  if (note.length > REVIEW_NOTE_MAX) {
    return {
      ok: false,
      error: `备注不得超过 ${REVIEW_NOTE_MAX} 字（当前 ${note.length}，不静默截断）`,
    };
  }
  return { ok: true, value: { verdict: verdict as ReviewVerdict, note: trimmed } };
}

/** 词集 diff（展示用纯函数：按 {word, action} 全等对比——词库集合语义；action 变更词条
 *  同时计入 added+removed 两列（词条替换语义，与 PUT 的 canonical 全等判定一致：action
 *  变更=提交内容不等=新建版本而非幂等重放——防 diff 面板误报「无词集变化」） */
export interface WordSetDiff {
  readonly added: readonly LexiconWordEntry[];
  readonly removed: readonly LexiconWordEntry[];
}

export function diffWordEntries(
  oldWords: readonly LexiconWordEntry[],
  newWords: readonly LexiconWordEntry[],
): WordSetDiff {
  const oldMap = new Map(oldWords.map((w) => [w.word, w]));
  const newMap = new Map(newWords.map((w) => [w.word, w]));
  const added: LexiconWordEntry[] = [];
  const removed: LexiconWordEntry[] = [];
  for (const [word, entry] of newMap) {
    const prev = oldMap.get(word);
    // 新词 or 同词 action 变更（词条替换——非 {word,action} 全等即入 added）
    if (prev === undefined || prev.action !== entry.action) added.push(entry);
  }
  for (const [word, entry] of oldMap) {
    const next = newMap.get(word);
    if (next === undefined || next.action !== entry.action) removed.push(entry);
  }
  const byWord = (a: LexiconWordEntry, b: LexiconWordEntry): number =>
    a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
  return { added: added.sort(byWord), removed: removed.sort(byWord) };
}

// ---------------------------------------------------------------------------
// API 函数（全部受保护面：auth + 401 统一拦截）
// ---------------------------------------------------------------------------

/**
 * GET /admin/risk/queue?dict_type=&action=&limit=&offset=：人审队列（待处置记录，新在前=
 * 服务端 created_at DESC+id DESC；处置后自动跌出）。limit 缺省 50 封顶 200 / offset 缺省 0
 * （0-based，轻量翻页——无 total 计数契约）；dict_type/action 筛选值域在服务层校验（非法 400）。
 */
export async function listRiskQueue(
  dictType?: DictType,
  action?: WordAction,
  limit?: number,
  offset?: number,
): Promise<{ items: readonly RiskQueueItem[] }> {
  const params = new URLSearchParams();
  if (dictType !== undefined) params.set('dict_type', dictType);
  if (action !== undefined) params.set('action', action);
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset !== undefined) params.set('offset', String(offset));
  const qs = params.toString();
  return apiFetch<{ items: readonly RiskQueueItem[] }>(
    `/admin/risk/queue${qs === '' ? '' : `?${qs}`}`,
    {
      auth: true,
    },
  );
}

/**
 * POST /admin/risk/records/:id/review：人审处置 {verdict, note?}（note 合法缺省不发键）。
 * 幂等键=record：已处置 → 409 E_CONFLICT（DONE，不翻案不再审计）→ 横幅+刷新承载；
 * 404=记录不存在；400=verdict/note 形状非法（服务端兜底，前端防呆先行）。
 */
export async function reviewRiskRecord(
  id: number,
  body: { verdict: ReviewVerdict; note?: string },
): Promise<RiskReviewResult> {
  const payload: { verdict: ReviewVerdict; note?: string } = { verdict: body.verdict };
  if (body.note !== undefined) payload.note = body.note;
  return apiFetch<RiskReviewResult>(`/admin/risk/records/${id}/review`, {
    method: 'POST',
    auth: true,
    body: payload,
  });
}

/** GET /admin/risk/dictionaries?dict_type=：词库当前生效版本视图（缺省双库；无版本库
 *  version=0、words=[] 确定性契约；非法 dict_type 400） */
export async function listDictionaries(dictType?: DictType): Promise<readonly DictionaryView[]> {
  const qs = dictType === undefined ? '' : `?dict_type=${dictType}`;
  return apiFetch<readonly DictionaryView[]>(`/admin/risk/dictionaries${qs}`, { auth: true });
}

/**
 * PUT /admin/risk/dictionaries：词库提交（幂等键=dict+base_version——base_version=调用方
 * 所见当前版本，写入版本恒=base_version+1 乐观并发）。重放（同键内容全等）→ created:false
 * 幂等回读；base_version 过期/并发竞态 → 409 E_CONFLICT/E_RULE_PUBLISHING（重取后重试）；
 * 词库内重复词 → 400 E_DUP_WORD。提交即 EFFECTIVE（R-03 免公示）+自动机即时重建。
 */
export async function putDictionary(body: PutDictionaryBody): Promise<PutDictionaryResult> {
  return apiFetch<PutDictionaryResult>('/admin/risk/dictionaries', {
    method: 'PUT',
    auth: true,
    body,
  });
}
