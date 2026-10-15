import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  IDENTITY_ROLE_META,
  IdentityAuthGuard,
  IdentityRoleGuard,
  type IdentityClaims,
} from './identity.guards';

/**
 * A1 守卫单测（无 PG）：R-03 接口级 claims.role 校验的机械证明（§10-5「旧 token 角色接口
 * 不可用」——模块文档 §5 暂无律师端接口可作 HTTP 标本，律师端接口随 W3 律师工作台落位）；
 * 认证守卫凭证形态校验。密钥随机派生（零字面量）。
 */

/** 最小 ExecutionContext 桩（guard 只触 request/handler/class） */
function ctxWith(
  headers: Record<string, string>,
  identity?: IdentityClaims,
  roleMeta?: 'user' | 'lawyer',
): ExecutionContext {
  const handler = (): undefined => undefined;
  if (roleMeta) Reflect.defineMetadata(IDENTITY_ROLE_META, roleMeta, handler);
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, identity }),
      getResponse: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

describe('A1 守卫（R-03 接口级 claims.role 校验，无 PG）', () => {
  const jwt = new JwtService({ secret: randomBytes(32).toString('hex') });
  const authGuard = new IdentityAuthGuard(jwt);
  const roleGuard = new IdentityRoleGuard(new Reflector());

  it('IdentityAuthGuard：有效 token → 挂 identity（sub/role/roles）；无/坏/过期 token → 401 E_UNAUTHORIZED', async () => {
    const token = await jwt.signAsync(
      { sub: '7', role: 'user', roles: ['user'] },
      { expiresIn: 60 },
    );
    const req = { headers: { authorization: `Bearer ${token}` } } as {
      headers: Record<string, string>;
      identity?: IdentityClaims;
    };
    const ok = await authGuard.canActivate({
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
      getHandler: () => (): undefined => undefined,
      getClass: () => class TestController {},
    } as unknown as ExecutionContext);
    expect(ok).toBe(true);
    expect(req.identity).toEqual({ userId: 7, role: 'user', roles: ['user'] });

    for (const headers of [
      {}, // 缺 Authorization
      { authorization: 'not-bearer' }, // 非 Bearer
      { authorization: 'Bearer broken.token.value' }, // 坏 token
    ]) {
      await expect(
        authGuard.canActivate(ctxWith(headers as Record<string, string>)),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized, httpStatus: 401 });
    }

    // 载荷结构非法（sub 非整数）
    const badClaims = await jwt.signAsync(
      { sub: 'abc', role: 'user', roles: [] },
      { expiresIn: 60 },
    );
    await expect(
      authGuard.canActivate(ctxWith({ authorization: `Bearer ${badClaims}` })),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
  });

  it('R-03 双向：lawyer 激活角色访问 @RequireRole(user) → 403；user 角色（旧 token）访问 @RequireRole(lawyer) → 403', async () => {
    const userClaims: IdentityClaims = { userId: 7, role: 'user', roles: ['user'] };
    const lawyerClaims: IdentityClaims = { userId: 7, role: 'lawyer', roles: ['user', 'lawyer'] };

    expect(() => roleGuard.canActivate(ctxWith({}, lawyerClaims, 'user'))).toThrowError(
      expect.objectContaining({ code: ErrorCode.RoleForbidden, httpStatus: 403 }) as AppError,
    );
    expect(() => roleGuard.canActivate(ctxWith({}, userClaims, 'lawyer'))).toThrowError(
      expect.objectContaining({ code: ErrorCode.RoleForbidden, httpStatus: 403 }) as AppError,
    );

    // 同角色放行；未标注接口不设防
    expect(roleGuard.canActivate(ctxWith({}, userClaims, 'user'))).toBe(true);
    expect(roleGuard.canActivate(ctxWith({}, lawyerClaims))).toBe(true);
  });

  it('AppError 构造（守卫抛错形态）：code+httpStatus 随错误码表', () => {
    const e = new AppError(ErrorCode.RoleForbidden);
    expect(e.httpStatus).toBe(403);
  });
});
