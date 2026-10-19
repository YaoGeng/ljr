/**
 * C4 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * 形状与类型收口（缺字段/类型错 → 400 E_INVALID_ARGUMENT，不漏成 500）；值域/形态校验在服务层
 * （assertCapacity/moneyToCents——解析器只做「形状与类型」，group-buy.http 同口径）；
 * id 解析收口 infrastructure/parse-positive-int；错误体形态：infrastructure
 * AppHttpExceptionFilter（{code, message}，全仓唯一过滤器）。
 */
import { AppError, ErrorCode, type Money } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import { assertIsoDate } from './session.types';

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象');
  }
  return body as Record<string, unknown>;
}

/** GET /lawyer/group-buys 查询形状：?status=（§5 逐字仅 PENDING_LAWYER 一档=待确认大厅；
 *  其他值 400 显性化不静默放行——大厅语义唯一） */
export function parseHallQuery(query: Record<string, unknown>): { status: 'PENDING_LAWYER' } {
  const status = query['status'];
  if (status === undefined) return { status: 'PENDING_LAWYER' };
  if (status !== 'PENDING_LAWYER') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `status 须为 PENDING_LAWYER（接单大厅仅待确认档）：${JSON.stringify(status)}`,
    );
  }
  return { status: 'PENDING_LAWYER' };
}

/** POST /group-buys/{id}/reject 体形状：{reason?}（拒绝理由，可选，≤500 形状护栏——值域不设） */
export function parseRejectBody(body: unknown): { reason?: string } {
  const raw = asObject(body);
  const reason = raw['reason'];
  if (reason === undefined) return {};
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 500) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `reason 须为 1-500 字符字符串：${JSON.stringify(reason)}`,
    );
  }
  return { reason };
}

/** 计数字段（capacity）：JSON number 或十进制数字符串（group-buy.http parseBigintId 同口径——
 *  URL/体双形态收窄，科学计数/0x 等宽解析一律 400） */
function parseCountId(v: unknown, field: string): number {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
      throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
    }
    return v;
  }
  return parsePositiveInt(v, field);
}

/** POST /group-buys/{id}/convert 体形状：{capacity?, price?}（§5「{capacity?, price 覆盖?}」逐字；
 *  price=Money 字符串两位小数——值域校验（moneyToCents）在服务层） */
export function parseConvertBody(body: unknown): {
  capacity?: number;
  price?: Money;
} {
  const raw = asObject(body);
  const out: { capacity?: number; price?: Money } = {};
  if (raw['capacity'] !== undefined) {
    out.capacity = parseCountId(raw['capacity'], 'capacity');
  }
  if (raw['price'] !== undefined) {
    if (typeof raw['price'] !== 'string') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `price 须为两位小数金额字符串：${JSON.stringify(raw['price'])}`,
      );
    }
    out.price = raw['price'] as Money;
  }
  return out;
}

/** GET /lawyer/response-stats 查询形状：?from=&to=（YYYY-MM-DD 区间，session.http stats 同口径） */
export function parseResponseStatsQuery(query: Record<string, unknown>): {
  from: string;
  to: string;
} {
  const require = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || v === '') {
      throw new AppError(ErrorCode.InvalidArgument, `response-stats 须携带 ${field}（YYYY-MM-DD）`);
    }
    return assertIsoDate(v, field);
  };
  return {
    from: require(query['from'], 'from'),
    to: require(query['to'], 'to'),
  };
}
