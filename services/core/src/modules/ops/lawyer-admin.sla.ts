/**
 * H1 R-01 审核 SLA 计算（纯函数，无 IO）：3 个工作日（周一至五）自 submitted_at 起算，
 * Asia/Shanghai 墙钟（UTC+8 恒定无夏令时）。deadline=submitted_at+3 工作日（同时刻），
 * 剩余=deadline−now（毫秒，负数=超时——工作台列表的告警数据位，H4 看板同源消费）。
 *
 * 口径注记（报告同款）：「3 工作日」按上海日历逐日推进、跳过周六日（跳过法定节假日=
 * M2+ 日历表适配位，本批按周一至五口径，文档 §7 R-01 原文「工作日」无节假日细化）；
 * 周末提交自下周一起算；时刻保持提交时刻的钟面值。
 */
import { AppError, ErrorCode } from '@ljr/shared';

/** 审核 SLA 工作日数（H1 §7 R-01：PRD §7.2.1 三个工作日） */
export const AUDIT_SLA_WORKING_DAYS = 3;

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/**
 * 上海墙钟加 n 个工作日（保持钟面时刻）：+8h 平移读墙钟逐日推进（getUTC* 读上海钟面），
 * 周六/周日不计，Date.UTC 规范化跨月/年，再 −8h 回 UTC。
 */
export function addWorkingDaysShanghai(from: Date, days: number): Date {
  if (!Number.isInteger(days) || days <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `工作日天数必须为正整数：${String(days)}`);
  }
  const sh = new Date(from.getTime() + SHANGHAI_OFFSET_MS);
  const y = sh.getUTCFullYear();
  const m = sh.getUTCMonth();
  let d = sh.getUTCDate();
  let added = 0;
  while (added < days) {
    d += 1;
    const dayOfWeek = new Date(Date.UTC(y, m, d)).getUTCDay(); // 0=周日..6=周六
    if (dayOfWeek >= 1 && dayOfWeek <= 5) added += 1;
  }
  const wallClock = Date.UTC(
    y,
    m,
    d,
    sh.getUTCHours(),
    sh.getUTCMinutes(),
    sh.getUTCSeconds(),
    sh.getUTCMilliseconds(),
  );
  return new Date(wallClock - SHANGHAI_OFFSET_MS);
}

/** SLA 剩余毫秒（负数=超时，告警数据位） */
export function slaRemainingMs(submittedAt: Date, now: Date): number {
  return addWorkingDaysShanghai(submittedAt, AUDIT_SLA_WORKING_DAYS).getTime() - now.getTime();
}
