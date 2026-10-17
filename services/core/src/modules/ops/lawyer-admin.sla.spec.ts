import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import { addWorkingDaysShanghai, slaRemainingMs } from './lawyer-admin.sla';

/**
 * H1 R-01 SLA 计算（纯函数，无 PG）：3 个工作日（周一至五，Asia/Shanghai 墙钟）自
 * submitted_at 起算；超时剩余为负（看板告警数据位）。
 * 锚定日期均取已核实星期：2026-10-14=周三、10-16=周五、10-17=周六、10-19=周一、10-21=周三。
 * 上海=UTC+8 恒定（无夏令时）：上海墙钟 10:00 = 02:00Z。
 */

describe('H1 R-01 SLA：3 工作日剩余计算（Asia/Shanghai，无 PG）', () => {
  it('addWorkingDaysShanghai：周三+3 工作日 → 下周一（跳过周末）；时刻保持到秒', () => {
    const wed = new Date('2026-10-14T02:00:00.000Z'); // 上海周三 10:00
    const deadline = addWorkingDaysShanghai(wed, 3); // 四五六？——周四(1)周五(2)周一(3)
    expect(deadline.toISOString()).toBe('2026-10-19T02:00:00.000Z'); // 下周一 10:00 上海
  });

  it('addWorkingDaysShanghai：周五晚间提交 → 下周三同时刻（多时点叙事锚点 10-16 周五 20:32）', () => {
    const fri = new Date('2026-10-16T12:32:00.000Z'); // 上海周五 20:32
    const deadline = addWorkingDaysShanghai(fri, 3); // 周一(1)周二(2)周三(3)
    expect(deadline.toISOString()).toBe('2026-10-21T12:32:00.000Z');
  });

  it('addWorkingDaysShanghai：周末提交 → 从下周一起算，仍得下周三；周日同周六', () => {
    const sat = new Date('2026-10-17T04:00:00.000Z'); // 上海周六 12:00
    expect(addWorkingDaysShanghai(sat, 3).toISOString()).toBe('2026-10-21T04:00:00.000Z');
    const sun = new Date('2026-10-18T04:00:00.000Z'); // 上海周日 12:00
    expect(addWorkingDaysShanghai(sun, 3).toISOString()).toBe('2026-10-21T04:00:00.000Z');
  });

  it('addWorkingDaysShanghai：跨月/年边界归一（1 月 30 日周五 +3 → 2 月 4 日周三）', () => {
    // 2026-01-30=周五（上海 09:00）；+3 工作日=2/2(一) 2/3(二) 2/4(三)
    const fri = new Date('2026-01-30T01:00:00.000Z');
    expect(addWorkingDaysShanghai(fri, 3).toISOString()).toBe('2026-02-04T01:00:00.000Z');
  });

  it('addWorkingDaysShanghai：非正整数天数 → 400 E_INVALID_ARGUMENT（防呆不下溢）', () => {
    const now = new Date('2026-10-14T02:00:00.000Z');
    for (const days of [0, -1, 1.5]) {
      expect(() => addWorkingDaysShanghai(now, days)).toThrowError(
        expect.objectContaining({ code: ErrorCode.InvalidArgument }) as AppError,
      );
    }
  });

  it('slaRemainingMs：剩余为正（deadline−now）；恰好超时即负（看板告警数据位）', () => {
    const submitted = new Date('2026-10-14T02:00:00.000Z'); // 周三 10:00 → deadline 下周一 10:00
    const thursday = new Date('2026-10-15T02:00:00.000Z');
    expect(slaRemainingMs(submitted, thursday)).toBe(4 * 86_400_000); // 恰 4 天

    const overdue = new Date('2026-10-19T02:00:00.001Z'); // 超时 1ms
    expect(slaRemainingMs(submitted, overdue)).toBe(-1);
  });

  it('slaRemainingMs：多时点叙事锚点——周五 20:32 提交、下周一 20:32 查询=剩余 2 工作日量级（正值）', () => {
    const submitted = new Date('2026-10-16T12:32:00.000Z'); // 周五 20:32
    const monday = new Date('2026-10-19T12:32:00.000Z'); // 下周一 20:32（房间锚点同刻）
    const remaining = slaRemainingMs(submitted, monday);
    expect(remaining).toBe(2 * 86_400_000); // deadline=下周三 20:32
  });
});
