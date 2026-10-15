/**
 * I1 HTTP 面共用件：AppError → HTTP 错误体的模块内过滤器 + 入参解析。
 * 身份接线（W2 交接 4-B，A1 落地）：用户面 user_id 改由 JWT claims 注入
 * （identity 模块的 IdentityAuthGuard/IdentityRoleGuard/CurrentIdentity 承接），
 * 本文件不再做 user_id 解析；admin 面控制器不动（鉴权占位延续 W1 共性）。
 */
import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';

/** 结构化最小响应口（不引 express 类型依赖） */
interface HttpResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Catch(AppError)
export class NotifyHttpExceptionFilter implements ExceptionFilter {
  catch(exception: AppError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    res.status(exception.httpStatus).json({ code: exception.code, message: exception.message });
  }
}

export interface PrefsPutItem {
  readonly templateCode: string;
  readonly enabled: boolean;
}

/** PUT /notification-prefs 体：{prefs: [{template_code, enabled}]}（键名随 §5 契约词汇） */
export function parsePrefsBody(body: unknown): PrefsPutItem[] {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { prefs?: unknown }).prefs)
  ) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 {prefs: [{template_code, enabled}]}');
  }
  return (body as { prefs: unknown[] }).prefs.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new AppError(ErrorCode.InvalidArgument, 'prefs 项须为对象');
    }
    const templateCode = (item as { template_code?: unknown }).template_code;
    const enabled = (item as { enabled?: unknown }).enabled;
    if (typeof templateCode !== 'string' || templateCode === '') {
      throw new AppError(ErrorCode.InvalidArgument, 'prefs 项缺 template_code');
    }
    if (typeof enabled !== 'boolean') {
      throw new AppError(ErrorCode.InvalidArgument, 'prefs 项 enabled 须为布尔');
    }
    return { templateCode, enabled };
  });
}
