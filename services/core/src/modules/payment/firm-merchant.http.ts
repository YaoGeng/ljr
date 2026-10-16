/**
 * A3b HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * 形态占位透传（payment.http 同形）：域校验收敛在服务层（assertChannel/assertMaterials/
 * 守卫/金额），解析器只做「形状与类型」——缺字段/类型错 → 400 E_INVALID_ARGUMENT，不漏成 500；
 * 金额经 @ljr/shared assertMoney；id 解析收口 infrastructure/parse-positive-int（G-B 做项4）；
 * 错误体形态：infrastructure AppHttpExceptionFilter（{code, message}，全仓唯一过滤器）。
 * materials 为敏感对象：解析器只验证「是 JSON 对象」，内容不复制不落日志（PII 红线——
 * 服务层 logMaterialsSafe 是唯一摘要日志出入口）。
 */
import { AppError, ErrorCode, assertMoney, type Money } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象');
  }
  return body as Record<string, unknown>;
}

function parseChannel(v: unknown): string {
  if (typeof v !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, `channel 须为字符串：${JSON.stringify(v)}`);
  }
  return v;
}

/** POST /firms/{id}/merchant/submit 体形状：{channel, materials}（materials 形状透传，域校验在服务层） */
export function parseMerchantSubmitBody(body: unknown): {
  channel: string;
  materials: Readonly<Record<string, unknown>>;
} {
  const raw = asObject(body);
  if (
    typeof raw['materials'] !== 'object' ||
    raw['materials'] === null ||
    Array.isArray(raw['materials'])
  ) {
    throw new AppError(ErrorCode.InvalidArgument, 'materials 须为 JSON 对象（键值不落日志）');
  }
  return {
    channel: parseChannel(raw['channel']),
    materials: raw['materials'] as Readonly<Record<string, unknown>>,
  };
}

/** POST /firms/{id}/merchant/change 体形状：{materials} */
export function parseMerchantChangeBody(body: unknown): {
  materials: Readonly<Record<string, unknown>>;
} {
  const raw = asObject(body);
  if (
    typeof raw['materials'] !== 'object' ||
    raw['materials'] === null ||
    Array.isArray(raw['materials'])
  ) {
    throw new AppError(ErrorCode.InvalidArgument, 'materials 须为 JSON 对象（键值不落日志）');
  }
  return { materials: raw['materials'] as Readonly<Record<string, unknown>> };
}

/** POST /firms/{id}/deposit/freeze 体形状：{lawyer_id, batch, amount?}（amount 缺省=配置 ⚠W3-D4） */
export function parseDepositFreezeBody(body: unknown): {
  lawyer_id: number;
  batch: string;
  amount?: Money;
} {
  const raw = asObject(body);
  if (typeof raw['batch'] !== 'string') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `batch 须为字符串：${JSON.stringify(raw['batch'])}`,
    );
  }
  let amount: Money | undefined;
  if (raw['amount'] !== undefined) {
    if (typeof raw['amount'] !== 'string') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `amount 须为两位小数字符串（Money 禁 float/number）：${JSON.stringify(raw['amount'])}`,
      );
    }
    amount = assertMoney(raw['amount']);
  }
  return {
    lawyer_id:
      typeof raw['lawyer_id'] === 'number'
        ? raw['lawyer_id']
        : parsePositiveInt(raw['lawyer_id'], 'lawyer_id'),
    batch: raw['batch'],
    amount,
  };
}
