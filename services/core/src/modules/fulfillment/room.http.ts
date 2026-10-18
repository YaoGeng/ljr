/**
 * D1 HTTP 面共用件：请求形状解析（§5 契约词汇 snake_case 逐字）。
 *
 * close 无请求体（幂等键=session 即路径参）；id 解析收口 infrastructure/parse-positive-int
 * （十进制 + MAX_SAFE_INTEGER 上限，缺省 0/非数字 → 400 E_INVALID_ARGUMENT，不漏成 500）；
 * 错误体形态：infrastructure AppHttpExceptionFilter（{code, message}，全仓唯一过滤器）。
 * 开房端点（§5 POST /rooms/{session_id}/open）标注「job 内部」——不走 HTTP（执行器经
 * ScheduleExecutorRegistry 装配，I2 tick 驱动），本文件不承载其解析面。
 */
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';

/** 路径参 session_id（正整数收口） */
export function parseSessionIdParam(raw: string): number {
  return parsePositiveInt(raw, 'session_id');
}
