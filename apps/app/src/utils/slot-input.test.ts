import { describe, expect, it } from 'bun:test';
import { isFutureInstant, isValidDateInput, isValidTimeInput, toShanghaiIso } from './slot-input';

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
