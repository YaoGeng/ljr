/**
 * I2 HTTP 面共用件：AppError → HTTP 错误体的模块内过滤器 + 运维视图入参解析（§5）。
 * 后台鉴权 ⚠决策位：admin 角色鉴权随 H1/H2（W2+）接入后替换，本批次只交付接口形态。
 */
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { isScheduleJobType, type ScheduleJobType } from './scheduler.catalog';
import type { ScheduleJobStatus } from './scheduler.types';

/** 结构化最小响应口（不引 express 类型依赖，notify.http 同口径） */
interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Catch(AppError)
export class SchedulerHttpExceptionFilter implements ExceptionFilter {
  catch(exception: AppError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    res.status(exception.httpStatus).json({ code: exception.code, message: exception.message });
  }
}

const JOB_STATUSES: readonly ScheduleJobStatus[] = [
  'PENDING',
  'RUNNING',
  'DONE',
  'CANCELLED',
  'FAILED',
];

export function parseJobStatus(raw: string | undefined): ScheduleJobStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(JOB_STATUSES as readonly string[]).includes(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `status 须为 ${JOB_STATUSES.join('|')}：${JSON.stringify(raw)}`,
    );
  }
  return raw as ScheduleJobStatus;
}

export function parseJobType(raw: string | undefined): ScheduleJobType | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!isScheduleJobType(raw)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `type 不在 job 全集注册表（I2 §2/§4）：${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

export function parseJobLimit(raw: string | undefined, fallback = 100, max = 500): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `limit 须为 1-${max} 整数：${JSON.stringify(raw)}`,
    );
  }
  return n;
}
