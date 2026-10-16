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

  it('A1 身份错误码（M1-W2 §5）：限频 429 / 验证码与登录态 401 / 角色与封禁 403 / 年龄声明 400', () => {
    expect(ErrorCode.RateLimited).toBe('E_RATE_LIMITED');
    expect(new AppError(ErrorCode.RateLimited).httpStatus).toBe(429);
    expect(ErrorCode.CodeInvalid).toBe('E_CODE_INVALID');
    expect(new AppError(ErrorCode.CodeInvalid).httpStatus).toBe(401);
    expect(ErrorCode.RefreshExpired).toBe('E_REFRESH_EXPIRED');
    expect(new AppError(ErrorCode.RefreshExpired).httpStatus).toBe(401);
    expect(ErrorCode.RoleNotHeld).toBe('E_ROLE_NOT_HELD');
    expect(new AppError(ErrorCode.RoleNotHeld).httpStatus).toBe(403);
    expect(ErrorCode.AgeDeclarationRequired).toBe('E_AGE_DECLARATION_REQUIRED');
    expect(new AppError(ErrorCode.AgeDeclarationRequired).httpStatus).toBe(400);
    expect(ErrorCode.AccountBanned).toBe('E_ACCOUNT_BANNED');
    expect(new AppError(ErrorCode.AccountBanned).httpStatus).toBe(403);
    expect(ErrorCode.RoleForbidden).toBe('E_ROLE_FORBIDDEN');
    expect(new AppError(ErrorCode.RoleForbidden).httpStatus).toBe(403);
    expect(ErrorCode.Unauthorized).toBe('E_UNAUTHORIZED');
    expect(new AppError(ErrorCode.Unauthorized).httpStatus).toBe(401);
  });

  it('A2 实名与同意错误码（M1-W2 §5）：证件形态 400 / 版本不一致 409 / 解密未审批 403', () => {
    expect(ErrorCode.InvalidId).toBe('E_INVALID_ID');
    expect(new AppError(ErrorCode.InvalidId).httpStatus).toBe(400);
    expect(ErrorCode.VersionMismatch).toBe('E_VERSION_MISMATCH');
    expect(new AppError(ErrorCode.VersionMismatch).httpStatus).toBe(409);
    expect(ErrorCode.NotApproved).toBe('E_NOT_APPROVED');
    expect(new AppError(ErrorCode.NotApproved).httpStatus).toBe(403);
  });

  it('B3 价格配置错误码（M1-W2 §5）：区间越界 400 / 在团修改 409', () => {
    expect(ErrorCode.PriceOutOfRange).toBe('E_OUT_OF_RANGE');
    expect(new AppError(ErrorCode.PriceOutOfRange).httpStatus).toBe(400);
    expect(ErrorCode.InGroupChange).toBe('E_IN_GROUP_CHANGE');
    expect(new AppError(ErrorCode.InGroupChange).httpStatus).toBe(409);
  });

  it('F1 支付网关错误码（M1-W3 §5）：幂等键同键异载荷 409 / 余额不足 400 / 验签失败 403 / 双通道全故障 503', () => {
    expect(ErrorCode.PaymentDuplicateKey).toBe('E_DUP_KEY');
    expect(new AppError(ErrorCode.PaymentDuplicateKey).httpStatus).toBe(409);
    expect(ErrorCode.InsufficientFunds).toBe('E_INSUFFICIENT');
    expect(new AppError(ErrorCode.InsufficientFunds).httpStatus).toBe(400);
    expect(ErrorCode.SignVerificationFailed).toBe('E_SIGN_FAIL');
    expect(new AppError(ErrorCode.SignVerificationFailed).httpStatus).toBe(403);
    expect(ErrorCode.ChannelUnavailable).toBe('E_CHANNEL_UNAVAILABLE');
    expect(new AppError(ErrorCode.ChannelUnavailable).httpStatus).toBe(503);
  });

  it('isAppError 类型收窄', () => {
    expect(isAppError(new AppError(ErrorCode.Conflict))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError('string')).toBe(false);
  });
});
