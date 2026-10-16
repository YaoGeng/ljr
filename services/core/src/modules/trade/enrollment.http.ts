/**
 * C3 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字；session.http 同形先例）。
 * 形状收口（缺字段/类型错 → 400 E_INVALID_ARGUMENT）；points_to_use 可选非负整数。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象');
  }
  return body as Record<string, unknown>;
}

/** POST /sessions/{id}/enroll 与 POST /group-buys/{id}/join 体形状：{points_to_use?}（§5 逐字） */
export function parseEnrollBody(body: unknown): { points_to_use?: number } {
  const raw = asObject(body);
  if (raw['points_to_use'] === undefined) return {};
  const v = raw['points_to_use'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `points_to_use 须为非负整数（100 积分=1 元）：${JSON.stringify(v)}`,
    );
  }
  return { points_to_use: v };
}

/** POST /sessions/{id}/enroll 路径参数：场次 id（十进制正整数收口） */
export function parsePathId(id: string, field: string): number {
  return parsePositiveInt(id, field);
}
