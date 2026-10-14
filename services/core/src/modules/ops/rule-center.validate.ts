/**
 * H7 规则中心校验与内容结构（纯函数，服务层与 HTTP 入参解析共用）。
 *
 * 规则键格式：1-32 位字母/数字/下划线/点（DB varchar(32)；§2 规则域前缀 + H5 词库 wordlist.*）。
 * 内容：恒为 JSON 对象（非数组/null）；canonicalJson 做键序无关的全等比较（§5 幂等键重放判定）。
 * 房间须知（R-02）结构：{title, paragraphs, disclosures}——创建期校验（InvalidArgument 早反馈）+
 * 读取期再校验（历史脏数据 InternalError 显性化），结构定义见 rule-center.types.ts 注释。
 */
import { AppError, ErrorCode } from '@ljr/shared';

export const RULE_KEY_PATTERN = /^[A-Za-z0-9_.]{1,32}$/;

export function assertRuleKey(ruleKey: string): void {
  if (typeof ruleKey !== 'string' || !RULE_KEY_PATTERN.test(ruleKey)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `rule_key 须为 1-32 位字母/数字/下划线/点：${JSON.stringify(ruleKey)}`,
    );
  }
}

export function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `version 须为正整数：${String(version)}`);
  }
}

export function assertContent(content: unknown): asserts content is Record<string, unknown> {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new AppError(ErrorCode.InvalidArgument, `content 须为 JSON 对象（非数组/null）`);
  }
}

export function assertEffectiveAt(at: Date | undefined, name = 'effectiveAt'): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new AppError(ErrorCode.InvalidArgument, `${name} 须为有效 Date：${String(at)}`);
  }
}

/** R-02 房间须知结构判定（结构契约见 rule-center.types.ts RoomNoticeContent 注释） */
export function isNoticeShape(content: Record<string, unknown>): boolean {
  const title = content['title'];
  const paragraphs = content['paragraphs'];
  const disclosures = content['disclosures'];
  return (
    typeof title === 'string' &&
    title.length > 0 &&
    title.length <= 64 &&
    Array.isArray(paragraphs) &&
    paragraphs.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 500) &&
    Array.isArray(disclosures) &&
    disclosures.length > 0 &&
    disclosures.every((d) => typeof d === 'string' && d.length > 0 && d.length <= 200)
  );
}

/**
 * 须知内容提取（读取面）：结构违例=InternalError 显性化——脏数据静默透传会让 D5 渲染出无披露
 * 的须知（R-02 合规面），宁炸读端也不降级。
 */
export function parseNoticeContent(content: Record<string, unknown>): {
  title: string;
  paragraphs: string[];
  disclosures: string[];
} {
  if (!isNoticeShape(content)) {
    throw new AppError(
      ErrorCode.InternalError,
      `房间须知内容结构不合法（H7 §2 定义 {title, paragraphs, disclosures 非空}，R-02）：${canonicalJson(content).slice(0, 200)}`,
    );
  }
  return {
    title: content['title'] as string,
    paragraphs: content['paragraphs'] as string[],
    disclosures: content['disclosures'] as string[],
  };
}

/** 键序无关的 canonical JSON（幂等键重放的全等比较口径；undefined 字段视同缺失） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
