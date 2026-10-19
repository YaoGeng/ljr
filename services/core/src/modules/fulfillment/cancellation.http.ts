/**
 * D4 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * POST /sessions/{id}/cancel {role: user|lawyer, reason}——role 必填双值（platform 不经 API，
 * §4「平台取消（本 API 不暴露——事件消费路径）」）；reason 自由文本 ≤200（缺省空串）。
 * POST /enrollments/{id}/cancel {choice: refund50|credit}——§5 逐字（<2h 用户选择）。
 * id 解析收口 infrastructure/parse-positive-int；错误体形态=AppHttpExceptionFilter（全仓唯一）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import type { CancelRole, UserLateChoice } from './cancellation.types';

/** 路径参 session_id / enrollment_id（正整数收口） */
export function parseSessionIdParam(raw: string): number {
  return parsePositiveInt(raw, 'session_id');
}

export function parseEnrollmentIdParam(raw: string): number {
  return parsePositiveInt(raw, 'enrollment_id');
}

/** role 收口（user|lawyer；platform 越域 400——消费路径专用词汇禁入 API） */
export function parseCancelRole(raw: unknown): CancelRole {
  if (raw !== 'user' && raw !== 'lawyer') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `role 必须为 user|lawyer（platform 取消不经 API——事件消费路径）：${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** reason 收口（可选自由文本 ≤200；缺省空串——STL reason 列宽 128 由服务面截断） */
export function parseCancelReason(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string' || raw.length > 200) {
    throw new AppError(ErrorCode.InvalidArgument, 'reason 须为 ≤200 字符文本（可选）');
  }
  return raw;
}

/** choice 收口（refund50|credit，§5 逐字） */
export function parseUserLateChoice(raw: unknown): UserLateChoice {
  if (raw !== 'refund50' && raw !== 'credit') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `choice 必须为 refund50|credit（<2h 用户取消选择）：${JSON.stringify(raw)}`,
    );
  }
  return raw;
}
