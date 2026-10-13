import { describe, expect, it } from 'bun:test';
import { AppError, ErrorCode, isAppError } from './error-codes';

describe('错误码契约（ErrorCode 常量表 + AppError{code,httpStatus}）', () => {
  it('错误码格式统一：E_ 前缀大写下划线，且全表唯一', () => {
    const codes = Object.values(ErrorCode);
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^E_[A-Z][A-Z0-9_]*$/);
    }
  });

  it('AppError 携带 code 与 httpStatus，且每个码有默认状态', () => {
    const e = new AppError(ErrorCode.StateIllegalTransition, 'DRAFT → DONE 未定义');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe(ErrorCode.StateIllegalTransition);
    expect(e.httpStatus).toBe(409);
    expect(e.message).toBe('DRAFT → DONE 未定义');
  });

  it('缺省 message 时回填默认文案', () => {
    const e = new AppError(ErrorCode.MoneyInvalidFormat);
    expect(e.message.length).toBeGreaterThan(0);
    expect(e.httpStatus).toBe(422);
  });

  it('显式 httpStatus 可覆盖默认（降级场景专用）', () => {
    const e = new AppError(ErrorCode.InternalError, '降级', 503);
    expect(e.httpStatus).toBe(503);
  });

  it('配置基座两码（M0-8）：缺失=500 fail-fast，非法（含密钥入文件）=500', () => {
    expect(ErrorCode.ConfigMissing).toBe('E_CONFIG_MISSING');
    expect(new AppError(ErrorCode.ConfigMissing).httpStatus).toBe(500);
    expect(ErrorCode.ConfigInvalid).toBe('E_CONFIG_INVALID');
    expect(new AppError(ErrorCode.ConfigInvalid).httpStatus).toBe(500);
  });

  it('isAppError 类型收窄', () => {
    expect(isAppError(new AppError(ErrorCode.Conflict))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError('string')).toBe(false);
  });
});
