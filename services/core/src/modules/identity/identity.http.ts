/**
 * A1 HTTP 面共用件：AppError → HTTP 错误体的模块内过滤器 + 请求体解析（§5 契约词汇）。
 * 错误体形态与 notify.http 同口径：{code, message}。
 */
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { assertMainlandPhone } from './identity.crypto';

/** 结构化最小响应口（不引 express 类型依赖） */
interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Catch(AppError)
export class IdentityHttpExceptionFilter implements ExceptionFilter {
  catch(exception: AppError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    res.status(exception.httpStatus).json({ code: exception.code, message: exception.message });
  }
}

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
