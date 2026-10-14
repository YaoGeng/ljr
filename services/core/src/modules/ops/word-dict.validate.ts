/**
 * H5 词库切片校验与内容结构（纯函数，服务层与 HTTP 入参解析共用；形态沿 rule-center.validate）。
 *
 * 词约束：trim 后 1..64 字符（§3 varchar(64)）；词库正文统一小写规范形（匹配大小写不敏感），
 * 重复词按规范形判定 → 400 E_DUP_WORD（§5）。content 结构契约见 word-dict.types.ts 注释：
 * 读取面违例=InternalError 显性化（脏数据静默透传会让判定引擎带着空词表跑，宁炸不降级）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { DictType, LexiconContent, LexiconWordEntry, WordAction } from './word-dict.types';
import { isDictType, isWordAction, WORD_ACTIONS } from './word-dict.types';

/** §3 词列宽 varchar(64)（trim 后） */
export const WORD_MAX_LEN = 64;

/** 单版本词数上限（⚠实现约定：真实运营词库远小于此；超限属 M2 后台批量导入机制的范围） */
export const WORDS_MAX_COUNT = 10_000;

/** 匹配规范形：trim + 小写（词库正文与判定扫描共用同一规范，保证 dup 判定与命中一致） */
export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

export function assertDictType(dictType: string): asserts dictType is DictType {
  if (typeof dictType !== 'string' || !isDictType(dictType)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `dict_type 须为 ${WORD_DICT_TYPES_TEXT}：${JSON.stringify(dictType)}`,
    );
  }
}

/** 幂等键=dict+base_version（§5）：base_version=调用方所见当前版本，0=尚无版本 */
export function assertBaseVersion(baseVersion: number): void {
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `base_version 须为非负整数（0=尚无版本）：${String(baseVersion)}`,
    );
  }
}

/**
 * 词集规范化与校验（PUT 入参 → 词库正文）：trim+小写规范形、逐词长度、action 枚举、
 * 规范形重复 → E_DUP_WORD、总量上限；输出按 word 升序排序（集合语义，幂等重放全等判定确定）。
 */
export function normalizeWordEntries(
  words: readonly { readonly word: string; readonly action: WordAction }[],
): LexiconWordEntry[] {
  if (!Array.isArray(words)) {
    throw new AppError(ErrorCode.InvalidArgument, 'words 须为数组');
  }
  if (words.length > WORDS_MAX_COUNT) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `单词库版本词数不得超过 ${WORDS_MAX_COUNT}（当前 ${words.length}）`,
    );
  }
  const seen = new Map<string, WordAction>();
  const entries: LexiconWordEntry[] = [];
  for (const raw of words) {
    if (typeof raw !== 'object' || raw === null) {
      throw new AppError(ErrorCode.InvalidArgument, 'words 条目须为 {word, action}');
    }
    const { word, action } = raw as { word?: unknown; action?: unknown };
    if (typeof word !== 'string' || word.trim().length === 0 || word.trim().length > WORD_MAX_LEN) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `word 须为 trim 后 1-${WORD_MAX_LEN} 字符：${JSON.stringify(word ?? null)}`,
      );
    }
    if (typeof action !== 'string' || !isWordAction(action)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `action 须为 ${WORD_ACTIONS.join('|')}：${JSON.stringify(action ?? null)}`,
      );
    }
    const norm = normalizeWord(word);
    const prev = seen.get(norm);
    if (prev !== undefined) {
      throw new AppError(
        ErrorCode.DuplicateWord,
        `词库内重复词（大小写不敏感）：${JSON.stringify(norm)}`,
      );
    }
    seen.set(norm, action);
    entries.push({ word: norm, action });
  }
  return entries.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
}

/** 词库 content 写入形态（putDictionary 构造 createLexiconVersion content 用） */
export function toLexiconContent(entries: readonly LexiconWordEntry[]): LexiconContent {
  return { words: entries };
}

/**
 * 词库 content 结构判定（读取面防御，结构契约见 word-dict.types.ts 注释）。
 * 评审 Important-1：除形状外校验**规范形不变量** `word === normalizeWord(word)`（小写规范形是
 * 匹配正确性的前提——扫描文本统一 toLowerCase，非规范形词条在自动机上永不可达=静默 fail-open
 * 风控漏拦，且 currentBlockWords 会向 E1 吐非规范形词）。写面 normalizeWordEntries 保证规范形；
 * 经其它路径（H7 通用面/历史脏数据）入册的脏行由读取面显性报错（parseLexiconContent
 * InternalError），宁炸不降级。
 */
export function isLexiconShape(content: Record<string, unknown>): content is LexiconContent {
  const words = content['words'];
  return (
    Array.isArray(words) &&
    words.every((w) => {
      if (typeof w !== 'object' || w === null) return false;
      const word = (w as { word?: unknown }).word;
      if (typeof word !== 'string' || word.length === 0 || word.length > WORD_MAX_LEN) return false;
      if (word !== normalizeWord(word)) return false; // 规范形不变量
      const action = (w as { action?: unknown }).action;
      return typeof action === 'string' && isWordAction(action);
    })
  );
}

/**
 * 词库 content 提取（读取面）：结构/规范形违例=InternalError 显性化——判定引擎不得静默降级为
 * 空/部分词表（风控面裸奔），同 parseNoticeContent「宁炸读端」口径。
 */
export function parseLexiconContent(content: Record<string, unknown>): LexiconContent {
  if (!isLexiconShape(content)) {
    throw new AppError(
      ErrorCode.InternalError,
      `词库内容结构不合法（H5 §2 定义 {words:[{word(小写规范形), action}]}，词库正文只能经词库管理面写入）：${canonicalJson(content).slice(0, 200)}`,
    );
  }
  return {
    words: (content['words'] as { word: string; action: WordAction }[]).map((w) => ({
      word: w.word,
      action: w.action,
    })),
  };
}

/** 键序无关的 canonical JSON（幂等重放的全等比较口径；沿 rule-center.validate 同名实现） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const WORD_DICT_TYPES_TEXT = 'illegal_content|legal_industry';
