/**
 * C5 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * 形状与类型收口（缺字段/类型错 → 400 E_INVALID_ARGUMENT，不漏成 500）；值域/窗判定在
 * 服务层（§5 400 <2H 等业务守卫）——解析器只做「形状与类型」，group-buy-response.http
 * 同口径；id 解析收口 infrastructure/parse-positive-int。
 */
import { AppError, ErrorCode } from '@ljr/shared';

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象');
  }
  return body as Record<string, unknown>;
}

/** 正整数字段（JSON number 或十进制数字符串双形态收窄——group-buy-response.http 同款） */
function parseCountId(v: unknown, field: string): number {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
      throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
    }
    return v;
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && Number.isSafeInteger(n)) return n;
  }
  throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
}

/** POST /enrollments/{id}/reschedule 体形状：{target_session_id}（§5 逐字必填） */
export function parseRescheduleBody(body: unknown): { target_session_id: number } {
  const raw = asObject(body);
  if (raw['target_session_id'] === undefined) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      '须携带 target_session_id（目标场次 id，§5 契约逐字）',
    );
  }
  return { target_session_id: parseCountId(raw['target_session_id'], 'target_session_id') };
}
