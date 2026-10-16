import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  assertQuestionTags,
  assertSpecialty,
  assertSubRange,
  splitShareCents,
} from './group-buy.types';

/**
 * C2 纯函数件（无需 PG）：R-02 分摊额 HALF_UP 除法（⚠W3-6 裁决：NUMERIC 除法保留 2 位 HALF_UP
 * ——PRD §9.2 无舍入定义，简报裁决口径，模块文档 §9「银行家舍入 ⚠待确认」按简报收口，任务报告
 * 偏差节注明）、R-01 子范围值域、E3 问题标签形态。金额全程整数分，禁 float。
 */
describe('C2 splitShareCents（R-02 分摊额=总价÷sub_min，HALF_UP 两位）', () => {
  it('整除：恰等无舍入（300.00÷2=150.00、90.00÷3=30.00）', () => {
    expect(splitShareCents(30_000, 2)).toBe(15_000);
    expect(splitShareCents(9_000, 3)).toBe(3_000);
  });

  it('亚半向下：100.00÷3 → 33.33（3333.33…→3333）；10.00÷3 → 3.33', () => {
    expect(splitShareCents(10_000, 3)).toBe(3_333);
    expect(splitShareCents(1_000, 3)).toBe(333);
  });

  it('过半向上：100.00÷6 → 16.67（1666.66…→1667）', () => {
    expect(splitShareCents(10_000, 6)).toBe(1_667);
  });

  it('恰半向上（HALF_UP 锚）：1.00÷8 → 0.13（12.5→13）；0.03÷2 → 0.02；0.01÷2 → 0.01（0.5→1）', () => {
    expect(splitShareCents(100, 8)).toBe(13);
    expect(splitShareCents(3, 2)).toBe(2);
    expect(splitShareCents(1, 2)).toBe(1);
  });

  it('舍入方向只看 sub_min 位除法余数：3.00÷4 → 0.75 整除；0.07÷3 → 0.02（2.33…→2）', () => {
    expect(splitShareCents(300, 4)).toBe(75);
    expect(splitShareCents(7, 3)).toBe(2);
  });

  it('非法入参显性化：非安全整数/非正 sub_min → InternalError（内部件不应触达）', () => {
    for (const [total, sub] of [
      [Number.MAX_SAFE_INTEGER + 1, 2],
      [-1, 2],
      [100, 0],
      [100, -3],
      [1.5, 2],
    ] as const) {
      expect(() => splitShareCents(total, sub)).toThrow(AppError);
      try {
        splitShareCents(total, sub);
        expect.unreachable('应抛 InternalError');
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.InternalError);
      }
    }
  });
});

describe('C2 assertSubRange（R-01 子范围值域：2..50 且 min≤max，应用层先行 400）', () => {
  it('合法：2..50 内任意 min≤max（含边界 2-2 / 50-50 / 2-50）', () => {
    expect(assertSubRange(2, 2)).toEqual({ sub_min: 2, sub_max: 2 });
    expect(assertSubRange(50, 50)).toEqual({ sub_min: 50, sub_max: 50 });
    expect(assertSubRange(3, 8)).toEqual({ sub_min: 3, sub_max: 8 });
  });

  it('越界矩阵（400）：min-1=1、max+1=51、非整数、min>max', () => {
    for (const [lo, hi] of [
      [1, 5], // min 下界外（R-W3-5 矩阵 min-1）
      [2, 51], // max 上界外（max+1）
      [5, 2], // min>max
      [3.5, 6], // 非整数
    ] as const) {
      expect(() => assertSubRange(lo, hi)).toThrow(AppError);
      try {
        assertSubRange(lo, hi);
        expect.unreachable('应抛 400');
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.InvalidArgument);
        expect((e as AppError).httpStatus).toBe(400);
      }
    }
  });
});

describe('C2 assertQuestionTags / assertSpecialty（形态收口 400）', () => {
  it('问题标签：字符串数组（1..64 字符/项，≤20 项）；空数组放行（⚠口径：PRD 未定最少条数，报告注明）', () => {
    expect(assertQuestionTags(['劳动仲裁时效', '违法解除赔偿'])).toEqual([
      '劳动仲裁时效',
      '违法解除赔偿',
    ]);
    expect(assertQuestionTags([])).toEqual([]);
    expect(() => assertQuestionTags('no' as unknown as string[])).toThrow(AppError);
    expect(() => assertQuestionTags([42] as unknown as string[])).toThrow(AppError);
    expect(() => assertQuestionTags([''])).toThrow(AppError);
    expect(() => assertQuestionTags(['x'.repeat(65)])).toThrow(AppError);
    expect(() => assertQuestionTags(Array.from({ length: 21 }, () => 'x'))).toThrow(AppError);
  });

  it('专项：1..32 字符（V1 仅 labor_arbitration 单专项，值域防御在应用层）', () => {
    expect(assertSpecialty('labor_arbitration')).toBe('labor_arbitration');
    expect(() => assertSpecialty('')).toThrow(AppError);
    expect(() => assertSpecialty('x'.repeat(33))).toThrow(AppError);
    expect(() => assertSpecialty(42 as unknown as string)).toThrow(AppError);
  });
});
