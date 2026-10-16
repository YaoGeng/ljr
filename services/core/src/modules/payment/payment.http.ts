/**
 * F1 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * 形态占位透传——域校验收敛在服务层（assertMoney/assertPositiveInt/守卫），解析器只做
 * 「形状与类型」（缺字段/类型错 → 400 E_INVALID_ARGUMENT，不漏成 500）；
 * 金额经 @ljr/shared assertMoney（两位小数字符串，禁 float）；
 * id 解析收口 infrastructure/parse-positive-int（G-B 做项4：十进制 + MAX_SAFE_INTEGER 上限）；
 * 错误体形态：infrastructure AppHttpExceptionFilter（{code, message}，全仓唯一过滤器）。
 */
import { AppError, ErrorCode, assertMoney, type Money } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import type { DeductFrom } from './payment.types';

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象');
  }
  return body as Record<string, unknown>;
}

/** bigint 裸引用 id（biz_id/order_id/lawyer_id）：JSON number 或十进制数字符串 */
function parseBigintId(v: unknown, field: string): number {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
      throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
    }
    return v;
  }
  return parsePositiveInt(v, field);
}

function parseKey(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `idempotency_key 须为非空字符串：${JSON.stringify(v)}`,
    );
  }
  return v;
}

function parseMoney(v: unknown, field: string): Money {
  if (typeof v !== 'string') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `${field} 须为两位小数字符串（Money 禁 float/number）：${JSON.stringify(v)}`,
    );
  }
  return assertMoney(v);
}

function parsePoints(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `points_amount 须为非负整数：${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** POST /pay/orders 体形状：{biz_type, biz_id, cash_amount, points_amount, idempotency_key} */
export function parseOrderBody(body: unknown): {
  biz_type: string;
  biz_id: number;
  cash_amount: Money;
  points_amount: number;
  idempotency_key: string;
} {
  const raw = asObject(body);
  if (typeof raw['biz_type'] !== 'string') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `biz_type 须为字符串：${JSON.stringify(raw['biz_type'])}`,
    );
  }
  return {
    biz_type: raw['biz_type'],
    biz_id: parseBigintId(raw['biz_id'], 'biz_id'),
    cash_amount: parseMoney(raw['cash_amount'], 'cash_amount'),
    points_amount: parsePoints(raw['points_amount']),
    idempotency_key: parseKey(raw['idempotency_key']),
  };
}

/** POST /pay/refund 体形状：{order_id, cash_refund, points_refund, reason, idempotency_key} */
export function parseRefundBody(body: unknown): {
  order_id: number;
  cash_refund: Money;
  points_refund: number;
  reason: string;
  idempotency_key: string;
} {
  const raw = asObject(body);
  if (typeof raw['reason'] !== 'string') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `reason 须为字符串：${JSON.stringify(raw['reason'])}`,
    );
  }
  return {
    order_id: parseBigintId(raw['order_id'], 'order_id'),
    cash_refund: parseMoney(raw['cash_refund'], 'cash_refund'),
    points_refund: parsePoints(raw['points_refund']),
    reason: raw['reason'],
    idempotency_key: parseKey(raw['idempotency_key']),
  };
}

/** POST /pay/split 体形状：{order_id, splits[], idempotency_key}
 *  （splits 元素形态占位透传为 SplitItem——逐字段域校验收敛在服务层 split()） */
export function parseSplitBody(body: unknown): {
  order_id: number;
  splits: readonly { payee_type: string; payee_id: number; amount: Money }[];
  idempotency_key: string;
} {
  const raw = asObject(body);
  if (!Array.isArray(raw['splits'])) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `splits 须为数组：${JSON.stringify(raw['splits'])}`,
    );
  }
  return {
    order_id: parseBigintId(raw['order_id'], 'order_id'),
    splits: raw['splits'] as readonly { payee_type: string; payee_id: number; amount: Money }[],
    idempotency_key: parseKey(raw['idempotency_key']),
  };
}

/** POST /pay/deduct 体形状：{lawyer_id, amount, from: settlement|deposit, idempotency_key} */
export function parseDeductBody(body: unknown): {
  lawyer_id: number;
  amount: Money;
  from: DeductFrom;
  idempotency_key: string;
} {
  const raw = asObject(body);
  if (raw['from'] !== 'settlement' && raw['from'] !== 'deposit') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `from 须为 settlement|deposit：${JSON.stringify(raw['from'])}`,
    );
  }
  return {
    lawyer_id: parseBigintId(raw['lawyer_id'], 'lawyer_id'),
    amount: parseMoney(raw['amount'], 'amount'),
    from: raw['from'],
    idempotency_key: parseKey(raw['idempotency_key']),
  };
}

/** POST /admin/payment/reconcile 体形状：{period, channels?}（⚠W3-10 手动触发面；
 *  channels 元素值域（wechat_ecom|alipay）校验收敛在服务层，未知通道 → 404） */
export function parseReconcileBody(body: unknown): {
  period: string;
  channels?: readonly string[];
} {
  const raw = asObject(body);
  if (typeof raw['period'] !== 'string') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `period 须为字符串（YYYY-MM-DD）：${JSON.stringify(raw['period'])}`,
    );
  }
  if (raw['channels'] === undefined) return { period: raw['period'] };
  if (!Array.isArray(raw['channels']) || raw['channels'].some((c) => typeof c !== 'string')) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `channels 须为字符串数组：${JSON.stringify(raw['channels'])}`,
    );
  }
  return { period: raw['period'], channels: raw['channels'] as readonly string[] };
}

/** 携带 rawBody 的请求形态（NestFactory rawBody:true 装载；main.ts 与测试 app 同口径） */
export interface RawBodyRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}
