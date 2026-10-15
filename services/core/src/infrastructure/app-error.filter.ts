/**
 * AppError → HTTP 错误体通用过滤器：{code, message}。
 *
 * identity.http / notify.http / time-table.http 各有一份同形模块内过滤器（已成终审 triage 项：
 * 「下沉 infrastructure 或明确保留三份」）；B3 起新模块直用本件，既有三份由终审裁决统一收敛，
 * 本文件不改动既有模块。
 */
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AppError } from '@ljr/shared';

/** 结构化最小响应口（不引 express 类型依赖，既有过滤器同口径） */
interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Catch(AppError)
export class AppHttpExceptionFilter implements ExceptionFilter {
  catch(exception: AppError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    res.status(exception.httpStatus).json({ code: exception.code, message: exception.message });
  }
}
