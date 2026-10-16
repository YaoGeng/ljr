/**
 * A1 REST 面（§5 + 裁决 R-W2-B/C）：/auth/sms、/auth/verify、/auth/refresh、/auth/logout、
 * /auth/switch-role 与 GET /me。响应字段用 §5 契约词汇（snake_case）；认证态路由挂
 * IdentityAuthGuard，身份取自 JWT claims（不收 query 注入）。
 */
import { Body, Controller, Get, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { CurrentIdentity, IdentityAuthGuard, type IdentityClaims } from './identity.guards';
import {
  parseRefreshTokenBody,
  parseSmsBody,
  parseSwitchRoleBody,
  parseVerifyBody,
} from './identity.http';
import { IdentityService } from './identity.service';

@Controller('auth')
@UseFilters(AppHttpExceptionFilter)
export class AuthController {
  constructor(private readonly identity: IdentityService) {}

  @Post('sms')
  requestSms(@Body() body: unknown): Promise<{ ttl: number }> {
    return this.identity.requestSms(parseSmsBody(body).phone);
  }

  @Post('verify')
  async verify(
    @Body() body: unknown,
  ): Promise<{ access_token: string; refresh_token: string; roles: string[] }> {
    const input = parseVerifyBody(body);
    const done = await this.identity.verify(input);
    return {
      access_token: done.accessToken,
      refresh_token: done.refreshToken,
      roles: done.roles,
    };
  }

  @Post('refresh')
  async refresh(@Body() body: unknown): Promise<{ access_token: string }> {
    const { refreshToken } = parseRefreshTokenBody(body);
    const done = await this.identity.refresh(refreshToken);
    return { access_token: done.accessToken };
  }

  @Post('logout')
  async logout(@Body() body: unknown): Promise<{ ok: true; revoked: boolean }> {
    const { refreshToken } = parseRefreshTokenBody(body);
    return this.identity.logout(refreshToken);
  }

  @Post('switch-role')
  @UseGuards(IdentityAuthGuard)
  async switchRole(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ access_token: string }> {
    const { targetRole } = parseSwitchRoleBody(body);
    const done = await this.identity.switchRole(identity.userId, targetRole);
    return { access_token: done.accessToken };
  }
}

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class MeController {
  constructor(private readonly identity: IdentityService) {}

  @Get('me')
  @UseGuards(IdentityAuthGuard)
  async me(@CurrentIdentity() identity: IdentityClaims): Promise<{
    id: number;
    roles: string[];
    status: string;
    phone_masked: string;
  }> {
    const view = await this.identity.me(identity.userId);
    return {
      id: view.id,
      roles: view.roles,
      status: view.status,
      phone_masked: view.phoneMasked,
    };
  }
}
