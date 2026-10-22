import { describe, expect, it } from 'bun:test';
import { isDirtySchedule, type ScheduleEditRow } from './schedule-edit';

const VIEW = {
  version: 2,
  templates: [
    { id: 11, weekday: 1, start_time: '19:00:00', duration_small: 90, enabled: true },
    { id: 12, weekday: 5, start_time: '20:00:00', duration_small: 60, enabled: false },
  ],
} as const;

/** 服务端视图 → 编辑行形态（screen 同款映射：start_time 截短为 HH:MM） */
function rowsOf(templates: readonly (typeof VIEW.templates)[number][]): ScheduleEditRow[] {
  return templates.map((t) => ({
    localId: t.id,
    weekday: t.weekday,
    startTime: t.start_time.slice(0, 5),
    duration: t.duration_small,
    enabled: t.enabled,
  }));
}

describe('isDirtySchedule（时间表 dirty 判定：编辑集 vs 服务端模板集多重集比较）', () => {
  it('一致（含 disabled/enabled 与时长逐键）→ clean', () => {
    expect(isDirtySchedule(rowsOf(VIEW.templates), VIEW as never)).toBe(false);
  });

  it('顺序无关：编辑行乱序但同集 → clean（新增行追加尾部不误报）', () => {
    const rows = rowsOf(VIEW.templates);
    const reordered = [rows[1]!, rows[0]!];
    expect(isDirtySchedule(reordered, VIEW as never)).toBe(false);
  });

  it('新增一行 → dirty', () => {
    const rows: ScheduleEditRow[] = [
      ...rowsOf(VIEW.templates),
      { localId: 99, weekday: 3, startTime: '09:30', duration: 60, enabled: true },
    ];
    expect(isDirtySchedule(rows, VIEW as never)).toBe(true);
  });

  it('改时刻/切时长/启停/删行 → dirty（逐键敏感）', () => {
    const base = rowsOf(VIEW.templates);
    const withTime: ScheduleEditRow[] = base.map((r, i) =>
      i === 0 ? { ...r, startTime: '19:30' } : r,
    );
    expect(isDirtySchedule(withTime, VIEW as never)).toBe(true);
    const withDuration: ScheduleEditRow[] = base.map((r, i) =>
      i === 0 ? { ...r, duration: 120 } : r,
    );
    expect(isDirtySchedule(withDuration, VIEW as never)).toBe(true);
    const withEnabled: ScheduleEditRow[] = base.map((r, i) =>
      i === 1 ? { ...r, enabled: true } : r,
    );
    expect(isDirtySchedule(withEnabled, VIEW as never)).toBe(true);
    expect(isDirtySchedule(base.slice(0, 1), VIEW as never)).toBe(true);
  });
});
