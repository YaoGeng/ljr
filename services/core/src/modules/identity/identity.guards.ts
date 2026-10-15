/**
 * A1 认证守卫（R-03 接口级 claims.role 校验的执行件；W2 交接 4-B：I1 用户面 REST 接线）。
 *
 * - IdentityAuthGuard：校验 Bearer JWT（签名/过期/claims 结构）→ 挂 req.identity；
 *   只做凭证校验不查库（角色/状态以签发时 claims 为准；封禁在铸 token 三入口拦截：
 *   verify 登录 / refresh 续签 / switch-role 换签——终审 I-1）。
 * - IdentityRoleGuard：配合 @RequireRole('user'|'lawyer')——claims.role ≠ 要求角色 →
 *   403 E_ROLE_FORBIDDEN（R-03：界面数据隔离=角色路由 + 接口级 claims 校验）。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, ErrorCode } from '@ljr/shared';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from './identity.machine';

/** 已认证请求的身份上下文（guard 挂载，@CurrentIdentity 提取） */
export interface IdentityClaims {
  readonly userId: number;
  /** 当前激活角色（switch-role 重签的事实源） */
  readonly role: UserRole;
  /** 持有的全部角色 */
  readonly roles: UserRole[];
}

/** 最小 HTTP 请求结构（不引 express 类型依赖，notify.http 同口径） */
interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  identity?: IdentityClaims;
}

@Injectable()
export class IdentityAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError(ErrorCode.Unauthorized, '缺少 Bearer 凭证');
    }
    const token = header.slice('Bearer '.length).trim();
    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new AppError(ErrorCode.Unauthorized, '凭证无效或已过期');
    }
    const claims = (payload ?? {}) as { sub?: unknown; role?: unknown; roles?: unknown };
    const userId = Number(claims.sub);
    if (
      !Number.isInteger(userId) ||
      userId <= 0 ||
      (claims.role !== 'user' && claims.role !== 'lawyer') ||
      !Array.isArray(claims.roles)
    ) {
      throw new AppError(ErrorCode.Unauthorized, '凭证载荷非法');
    }
    req.identity = {
      userId,
      role: claims.role,
      roles: claims.roles.filter((r): r is UserRole => r === 'user' || r === 'lawyer'),
    };
    return true;
  }
}

export const IDENTITY_ROLE_META = 'identity.required_role';

/** 接口角色要求（R-03）：@RequireRole('user') / @RequireRole('lawyer') */
export const RequireRole = (role: UserRole): MethodDecorator & ClassDecorator =>
  SetMetadata(IDENTITY_ROLE_META, role);

@Injectable()
export class IdentityRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole | undefined>(IDENTITY_ROLE_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.identity?.role !== required) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `该接口要求 ${required} 角色（当前激活角色：${req.identity?.role ?? '未认证'}）`,
      );
    }
    return true;
  }
}

/** 提取当前身份（须先过 IdentityAuthGuard；用于 user_id 从 claims 注入——W2 交接 4-B） */
export const CurrentIdentity = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IdentityClaims => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.identity) throw new AppError(ErrorCode.Unauthorized);
    return req.identity;
  },
);
