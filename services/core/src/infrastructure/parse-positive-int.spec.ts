import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from './parse-positive-int';

/**
 * 横切十进制正整数解析器纯单测（不需 PG；G-B 收敛批）：
 * 仅接受纯十进制整数字符串——拒绝 0x10/1e2/科学计数/带符号/小数/空白/空串等 Number() 宽解析
 * 会误收的形态；上限 Number.MAX_SAFE_INTEGER（超限 400，防 PG bigint/int 越界 22003→500）。
 * B1 parseLawyerId / B3 parseLawyerId / G1 parseOwnerId 三处模块实现统一收口于此（G-B 做项 4）。
 */
describe('parsePositiveInt：十进制正整数字符串严格解析（400 E_INVALID_ARGUMENT）', () => {
  it('纯十进制正整数字符串 → 数值（上限内）', () => {
    expect(parsePositiveInt('1', 'id')).toBe(1);
    expect(parsePositiveInt('601', 'owner_id')).toBe(601);
    expect(parsePositiveInt(String(Number.MAX_SAFE_INTEGER), 'id')).toBe(9_007_199_254_740_991);
  });

  it('拒 0x10 / 1e2 / 科学计数 / 带符号 / 小数 / 空白 / 空串 / 非字符串 → 400', () => {
    for (const bad of [
      '0x10',
      '1e2',
      '1E2',
      '+1',
      '-1',
      '1.5',
      ' 1',
      '1 ',
      '',
      '1_0',
      null,
      undefined,
      12,
    ]) {
      expect(() => parsePositiveInt(bad as string, 'id')).toThrowError(AppError);
      try {
        parsePositiveInt(bad as string, 'id');
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.InvalidArgument);
        expect((e as AppError).httpStatus).toBe(400);
      }
    }
  });

  it('拒 0 与全零形态（正整数不含 0）→ 400', () => {
    for (const zero of ['0', '00', '000']) {
      expect(() => parsePositiveInt(zero, 'id')).toThrowError(AppError);
    }
  });

  it('超长数字（> MAX_SAFE_INTEGER）→ 400 而非静默精度丢失/下游 22003→500', () => {
    for (const huge of ['9007199254740993', '99999999999999999999']) {
      expect(() => parsePositiveInt(huge, 'id')).toThrowError(AppError);
      try {
        parsePositiveInt(huge, 'id');
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.InvalidArgument);
        expect((e as AppError).httpStatus).toBe(400);
      }
    }
  });

  it('错误消息带字段名与原值（运维可读）', () => {
    expect(() => parsePositiveInt('0x10', '路径参数 id')).toThrowError(/路径参数 id/);
    expect(() => parsePositiveInt('0x10', '路径参数 id')).toThrowError(/0x10/);
  });
});
