/**
 * B1 HTTP 面共用件：AppError → HTTP 错误体的模块内过滤器 + 请求形状解析（§5 契约词汇）。
 * 错误体形态与 identity/notify 同口径：{code, message}；域规则校验（R-03 双层等）在 service
 * ——本层只做形状/路径参数提取（parseSwitchRoleBody 薄形态先例）。
 */
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { ReplaceScheduleInput, TemplateWrite } from './time-table.types';

/** 结构化最小响应口（不引 express 类型依赖，identity.http 同口径） */
interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Catch(AppError)
export class TimeTableHttpExceptionFilter implements ExceptionFilter {
  catch(exception: AppError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    res.status(exception.httpStatus).json({ code: exception.code, message: exception.message });
  }
}

/** 路径参数 {id}：正整数（lawyer_id=identity 侧用户 id） */
export function parseLawyerId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `路径参数 id 须为正整数：${raw}`);
  }
  return id;
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
  return {
    version: raw.version as number,
    templates: raw.templates as readonly TemplateWrite[],
  };
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
