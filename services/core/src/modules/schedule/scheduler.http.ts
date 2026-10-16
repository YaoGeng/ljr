/**
 * I2 HTTP 面共用件：运维视图入参解析（§5）。
 * 错误体过滤器已收敛至 infrastructure 的 AppHttpExceptionFilter（G-B 做项1，6→1；
 * 错误体形态 {code, message} 不变）。
 * 后台鉴权 ⚠决策位：admin 角色鉴权随 H1/H2（W2+）接入后替换，本批次只交付接口形态。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { isScheduleJobType, type ScheduleJobType } from './scheduler.catalog';
import type { ScheduleJobStatus } from './scheduler.types';

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
