/**
 * 时段输入解析（M3-W1 T3）：发团表单 'YYYY-MM-DD' + 'HH:mm'（上海墙钟语义）→ ISO 8601。
 *
 * 口径：架构 §1.3 时间一律 timestamptz（Asia/Shanghai，中国无夏令时）——表单按 +08:00
 * 偏移构造再 toISOString（core assertIsoDatetime 只要求 ISO 8601 可解析时刻，形态一致）。
 * 纯函数、无平台依赖，bun test 直测；非法输入返回 null（视图层转本地校验文案，不发坏请求）。
 */

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 输入是否为合法日期/时刻形态（不校验过去未来——业务时序由调用方判断） */
export function isValidDateInput(date: string): boolean {
  if (!DATE_SHAPE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m! - 1 && probe.getUTCDate() === d!
  );
}

export function isValidTimeInput(time: string): boolean {
  return TIME_SHAPE.test(time);
}

/** 'YYYY-MM-DD'+'HH:mm' → ISO 8601 UTC 字符串（+08:00 墙钟语义）；非法返回 null */
export function toShanghaiIso(date: string, time: string): string | null {
  if (!isValidDateInput(date) || !isValidTimeInput(time)) return null;
  const ms = Date.parse(`${date}T${time}:00+08:00`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** 时刻是否严格在未来（发团 slot_start 须晚于当前时刻——core R-W3-G ② 相关前置） */
export function isFutureInstant(iso: string): boolean {
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms > Date.now();
}
