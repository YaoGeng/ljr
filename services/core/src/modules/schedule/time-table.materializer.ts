/**
 * B1 物化算法（§4，纯函数——TDD 重心，用例见 time-table.materializer.spec）：
 * date + weekday 匹配 → slot_start = date AT TIME ZONE 'Asia/Shanghai' + start_time。
 *
 * 时区语义钉死 Asia/Shanghai（§4：DST 无影响，中国无夏令时——偏移恒 +08:00；经 Intl 动态取该
 * 时区偏移落成代码事实而非魔数，两遍收敛对任意 DST 时区也稳）。物化不落库（R-02）：候选只算不写，
 * 具体时刻的唯一占用由 B2 slot_locks 承载（§9 禁止：把模板当具体时刻锁定）。
 */
import type { SlotCandidate, SlotDuration } from './time-table.types';

/** 物化时区（§4 钉死；勿改——改即候选时刻全面漂移） */
export const SCHEDULE_TIMEZONE = 'Asia/Shanghai';

/** 物化输入模板的最小切面（enabled=false 不产候选——Task 4 简报裁决） */
export interface MaterializableTemplate {
  readonly id: number;
  readonly weekday: number;
  readonly startTime: string;
  readonly durationSmall: number;
  readonly enabled: boolean;
}

/** 某瞬间在时区的 UTC 偏移毫秒（含符号：墙钟 = UTC + offset） */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const partOf = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = dtf.formatToParts(instant).find((p) => p.type === type);
    return Number(part?.value);
  };
  const asUtc = Date.UTC(
    partOf('year'),
    partOf('month') - 1,
    partOf('day'),
    partOf('hour'),
    partOf('minute'),
    partOf('second'),
  );
  return asUtc - instant.getTime();
}

/**
 * 墙钟（时区本地日期+时刻）→ UTC 瞬间：两遍收敛（首遍以猜测瞬间取偏移，二遍以目标瞬间复核偏移；
 * Asia/Shanghai 恒 +08:00，一遍即稳定——DST 时区由二遍兜底折叠/空洞）。
 */
export function wallClockToInstant(date: string, time: string): Date {
  const naive = Date.parse(`${date}T${time}Z`);
  if (Number.isNaN(naive)) throw new RangeError(`非法日期/时刻：${date} ${time}`);
  const first = tzOffsetMs(new Date(naive), SCHEDULE_TIMEZONE);
  const offset = tzOffsetMs(new Date(naive - first), SCHEDULE_TIMEZONE);
  return new Date(naive - offset);
}

/** 日历日 weekday（0=周日..6=周六）：日历日本身无时区歧义，按 UTC 解析取 DOW */
export function weekdayOfDate(date: string): number {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`非法日期（须 YYYY-MM-DD 且真实存在）：${date}`);
  }
  return day.getUTCDay();
}

/**
 * 单日物化（§4）：weekday 匹配 + enabled 过滤 → 候选集。slotEnd = slotStart + durationSmall 分钟
 * （跨周边界在此显形）；同段多模板各自成候选（R-02：去重/唯一性不在 B1，B2 slot_locks 唯一防线兜底）。
 */
export function materializeDay(
  date: string,
  templates: readonly MaterializableTemplate[],
): SlotCandidate[] {
  const weekday = weekdayOfDate(date);
  return templates
    .filter((t) => t.enabled && t.weekday === weekday)
    .map((t) => {
      const slotStart = wallClockToInstant(date, t.startTime);
      const slotEnd = new Date(slotStart.getTime() + t.durationSmall * 60_000);
      return {
        templateId: t.id,
        slotStart,
        slotEnd,
        durationSmall: t.durationSmall as SlotDuration,
      };
    });
}
