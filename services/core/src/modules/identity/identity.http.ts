/**
 * A1 HTTP 面共用件：请求体解析（§5 契约词汇）。
 * 错误体过滤器已收敛至 infrastructure 的 AppHttpExceptionFilter（G-B 做项1，6→1；
 * 错误体形态 {code, message} 不变）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { assertMainlandPhone } from './identity.crypto';

/** POST /auth/sms 体：{phone} */
export function parseSmsBody(body: unknown): { phone: string } {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {phone}');
  }
  return { phone: assertMainlandPhone((body as { phone?: unknown }).phone) };
}

/** POST /auth/verify 体：{phone, code, age_declared?}（R-W2-C） */
export function parseVerifyBody(body: unknown): {
  phone: string;
  code: string;
  ageDeclared?: boolean;
} {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {phone, code}');
  }
  const raw = body as { phone?: unknown; code?: unknown; age_declared?: unknown };
  if (typeof raw.code !== 'string' || raw.code === '') {
    throw new AppError(ErrorCode.InvalidArgument, 'code 必须为非空字符串');
  }
  if (
    raw.age_declared !== undefined &&
    raw.age_declared !== null &&
    typeof raw.age_declared !== 'boolean'
  ) {
    throw new AppError(ErrorCode.InvalidArgument, 'age_declared 必须为布尔');
  }
  return {
    phone: assertMainlandPhone(raw.phone),
    code: raw.code,
    ...(typeof raw.age_declared === 'boolean' ? { ageDeclared: raw.age_declared } : {}),
  };
}

/** POST /auth/refresh 与 /auth/logout 体：{refresh_token} */
export function parseRefreshTokenBody(body: unknown): { refreshToken: string } {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {refresh_token}');
  }
  const token = (body as { refresh_token?: unknown }).refresh_token;
  if (typeof token !== 'string' || token === '') {
    throw new AppError(ErrorCode.InvalidArgument, 'refresh_token 必须为非空字符串');
  }
  return { refreshToken: token };
}

/** POST /auth/switch-role 体：{target_role} */
export function parseSwitchRoleBody(body: unknown): { targetRole: unknown } {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {target_role}');
  }
  return { targetRole: (body as { target_role?: unknown }).target_role };
}
