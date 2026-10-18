/**
 * D5 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字；room.http 同口径收口
 * parse-positive-int——十进制正整数，缺省/非数字 → 400 E_INVALID_ARGUMENT 不漏成 500）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';

/** 路径参 conversation_id / room id（正整数收口） */
export const parseConversationIdParam = (raw: string): number =>
  parsePositiveInt(raw, 'conversation_id');

export const parseRoomIdParam = (raw: string): number => parsePositiveInt(raw, 'room_id');

/** 查询参 after_seq（非负整数；缺省 0=从头拉取；after_seq=0 语义等价缺省） */
export function parseAfterSeq(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `after_seq 须为非负十进制整数：${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new AppError(ErrorCode.InvalidArgument, `after_seq 超出安全整数上限：${raw}`);
  }
  return value;
}

/** 查询参 limit（正整数；缺省=服务面 DEFAULT_PULL_LIMIT，上限收窄在服务面承载） */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) === 0 || !Number.isSafeInteger(Number(raw))) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `limit 须为正十进制整数（≤上限 200）：${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}
