/**
 * 日期/时间展示单一出口（M3-W1 T2 建/T4 扩展）：App 内一切时刻渲染必须经本件。
 *
 * 口径：架构 §1.3 时间一律 timestamptz（Asia/Shanghai）——格式化固定按上海时区
 * （中国无夏令时，与 core「上海日界」shanghaiDayStart 同源语义）；24 小时制（h23，
 * 不出现 24:00）；周几取 zh-CN 短周（周六）。非法时刻直接抛错（fail-visible，
 * 不静默渲染假时间）。
 */

const TZ_SHANGHAI = 'Asia/Shanghai';

interface DateParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly weekday: string;
  readonly hour: string;
  readonly minute: string;
}

function assertInstant(iso: string): void {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) {
    throw new Error(`非法时刻（期望 ISO 8601 字符串）：${JSON.stringify(iso)}`);
  }
}

/** 拆解为上海时区各段（formatToParts，避免 locale 连接符差异） */
function shanghaiParts(iso: string): DateParts {
  assertInstant(iso);
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ_SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(iso))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: parts['year'] ?? '',
    month: parts['month'] ?? '',
    day: parts['day'] ?? '',
    weekday: parts['weekday'] ?? '',
    hour: parts['hour'] ?? '',
    minute: parts['minute'] ?? '',
  };
}

/** '2026-10-16T12:32:00Z' → '10-16 周五 20:32'（opts.weekday=false 省略周几段） */
export function formatDateTime(iso: string, opts: { readonly weekday?: boolean } = {}): string {
  const p = shanghaiParts(iso);
  const weekday = (opts.weekday ?? true) && p.weekday ? ` ${p.weekday}` : '';
  return `${p.month}-${p.day}${weekday} ${p.hour}:${p.minute}`;
}

/** → '2026-10-16' */
export function formatDate(iso: string): string {
  const p = shanghaiParts(iso);
  return `${p.year}-${p.month}-${p.day}`;
}

/** → '2026-10-16 20:32'（完整年月日 + 时分） */
export function formatDateTimeFull(iso: string): string {
  const p = shanghaiParts(iso);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** → '10-16 20:32'（省年份短时：列表行时间注脚位；需年份语境用 formatDateTimeFull） */
export function formatMonthDayTime(iso: string): string {
  const p = shanghaiParts(iso);
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** → '20:32'（纯时分：时间表周视图时段标/行内时刻位——M3-W2 T2） */
export function formatTime(iso: string): string {
  const p = shanghaiParts(iso);
  return `${p.hour}:${p.minute}`;
}
