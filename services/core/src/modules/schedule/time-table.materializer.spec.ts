import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_TIMEZONE,
  materializeDay,
  wallClockToInstant,
  weekdayOfDate,
} from './time-table.materializer';
import type { MaterializableTemplate } from './time-table.materializer';

/**
 * B1 物化算法纯函数单测（§4/§9 TDD 重心，不需 PG）：
 * 用例集把「slot_start = date AT TIME ZONE 'Asia/Shanghai' + start_time」的时区语义与
 * 跨周边界（周日 23:30+60min→次日 / 月末 / 年初）、enabled=false 不产候选（简报裁决）、
 * R-02（模板不参与唯一约束——同段多模板各自成候选）钉死。
 */

const tpl = (over: Partial<MaterializableTemplate>): MaterializableTemplate => ({
  id: 1,
  weekday: 0,
  startTime: '10:00:00',
  durationSmall: 60,
  enabled: true,
  ...over,
});

describe('B1 物化算法（纯函数，§4）', () => {
  it('Asia/Shanghai 语义钉死：2026-11-01 00:00 上海 = UTC 2026-10-31T16:00Z（≠ UTC 日界）', () => {
    expect(SCHEDULE_TIMEZONE).toBe('Asia/Shanghai');
    expect(wallClockToInstant('2026-11-01', '00:00:00').toISOString()).toBe(
      '2026-10-31T16:00:00.000Z',
    );
  });

  it('跨周边界（§10-1）：周日 23:30 + 60min → slotEnd 落次日（周一）00:30', () => {
    expect(weekdayOfDate('2026-11-01')).toBe(0); // 2026-11-01 = 周日
    const start = wallClockToInstant('2026-11-01', '23:30:00');
    expect(start.toISOString()).toBe('2026-11-01T15:30:00.000Z');
    const end = new Date(start.getTime() + 60 * 60_000);
    // 上海墙钟 2026-11-02（周一）00:30 —— 跨周边界在 slotEnd 显形
    expect(end.toISOString()).toBe('2026-11-01T16:30:00.000Z');
    expect(weekdayOfDate('2026-11-02')).toBe(1);
  });

  it('月末跨界：2026-11-30（周一）23:30 + 120min → 12-01 01:30（上海）', () => {
    expect(weekdayOfDate('2026-11-30')).toBe(1);
    const start = wallClockToInstant('2026-11-30', '23:30:00');
    expect(start.toISOString()).toBe('2026-11-30T15:30:00.000Z');
    const end = new Date(start.getTime() + 120 * 60_000);
    expect(end.toISOString()).toBe('2026-11-30T17:30:00.000Z'); // 上海 2026-12-01 01:30
  });

  it('年初跨界：2026-12-31（周四）23:30 + 90min → 次年 01-01 01:00（上海）', () => {
    expect(weekdayOfDate('2026-12-31')).toBe(4);
    const start = wallClockToInstant('2026-12-31', '23:30:00');
    expect(start.toISOString()).toBe('2026-12-31T15:30:00.000Z');
    const end = new Date(start.getTime() + 90 * 60_000);
    expect(end.toISOString()).toBe('2026-12-31T17:00:00.000Z'); // 上海 2027-01-01 01:00
  });

  it('weekdayOfDate：2026-11-01=周日(0) … 2026-11-07=周六(6) 全周连续', () => {
    for (let d = 1; d <= 7; d += 1) {
      const date = `2026-11-0${d}`;
      expect(weekdayOfDate(date)).toBe(d - 1);
    }
  });

  it('weekday 匹配 + enabled=false 不产候选（简报裁决）', () => {
    const templates = [
      tpl({ id: 11, weekday: 0 }), // 周日匹配
      tpl({ id: 12, weekday: 1 }), // 周一不匹配
      tpl({ id: 13, weekday: 0, enabled: false }), // 匹配但禁用 → 不产候选
    ];
    const out = materializeDay('2026-11-01', templates);
    expect(out).toHaveLength(1);
    expect(out[0]!.templateId).toBe(11);
    expect(out[0]!.slotStart.toISOString()).toBe('2026-11-01T02:00:00.000Z'); // 上海 10:00
  });

  it('R-02：同段多模板各自成候选（模板不参与唯一约束）；durationSmall 随行', () => {
    const out = materializeDay('2026-11-01', [
      tpl({ id: 21, weekday: 0, startTime: '09:00:00', durationSmall: 60 }),
      tpl({ id: 22, weekday: 0, startTime: '09:00:00', durationSmall: 90 }), // 同段不同时长
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.slotStart.toISOString())).toEqual([
      '2026-11-01T01:00:00.000Z',
      '2026-11-01T01:00:00.000Z',
    ]);
    expect(out.map((c) => c.durationSmall)).toEqual([60, 90]);
    expect(out.map((c) => c.slotEnd.toISOString())).toEqual([
      '2026-11-01T02:00:00.000Z',
      '2026-11-01T02:30:00.000Z',
    ]);
  });

  it('非法日期/时刻显性抛错（RangeError，不静默产出错误候选）', () => {
    expect(() => weekdayOfDate('2026-02-30')).toThrow(RangeError);
    expect(() => wallClockToInstant('2026-11-01', '25:00:00')).toThrow(RangeError);
  });
});
