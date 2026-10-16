/**
 * GET/PUT /notification-prefs（I1 §5）：用户通知偏好查询与设置。
 * 身份接线（W2 交接 4-B，A1 落地）：user_id 取自 JWT claims（IdentityAuthGuard 校验+提取）；
 * R-03 接口级角色校验——通知偏好属用户面，@RequireRole('user') 拒 lawyer 激活角色 token（403）。
 */
import { Body, Controller, Get, Put, UseFilters, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parsePrefsBody } from './notify.http';
import { NotifyPrefsService } from './notify-prefs.service';

@Controller('notification-prefs')
@UseFilters(AppHttpExceptionFilter)
export class NotificationPrefsController {
  constructor(private readonly prefs: NotifyPrefsService) {}

  @Get()
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  get(@CurrentIdentity() identity: IdentityClaims): ReturnType<NotifyPrefsService['getPrefs']> {
    return this.prefs.getPrefs(identity.userId);
  }

  @Put()
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  put(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): ReturnType<NotifyPrefsService['putPrefs']> {
    return this.prefs.putPrefs(identity.userId, parsePrefsBody(body));
  }
}
