/**
 * H7 HTTP 面共用件：入参解析（§5）。
 * 错误体过滤器已收敛至 infrastructure 的 AppHttpExceptionFilter（G-B 做项1，6→1；
 * 错误体形态 {code, message} 不变）。
 * 后台鉴权 ⚠决策位：admin 角色鉴权随 H1/H2（W2+）接入后替换，本批次只交付接口形态
 * （与 I2 /admin/scheduler/jobs 同口径）；App 面只读接口无鉴权（控制者裁决）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { CreateDraftInput, RulePublishStatus } from './rule-center.types';
import { isRulePublishStatus } from './rule-center.types';
import {
  assertContent,
  assertRuleKey,
  assertVersion,
  RULE_KEY_PATTERN,
} from './rule-center.validate';

export function parseRuleKey(raw: string | undefined): string {
  if (raw === undefined || raw === '' || typeof raw !== 'string' || !RULE_KEY_PATTERN.test(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `rule_key 须为 1-32 位字母/数字/下划线/点：${JSON.stringify(raw ?? null)}`,
    );
  }
  return raw;
}

export function parseRuleVersion(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n <= 0) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `version 必须为正整数：${JSON.stringify(raw ?? null)}`,
    );
  }
  return n;
}

export function parseRuleStatus(raw: string | undefined): RulePublishStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!isRulePublishStatus(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `status 须为 DRAFT|PUBLISHED|EFFECTIVE|ABANDONED：${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

export function parseRuleLimit(raw: string | undefined, fallback = 100, max = 500): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `limit 须为 1-${max} 整数：${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** GET /rules/snapshot 的 at（ISO 8601 行为时刻；非法/缺省 400——快照必须显式给时刻） */
export function parseSnapshotAt(raw: string | undefined): Date {
  if (raw === undefined || raw === '') {
    throw new AppError(ErrorCode.InvalidArgument, 'at 必填（ISO 8601 行为时刻）');
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new AppError(ErrorCode.InvalidArgument, `at 须为 ISO 8601 时刻：${JSON.stringify(raw)}`);
  }
  return at;
}

/** POST /admin/rules 体：{rule_key, version, content}（键名随 §5 契约词汇） */
export function parseCreateRuleBody(body: unknown): CreateDraftInput {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 {rule_key, version, content}');
  }
  const ruleKey = (body as { rule_key?: unknown }).rule_key;
  const version = (body as { version?: unknown }).version;
  const content = (body as { content?: unknown }).content;
  if (typeof ruleKey !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, '请求体缺 rule_key（字符串）');
  }
  assertRuleKey(ruleKey);
  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `请求体 version 须为正整数：${String(version)}`);
  }
  assertContent(content);
  assertVersion(version);
  return { ruleKey, version, content };
}

/** POST publish/abandon 体：{version} */
export function parseRuleVersionBody(body: unknown): number {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 {version}');
  }
  const version = (body as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `请求体 version 须为正整数：${String(version)}`);
  }
  return version;
}
