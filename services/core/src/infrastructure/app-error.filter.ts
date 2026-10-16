/**
 * AppError → HTTP 错误体通用过滤器：{code, message}——全仓唯一 ExceptionFilter（G-B 做项1，6→1）。
 *
 * 曾有 6 份同形模块内过滤器（identity/notify/time-table + W1 遗留 specialty/rule/scheduler），
 * 行为逐字相同（无独有字段/日志差异），已全部删除并统一注册本件；pricing/credit 自 B3/G1 起
 * 即直用本件。行为口径：AppError → 其 httpStatus + {code, message}；非 AppError 不在本过滤器
 * 捕获面（@Catch(AppError)），走 Nest 内建兜底（500 通用体 + 框架日志），与收敛前一致。
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
