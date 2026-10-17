/**
 * C2 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * 形状与类型收口（缺字段/类型错 → 400 E_INVALID_ARGUMENT，不漏成 500）；值域/形态校验在服务层
 * （assertSpecialty/assertSubRange/assertQuestionTags——解析器只做「形状与类型」，session.http
 * 同口径）；id 解析收口 infrastructure/parse-positive-int（十进制 + MAX_SAFE_INTEGER 上限）；
 * 错误体形态：infrastructure AppHttpExceptionFilter（{code, message}，全仓唯一过滤器）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import { assertIsoDatetime } from './session.types';

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象');
  }
  return body as Record<string, unknown>;
}

/** bigint 裸引用/计数字段（lawyer_id/sub_min/sub_max）：JSON number 或十进制数字符串（payment.http 同口径） */
function parseBigintId(v: unknown, field: string): number {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
      throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数：${JSON.stringify(v)}`);
    }
    return v;
  }
  return parsePositiveInt(v, field);
}

/** POST /group-buys 体形状：{lawyer_id, specialty, slot_start, sub_min, sub_max, question_tags, deadline?}
 *  （值域/形态校验收敛在服务层 resolvePublishPlan；question_tags 项级校验=assertQuestionTags，
 *  解析器只钉「须为数组」形状——返回类型即窄类型先例） */
export function parseGroupBuyBody(body: unknown): {
  lawyer_id: number;
  specialty: string;
  slot_start: Date;
  sub_min: number;
  sub_max: number;
  question_tags: string[];
  deadline?: Date;
} {
  const raw = asObject(body);
  if (typeof raw['specialty'] !== 'string') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `specialty 须为字符串：${JSON.stringify(raw['specialty'])}`,
    );
  }
  if (!Array.isArray(raw['question_tags'])) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `question_tags 须为数组：${JSON.stringify(raw['question_tags'])}`,
    );
  }
  const out = {
    lawyer_id: parseBigintId(raw['lawyer_id'], 'lawyer_id'),
    specialty: raw['specialty'],
    slot_start: assertIsoDatetime(raw['slot_start'], 'slot_start'),
    sub_min: parseBigintId(raw['sub_min'], 'sub_min'),
    sub_max: parseBigintId(raw['sub_max'], 'sub_max'),
    question_tags: raw['question_tags'] as string[],
  };
  if (raw['deadline'] !== undefined) {
    return { ...out, deadline: assertIsoDatetime(raw['deadline'], 'deadline') };
  }
  return out;
}

/** GET /group-buys 查询形状：?specialty=&city=（缺省=不过滤；城市维=序 11.5） */
export function parseGroupBuyListQuery(query: Record<string, unknown>): {
  specialty?: string;
  city?: string;
} {
  const specialty = query['specialty'];
  if (specialty !== undefined && (typeof specialty !== 'string' || specialty === '')) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `specialty 须为非空字符串：${JSON.stringify(specialty)}`,
    );
  }
  const city = query['city'];
  if (city !== undefined && (typeof city !== 'string' || city === '')) {
    throw new AppError(ErrorCode.InvalidArgument, `city 须为非空字符串：${JSON.stringify(city)}`);
  }
  return {
    ...(specialty === undefined ? {} : { specialty }),
    ...(city === undefined ? {} : { city }),
  };
}
