import { describe, expect, it } from 'bun:test';
import { AppError, ErrorCode } from './error-codes';
import { assertMoney } from './money';

describe('assertMoney（NUMERIC(12,2) 字符串契约，架构 §1.3 金额禁 float）', () => {
  it.each([
    ['0.00'],
    ['0.01'],
    ['199.00'],
    ['1234567890.99'], // NUMERIC(12,2) 整数位上限 10 位
  ])('合法：%s 原样返回', (v) => {
    expect(assertMoney(v)).toBe(v);
  });

  it.each([
    ['100'], // 缺两位小数
    ['100.0'], // 一位小数
    ['100.000'], // 三位小数
    ['.50'], // 缺整数位
    ['0100.00'], // 前导零
    ['-1.00'], // 负数（方向由业务列表达，金额本身非负）
    ['1,000.00'], // 千分位
    ['１００．００'], // 全角
    ['abc'],
    [''],
    ['12345678901.00'], // 整数位 11 位，超 NUMERIC(12,2)
    ['NaN'],
    ['Infinity'],
  ])('非法：%s 抛 AppError(MoneyInvalidFormat, 422)', (v) => {
    let err: unknown;
    try {
      assertMoney(v);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.code).toBe(ErrorCode.MoneyInvalidFormat);
    expect(appErr.httpStatus).toBe(422);
    expect(appErr.message).toContain(String(v));
  });

  it('拒绝 number 类型入参（Money=string，pg NUMERIC 往返字符串）', () => {
    expect(() => assertMoney(199.0 as unknown as string)).toThrow(AppError);
  });
});
