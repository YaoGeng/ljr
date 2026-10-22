/**
 * 时段输入解析（M3-W1 T3 建/M3-W2 T2 扩）：发团表单 'YYYY-MM-DD' + 'HH:mm'（上海墙钟
 * 语义）→ ISO 8601；周模板时段校验（timeToMinutes/跨天/重叠——时间表编辑表单防呆层）。
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

/** 时刻是否严格在未来（发团 slot_start 须晚于当前时刻——core R-W3-G ② 相关前置；
 *  M3-W2 T2 复用位：时间表周视图过去时段置灰/不可选） */
export function isFutureInstant(iso: string): boolean {
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms > Date.now();
}

// ---------------------------------------------------------------------------
// 周模板时段校验（M3-W2 T2 时间表编辑表单）：重叠/跨天为前端表单防呆层——
// core normalizeTemplate 只校验值域（weekday/start_time/duration 三档），无此二检；
// 过去时段对按周重复模板不适用（周视图 slot_start 过去判定经 isFutureInstant，上文）
// ---------------------------------------------------------------------------

const DAY_MINUTES = 24 * 60;

/** 'HH:MM' / 'HH:MM:SS' → 当日分钟数（上海墙钟语义，跨日不进位）；非法返回 null */
export function timeToMinutes(time: string): number | null {
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  const [h, m, s] = time.split(':').map(Number) as [number, number, number?];
  if (h > 23 || m > 59 || (s ?? 0) > 59) return null;
  return h * 60 + m;
}

/** 模板时段是否跨过午夜（start+duration > 24:00，如 23:30+120min → 次日 01:30） */
export function templateCrossesMidnight(startTime: string, durationSmall: number): boolean {
  const start = timeToMinutes(startTime);
  if (start === null) return false; // 形态非法由表单 time 校验位报错，本检不重复报
  return start + durationSmall > DAY_MINUTES;
}

/** 模板时段形状（校验只取三键——id/enabled 不参与区间计算） */
export interface TemplateRangeInput {
  readonly weekday: number;
  readonly start_time: string;
  readonly duration_small: number;
}

/** 同 weekday 两模板区间是否重叠（半开区间 [start, start+duration)——首尾相接不重叠） */
export function templatesOverlap(a: TemplateRangeInput, b: TemplateRangeInput): boolean {
  if (a.weekday !== b.weekday) return false;
  const sa = timeToMinutes(a.start_time);
  const sb = timeToMinutes(b.start_time);
  if (sa === null || sb === null) return false; // 形态非法由字段级校验位承载
  return sa < sb + b.duration_small && sb < sa + a.duration_small;
}

/** 模板清单内全部重叠对（索引升序对 [i,j]，i<j——供表单行标红与阻止提交） */
export function findTemplateOverlaps(
  templates: readonly TemplateRangeInput[],
): Array<readonly [number, number]> {
  const pairs: Array<readonly [number, number]> = [];
  for (let i = 0; i < templates.length; i++) {
    for (let j = i + 1; j < templates.length; j++) {
      if (templatesOverlap(templates[i]!, templates[j]!)) pairs.push([i, j] as const);
    }
  }
  return pairs;
}
