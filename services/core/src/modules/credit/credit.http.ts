/**
 * G1 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case）。
 * 解析器元素级校验（T4/T5 台账修正形态：畸形入参 → 400 显性拒绝，不漏 500）；
 * parseOwnerId 严格十进制整数+安全上限，统一收口 infrastructure/parse-positive-int（G-B 做项4，
 * 补 MAX_SAFE_INTEGER 上限——超长数字不再静默精度丢失后 22003→500）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import { isOwnerType, type OwnerType } from './credit.types';

/** query owner_type：'user'|'lawyer'（DB CHECK 同字面值域） */
export function parseOwnerType(raw: string | undefined): OwnerType {
  if (typeof raw === 'string' && isOwnerType(raw)) return raw;
  throw new AppError(ErrorCode.InvalidArgument, `owner_type 须为 user|lawyer：${String(raw)}`);
}

/** query owner_id：十进制正整数（identity 侧用户 id；拒 0x10/1e2/负号/超长形态） */
export function parseOwnerId(raw: string | undefined): number {
  return parsePositiveInt(raw, 'owner_id');
}
