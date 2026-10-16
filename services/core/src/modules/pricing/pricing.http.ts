/**
 * B3 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case）。
 *
 * 台账顺延项修正（T4 minor ①/④形态）：解析器做元素级类型占位透传——域校验全部收敛在
 * pricing.validate（每字段显性 typeof/形态检查 → AppError 400/422），畸形元素不再漏成 500；
 * parseLawyerId 严格十进制整数+安全上限，统一收口 infrastructure/parse-positive-int（G-B 做项4，
 * 补 MAX_SAFE_INTEGER 上限——超长数字不再静默精度丢失后 22003→500）。
 * 错误体形态：infrastructure 的 AppHttpExceptionFilter（{code, message}，G-B 做项1 全仓唯一过滤器）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { Money } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import type { OneOnOnePrices, PutPricingInput, RoomMode } from './pricing.types';

/** 路径参数 {id}：十进制正整数（lawyer_id=identity 侧用户 id；严格解析收口 G-B 做项4） */
export function parseLawyerId(raw: string): number {
  return parsePositiveInt(raw, '路径参数 id');
}

/** PUT /lawyer/pricing 体形状：{base_version, one_on_one_prices, ...可空列}（域校验在 validate 层） */
export function parsePutPricingBody(body: unknown): PutPricingInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      '请求体须为 JSON 对象 {base_version, one_on_one_prices, per_head?, ...}',
    );
  }
  const raw = body as Record<string, unknown>;
  return {
    base_version: raw['base_version'] as number,
    per_head: raw['per_head'] as Money | null | undefined,
    session_total: raw['session_total'] as Money | null | undefined,
    group_size: raw['group_size'] as number | null | undefined,
    accept_min: raw['accept_min'] as number | null | undefined,
    accept_max: raw['accept_max'] as number | null | undefined,
    room_modes: raw['room_modes'] as readonly RoomMode[] | null | undefined,
    one_on_one_prices: raw['one_on_one_prices'] as OneOnOnePrices,
  };
}
