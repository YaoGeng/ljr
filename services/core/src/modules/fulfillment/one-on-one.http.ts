/**
 * D6 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字；cancellation.http 同形态）。
 *
 * POST /one-on-one {room_id, service_type, mode}——三键必填（user_id=JWT actor 不收 body）。
 * POST /one-on-one/{id}/accept——无 body。
 * POST /one-on-one/{id}/finish {consumed_units?}——声明可选（W3-15：仅校验回执，advisory 出参）。
 * POST /one-on-one/{id}/settle-confirm {role, settle_amount}——role 双值+Money 字符串。
 * POST /one-on-one/{id}/settle-diff/pay——无 body（补差单幂等定位=order）。
 * POST /one-on-one/{id}/cancel {role?}——role 缺省 user（双值校验同 cancellation.http）。
 * POST /one-on-one/{id}/duration {duration_seconds}——RTC 时长回调（dev 面，mock 注入用）。
 * id 解析收口 infrastructure/parse-positive-int；错误体形态=AppHttpExceptionFilter（全仓唯一）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import {
  assertOneOnOneMode,
  assertServiceType,
  type OneOnOneMode,
  type OneOnOneServiceType,
} from './one-on-one.types';

/** 路径参 order_id（正整数收口） */
export function parseOrderIdParam(raw: string): number {
  return parsePositiveInt(raw, 'order_id');
}

/** body.room_id（正整数收口） */
export function parseRoomIdField(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || !Number.isSafeInteger(raw)) {
    throw new AppError(ErrorCode.InvalidArgument, `room_id 须为正整数：${JSON.stringify(raw)}`);
  }
  return raw;
}

/** body.service_type（三值收口） */
export function parseServiceTypeField(raw: unknown): OneOnOneServiceType {
  return assertServiceType(raw);
}

/** body.mode（三值收口） */
export function parseModeField(raw: unknown): OneOnOneMode {
  return assertOneOnOneMode(raw);
}

/** body.consumed_units（可选非负整数声明——0=声明确无消费；缺省=无声明） */
export function parseConsumedUnitsField(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `consumed_units 须为非负整数（声明值，系统计量为准）：${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** body.settle_amount（Money 两位小数字符串——服务面 moneyToCents 再校验正数形态） */
export function parseSettleAmountField(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d+\.\d{2}$/.test(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `settle_amount 须为两位小数 Money 字符串：${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** body.role（user|lawyer；settle-confirm 必填 / cancel 缺省 user） */
export function parseOooRole(raw: unknown, fallback?: 'user'): 'user' | 'lawyer' {
  if ((raw === undefined || raw === null) && fallback === 'user') return 'user';
  if (raw !== 'user' && raw !== 'lawyer') {
    throw new AppError(ErrorCode.InvalidArgument, `role 须为 user|lawyer：${JSON.stringify(raw)}`);
  }
  return raw;
}

/** body.duration_seconds（非负整数秒——0=会话开启信标：触发 IN_SERVICE 不计段） */
export function parseDurationSecondsField(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `duration_seconds 须为非负整数（秒）：${JSON.stringify(raw)}`,
    );
  }
  return raw;
}
