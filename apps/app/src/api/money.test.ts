import { describe, expect, it } from 'bun:test';
import { AppError, ErrorCode } from '@ljr/shared';
import { formatMoney, isValidMoney, splitMoney, type Money } from './money';

describe('money 展示单一出口（shared NUMERIC(12,2) 字符串，禁浮点）', () => {
  it('formatMoney：¥ 符 + 千分位 + 两位小数（纯字符串运算）', () => {
    expect(formatMoney('1234567.89' as Money)).toBe('¥1,234,567.89');
    expect(formatMoney('199.00' as Money)).toBe('¥199.00');
    expect(formatMoney('0.05' as Money)).toBe('¥0.05');
    expect(formatMoney('1234.50' as Money, { symbol: false, group: false })).toBe('1234.50');
  });

  it('splitMoney：价格数字拆段（int/dec 供红点缀排版）', () => {
    expect(splitMoney('98765.40' as Money)).toEqual({
      symbol: '¥',
      int: '98,765',
      decWithDot: '.40',
    });
  });

  it('非法金额（缺小数/负数/number）→ isValidMoney=false，格式化抛 AppError(E_MONEY_INVALID)', () => {
    expect(isValidMoney('199.0')).toBe(false);
    expect(isValidMoney('-1.00')).toBe(false);
    expect(isValidMoney(199)).toBe(false);
    let thrown: unknown = null;
    try {
      formatMoney('199.9' as unknown as Money);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(ErrorCode.MoneyInvalidFormat);
  });
});
