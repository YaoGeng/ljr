/**
 * H5 词库管理 HTTP 面共用件：入参解析（§5 /admin/risk/dictionaries）。
 * 错误映射复用 H7 的 RuleHttpExceptionFilter（AppError → {code, message}，模块内同款先例）。
 * 后台鉴权 ⚠决策位：admin 角色鉴权随 H1/H2（W2+）接入后替换，本批次只交付接口形态
 * （rule-admin/scheduler-admin 同口径）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { DictType, PutDictionaryInput } from './word-dict.types';
import { assertBaseVersion, assertDictType } from './word-dict.validate';

/** PUT /admin/risk/dictionaries 体：{dict_type, base_version, words:[{word, action}]}（§5 键名随契约词汇） */
export function parsePutDictionaryBody(body: unknown): PutDictionaryInput {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 {dict_type, base_version, words}');
  }
  const dictType = (body as { dict_type?: unknown }).dict_type;
  const baseVersion = (body as { base_version?: unknown }).base_version;
  const words = (body as { words?: unknown }).words;
  if (typeof dictType !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, '请求体缺 dict_type（字符串）');
  }
  assertDictType(dictType);
  if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `请求体 base_version 须为非负整数（0=尚无版本）：${String(baseVersion)}`,
    );
  }
  assertBaseVersion(baseVersion);
  if (!Array.isArray(words)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体缺 words（数组）');
  }
  // 词条校验（长度/action/重复词 E_DUP_WORD）在服务层 normalizeWordEntries 统一执行
  return { dictType, baseVersion, words: words as PutDictionaryInput['words'] };
}

/** GET /admin/risk/dictionaries?dict_type= 过滤（缺省=双库视图；非法 400） */
export function parseDictTypeFilter(raw: string | undefined): DictType | undefined {
  if (raw === undefined || raw === '') return undefined;
  assertDictType(raw);
  return raw;
}
