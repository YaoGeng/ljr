import { describe, expect, it } from 'bun:test';
import { formatDate, formatDateTime, formatDateTimeFull, formatMonthDayTime } from './date';

// 时区锚点：架构 §1.3 时间一律 timestamptz（Asia/Shanghai）——展示层固定按上海时区格式化，
// 与 core「上海日界」口径一致（session.types shanghaiDayStart 同源语义）。
// 2026-10-16T12:32:00Z = 上海 2026-10-16 20:32 周五（原型多时点叙事 S-2041 同刻锚）。

describe('日期展示单一出口（ISO 时刻 → 上海时区人话）', () => {
  it('formatDateTime：月日 + 周几 + 24 制时分（上海时区）', () => {
    expect(formatDateTime('2026-10-16T12:32:00Z')).toBe('10-16 周五 20:32');
    expect(formatDateTime('2026-10-16T20:32:00+08:00')).toBe('10-16 周五 20:32'); // 同瞬间显式偏移形态
  });

  it('formatDateTime：UTC 跨日翻到上海次日（h23 制，不出现 24:00）', () => {
    expect(formatDateTime('2026-10-15T16:05:00Z')).toBe('10-16 周五 00:05');
  });

  it('formatDateTime：weekday=false 省略周几段', () => {
    expect(formatDateTime('2026-10-16T12:32:00Z', { weekday: false })).toBe('10-16 20:32');
  });

  it('formatDate / formatDateTimeFull：完整年月日形态', () => {
    expect(formatDate('2026-10-16T12:32:00Z')).toBe('2026-10-16');
    expect(formatDateTimeFull('2026-10-16T12:32:00Z')).toBe('2026-10-16 20:32');
  });

  it('formatMonthDayTime（T4）：省年份短时形态（上海时区 h23）', () => {
    expect(formatMonthDayTime('2026-10-16T12:32:00Z')).toBe('10-16 20:32');
    expect(formatMonthDayTime('2026-10-15T16:05:00Z')).toBe('10-16 00:05'); // UTC 跨日翻上海次日
  });

  it('非法时刻 → 抛错（fail-visible，不静默渲染假时间）', () => {
    expect(() => formatDateTime('not-a-date')).toThrow();
    expect(() => formatDate('')).toThrow();
  });
});
