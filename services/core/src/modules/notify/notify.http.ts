/**
 * I1 HTTP 面共用件：入参解析（§5）。
 * 错误体过滤器已收敛至 infrastructure 的 AppHttpExceptionFilter（G-B 做项1，6→1；
 * 错误体形态 {code, message} 不变）。
 * 身份接线（W2 交接 4-B，A1 落地）：用户面 user_id 改由 JWT claims 注入
 * （identity 模块的 IdentityAuthGuard/IdentityRoleGuard/CurrentIdentity 承接），
 * 本文件不再做 user_id 解析；admin 面控制器不动（鉴权占位延续 W1 共性）。
 */
import { AppError, ErrorCode } from '@ljr/shared';

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
