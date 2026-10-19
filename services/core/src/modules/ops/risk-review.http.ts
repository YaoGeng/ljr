/**
 * H5 人审闭环 HTTP 面共用件（§5 契约词汇）：只做「形状→领域入参」搬运，错误映射经
 * infrastructure 的 AppHttpExceptionFilter（全仓唯一过滤器纪律）。ticket.http 先例。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import {
  REVIEW_NOTE_MAX,
  isReviewVerdict,
  type RiskQueueFilter,
  type ReviewVerdict,
} from './risk-review.types';

/**
 * GET /admin/risk/queue 查询解析：dict_type/action 单值筛选（词汇合法性在服务层统一校验，
 * 此处只收形状）+ limit/offset 数字解析（limit 缺省 50 封顶 200 在服务层收口）。
 */
export function parseQueueQuery(query: {
  readonly dict_type?: string;
  readonly action?: string;
  readonly limit?: string;
  readonly offset?: string;
}): RiskQueueFilter {
  const out: { dictType?: string; action?: string; limit?: number; offset?: number } = {};
  if (query.dict_type !== undefined && query.dict_type !== '') {
    out.dictType = query.dict_type;
  }
  if (query.action !== undefined && query.action !== '') {
    out.action = query.action;
  }
  if (query.limit !== undefined && query.limit !== '') {
    out.limit = parsePositiveInt(query.limit, 'limit');
  }
  if (query.offset !== undefined && query.offset !== '') {
    // parsePositiveInt 拒 0 不合 offset 语义——0 合法（首页），单独放行
    const n = Number(query.offset);
    if (!Number.isInteger(n) || n < 0) {
      throw new AppError(ErrorCode.InvalidArgument, `offset 必须为非负整数：${query.offset}`);
    }
    out.offset = n;
  }
  return out;
}

/** POST /admin/risk/records/{id}/review 体：{verdict, note?}（§5 逐字+简报 note 扩展位） */
export function parseReviewBody(body: unknown): { verdict: ReviewVerdict; note?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {verdict, note?}');
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw['verdict'] !== 'string' || !isReviewVerdict(raw['verdict'])) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `verdict 必须为 CONFIRM_BLOCK|FALSE_POSITIVE|MARK_ONLY 之一：${JSON.stringify(raw['verdict'])}`,
    );
  }
  const out: { verdict: ReviewVerdict; note?: string } = { verdict: raw['verdict'] };
  if (raw['note'] !== undefined) {
    if (typeof raw['note'] !== 'string' || raw['note'].trim() === '') {
      throw new AppError(ErrorCode.InvalidArgument, 'note 必须为非空字符串（缺省=不留备注）');
    }
    if (raw['note'].length > REVIEW_NOTE_MAX) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `note 长度 ${raw['note'].length} 超上限 ${REVIEW_NOTE_MAX}（不静默截断）`,
      );
    }
    out.note = raw['note'];
  }
  return out;
}
