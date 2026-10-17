/**
 * C1 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * 形状与类型收口（缺字段/类型错 → 400 E_INVALID_ARGUMENT，不漏成 500）；枚举字段的值域校验
 * 在解析层完成（parseDeductBody 先例——返回类型即窄类型，服务层域校验兜底语义不变）；
 * 金额经 @ljr/shared assertMoney（两位小数字符串，禁 float）；
 * id 解析收口 infrastructure/parse-positive-int（十进制 + MAX_SAFE_INTEGER 上限）；
 * 错误体形态：infrastructure AppHttpExceptionFilter（{code, message}，全仓唯一过滤器）。
 */
import { AppError, ErrorCode, assertMoney, type Money } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import { SPECIALTY_MAX_LEN } from './group-buy.types';
import {
  assertIsoDate,
  assertIsoDatetime,
  assertRoomMode,
  type PriceMode,
  type SessionRoomMode,
} from './session.types';

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象');
  }
  return body as Record<string, unknown>;
}

interface SessionBodyShape {
  slot_start: Date;
  price_mode: PriceMode;
  unit_price?: Money;
  capacity: number;
  enroll_deadline?: Date;
  room_mode: SessionRoomMode;
}

/** POST /sessions 体形状：{slot_start, price_mode, unit_price?, capacity, enroll_deadline?, room_mode} */
export function parseSessionBody(body: unknown): SessionBodyShape {
  const raw = asObject(body);
  if (raw['price_mode'] !== 'per_head' && raw['price_mode'] !== 'session_total') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `price_mode 须为 per_head|session_total：${JSON.stringify(raw['price_mode'])}`,
    );
  }
  if (typeof raw['capacity'] !== 'number') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `capacity 须为整数：${JSON.stringify(raw['capacity'])}`,
    );
  }
  const out: SessionBodyShape = {
    slot_start: assertIsoDatetime(raw['slot_start'], 'slot_start'),
    price_mode: raw['price_mode'],
    capacity: raw['capacity'],
    room_mode: assertRoomMode(raw['room_mode']),
  };
  if (raw['unit_price'] !== undefined) {
    if (typeof raw['unit_price'] !== 'string') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `unit_price 须为两位小数字符串（Money 禁 float/number）：${JSON.stringify(raw['unit_price'])}`,
      );
    }
    out.unit_price = assertMoney(raw['unit_price']);
  }
  if (raw['enroll_deadline'] !== undefined) {
    out.enroll_deadline = assertIsoDatetime(raw['enroll_deadline'], 'enroll_deadline');
  }
  return out;
}

/** GET /sessions 查询形状：?specialty=&city=&lawyer=&from=&to=（缺省=不过滤；双维真过滤=序 11.5） */
export function parseListQuery(query: Record<string, unknown>): {
  specialty?: string;
  city?: string;
  lawyer?: number;
  from?: string;
  to?: string;
} {
  return {
    // specialty 查询参上界 32=列宽对齐（T11.5-① 收口：>32 原得空集，现 400 显式拒绝）
    specialty: queryParam(query['specialty'], 'specialty', SPECIALTY_MAX_LEN),
    city: queryParam(query['city'], 'city'),
    lawyer:
      queryParam(query['lawyer'], 'lawyer') === undefined
        ? undefined
        : parsePositiveInt(queryParam(query['lawyer'], 'lawyer'), 'lawyer'),
    from:
      queryParam(query['from'], 'from') === undefined
        ? undefined
        : assertIsoDate(queryParam(query['from'], 'from'), 'from'),
    to:
      queryParam(query['to'], 'to') === undefined
        ? undefined
        : assertIsoDate(queryParam(query['to'], 'to'), 'to'),
  };
}

/** GET /lawyer/sessions/stats 查询形状：?from=&to=（必填，§5 契约） */
export function parseStatsQuery(query: Record<string, unknown>): { from: string; to: string } {
  const from = queryParam(query['from'], 'from');
  const to = queryParam(query['to'], 'to');
  if (from === undefined || to === undefined) {
    throw new AppError(ErrorCode.InvalidArgument, 'stats 须携带 from 与 to（YYYY-MM-DD 区间）');
  }
  return { from: assertIsoDate(from, 'from'), to: assertIsoDate(to, 'to') };
}

function queryParam(v: unknown, field: string, maxLen?: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v === '') {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为非空字符串：${JSON.stringify(v)}`);
  }
  if (maxLen !== undefined && v.length > maxLen) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `${field} 须为 1-${maxLen} 字符：${JSON.stringify(v)}`,
    );
  }
  return v;
}
