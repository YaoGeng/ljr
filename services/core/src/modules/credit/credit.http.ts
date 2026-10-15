/**
 * G1 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case）。
 * 解析器元素级校验（T4/T5 台账修正形态：畸形入参 → 400 显性拒绝，不漏 500）；
 * parseOwnerId 用 ^\d+$ 严格整数（拒 0x10/1e2/负号形态）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { isOwnerType, type OwnerType } from './credit.types';

/** query owner_type：'user'|'lawyer'（DB CHECK 同字面值域） */
export function parseOwnerType(raw: string | undefined): OwnerType {
  if (typeof raw === 'string' && isOwnerType(raw)) return raw;
  throw new AppError(ErrorCode.InvalidArgument, `owner_type 须为 user|lawyer：${String(raw)}`);
}

/** query owner_id：十进制正整数（identity 侧用户 id；拒 0x10/1e2/负号形态） */
export function parseOwnerId(raw: string | undefined): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new AppError(ErrorCode.InvalidArgument, `owner_id 须为正整数：${String(raw)}`);
  }
  const id = Number(raw);
  if (id <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `owner_id 须为正整数：${String(raw)}`);
  }
  return id;
}
