/**
 * B1 HTTP 面共用件：请求形状解析（§5 契约词汇）。
 * 错误体过滤器已收敛至 infrastructure 的 AppHttpExceptionFilter（G-B 做项1，6→1）；
 * 域规则校验（R-03 双层等）在 service——本层只做形状/路径参数提取（parseSwitchRoleBody
 * 薄形态先例）；模板元素对象形态闸在 parseReplaceScheduleBody（G-B 做项5：malformed 元素
 * 不再漏成 500）；路径 id 严格解析统一走 infrastructure/parse-positive-int（G-B 做项4）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import type { ReplaceScheduleInput, TemplateWrite } from './time-table.types';

/** 路径参数 {id}：十进制正整数（lawyer_id=identity 侧用户 id；拒 0x10/1e2/超长形态） */
export function parseLawyerId(raw: string): number {
  return parsePositiveInt(raw, '路径参数 id');
}

/** PUT /lawyer/schedule 体形状：{version, templates[]}（域校验在 service——R-03 应用校验层） */
export function parseReplaceScheduleBody(body: unknown): ReplaceScheduleInput {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {version, templates}');
  }
  const raw = body as { version?: unknown; templates?: unknown };
  if (!Array.isArray(raw.templates)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      'templates 须为数组（全量替换语义，空数组=清空时间表）',
    );
  }
  // 元素级对象形态闸（G-B 做项5）：null/标量元素原会漏进 service 在属性访问处 TypeError→500，
  // 本层显性 400；元素内字段域校验（缺字段/错型/越界）仍归 service（R-03 应用校验层，同 400）。
  const templates = raw.templates.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `templates 元素须为对象 {weekday, start_time, duration_small, enabled?}：${JSON.stringify(item)}`,
      );
    }
    return item as TemplateWrite;
  });
  return { version: raw.version as number, templates };
}

/** GET /lawyer/{id}/slots query 形状：from/to（YYYY-MM-DD 合法性在 service） */
export function parseSlotRangeQuery(query: unknown): { from: string; to: string } {
  if (typeof query !== 'object' || query === null) {
    throw new AppError(ErrorCode.InvalidArgument, 'query 须含 from 与 to（YYYY-MM-DD）');
  }
  const from = (query as { from?: unknown }).from;
  const to = (query as { to?: unknown }).to;
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, 'query 须含 from 与 to（YYYY-MM-DD）');
  }
  return { from, to };
}
