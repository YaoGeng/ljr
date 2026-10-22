import { describe, expect, it } from 'bun:test';
import {
  findTemplateOverlaps,
  isFutureInstant,
  isValidDateInput,
  isValidTimeInput,
  templateCrossesMidnight,
  templatesOverlap,
  timeToMinutes,
  toShanghaiIso,
} from './slot-input';

describe('时段输入解析（上海墙钟 → ISO 8601）', () => {
  it('合法输入：+08:00 语义构造后转 UTC ISO（20:00 上海=12:00Z；跨年日界）', () => {
    expect(toShanghaiIso('2026-12-18', '20:00')).toBe('2026-12-18T12:00:00.000Z');
    expect(toShanghaiIso('2026-01-01', '00:05')).toBe('2025-12-31T16:05:00.000Z');
  });

  it('日期真实存在性校验（2026-02-30 非法）', () => {
    expect(isValidDateInput('2026-02-28')).toBe(true);
    expect(isValidDateInput('2026-02-30')).toBe(false);
    expect(isValidDateInput('2026-2-28')).toBe(false); // 形态须补零
  });

  it('时刻形态：24:00 拒绝（h23 口径）、25:00/9:30 拒绝', () => {
    expect(isValidTimeInput('23:59')).toBe(true);
    expect(isValidTimeInput('00:00')).toBe(true);
    expect(isValidTimeInput('24:00')).toBe(false);
    expect(isValidTimeInput('9:30')).toBe(false);
  });

  it('非法组合返回 null（缺时间/月份越界）', () => {
    expect(toShanghaiIso('2026-13-01', '10:00')).toBeNull();
    expect(toShanghaiIso('2026-12-18', '')).toBeNull();
  });

  it('isFutureInstant：过去时刻 false、未来 true（ISO 解析失败 false）', () => {
    expect(isFutureInstant('2000-01-01T00:00:00.000Z')).toBe(false);
    expect(isFutureInstant('2099-01-01T00:00:00.000Z')).toBe(true);
    expect(isFutureInstant('not-a-date')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 周模板时段校验（M3-W2 T2 时间表编辑表单：重叠/跨天——core normalizeTemplate 无此二检，
// 属前端表单防呆层；过去时段=周视图 slot_start 经 isFutureInstant（上文已测））
// ---------------------------------------------------------------------------

describe('周模板时段校验（timeToMinutes / 跨天 / 重叠）', () => {
  it('timeToMinutes：HH:MM 与 HH:MM:SS 归一到分钟数；非法形态 null', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('23:59:59')).toBe(1439);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('24:00')).toBeNull();
    expect(timeToMinutes('9:30')).toBeNull();
    expect(timeToMinutes('')).toBeNull();
  });

  it('跨天检测：23:30+120 跨午夜 true；22:00+120（恰至 24:00）false；23:59+60 true', () => {
    expect(templateCrossesMidnight('23:30', 120)).toBe(true);
    expect(templateCrossesMidnight('22:00', 120)).toBe(false); // 22:00+120=24:00 恰不越界
    expect(templateCrossesMidnight('23:59', 60)).toBe(true);
    expect(templateCrossesMidnight('08:00', 90)).toBe(false);
  });

  it('同日重叠：区间相交 true；首尾相接（19:00+60 与 20:00）false', () => {
    expect(
      templatesOverlap(
        { weekday: 1, start_time: '19:00', duration_small: 90 },
        { weekday: 1, start_time: '20:00', duration_small: 60 },
      ),
    ).toBe(true); // 19:00-20:30 ∩ 20:00-21:00
    expect(
      templatesOverlap(
        { weekday: 1, start_time: '19:00', duration_small: 60 },
        { weekday: 1, start_time: '20:00', duration_small: 60 },
      ),
    ).toBe(false); // [19:00,20:00) 与 [20:00,21:00) 半开区间相接不重叠
    expect(
      templatesOverlap(
        { weekday: 1, start_time: '09:00', duration_small: 60 },
        { weekday: 2, start_time: '09:00', duration_small: 60 },
      ),
    ).toBe(false); // 异日不比
  });

  it('findTemplateOverlaps：返回冲突索引对（含被包含/交叉组）；无冲突空数组', () => {
    const templates = [
      { weekday: 1, start_time: '09:00', duration_small: 90 }, // 0
      { weekday: 1, start_time: '10:00', duration_small: 60 }, // 1 与 0 重叠
      { weekday: 1, start_time: '09:30', duration_small: 60 }, // 2 与 0 重叠（含于 0-1 交）
      { weekday: 3, start_time: '09:00', duration_small: 60 }, // 3 无冲突
    ] as const;
    const pairs = findTemplateOverlaps(templates);
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([0, 2]);
    expect(pairs).toContainEqual([1, 2]); // 1 与 2 亦交叠（10:00-11:00 ∩ 09:30-10:30）
    expect(pairs).toHaveLength(3);
    expect(findTemplateOverlaps([{ weekday: 5, start_time: '20:00', duration_small: 60 }])).toEqual(
      [],
    );
  });
});
