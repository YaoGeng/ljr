/**
 * D3 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字；room.http 同款收口）。
 *
 * id 解析收口 infrastructure/parse-positive-int（十进制 + MAX_SAFE_INTEGER 上限，缺省 0/
 * 非数字 → 400 E_INVALID_ARGUMENT，不漏成 500）；stats 窗口 from/to=YYYY-MM-DD（上海日界
 * 语义在服务面计算，此处只收形状）；错误体形态：infrastructure AppHttpExceptionFilter。
 */
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';

/** 路径参 enrollment_id（正整数收口；D2 §5 POST /enrollments/{id}/confirm-arrival） */
export function parseEnrollmentIdParam(raw: string): number {
  return parsePositiveInt(raw, 'enrollment_id');
}

/** 路径参 room_id（正整数收口；D3 §5 GET /rooms/{id}/attendance） */
export function parseRoomIdParam(raw: string): number {
  return parsePositiveInt(raw, 'room_id');
}

/** 查询参 from/to（YYYY-MM-DD 形状收口；语义校验=服务面上海日界窗口） */
export function parseStatsWindow(query: { from?: string; to?: string }): {
  from: string;
  to: string;
} {
  if (typeof query.from !== 'string' || typeof query.to !== 'string') {
    return { from: '', to: '' }; // 空串经服务面 400（单点校验，本件只收形状）
  }
  return { from: query.from, to: query.to };
}
