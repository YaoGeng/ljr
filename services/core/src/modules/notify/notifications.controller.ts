/**
 * GET /notifications/mine（I1 §5）：站内信列表（本用户 INBOX+SENT）。
 * 身份接线（W2 交接 4-B，A1 落地）：user_id 取自 JWT claims（IdentityAuthGuard 校验+提取）；
 * R-03 接口级角色校验——通知中心属用户面，@RequireRole('user') 拒 lawyer 激活角色 token（403）。
 */
import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { NotifyHttpExceptionFilter } from './notify.http';
import { NotifyDispatcherService } from './notify-dispatcher.service';

@Controller('notifications')
@UseFilters(NotifyHttpExceptionFilter)
export class NotificationsController {
  constructor(private readonly dispatcher: NotifyDispatcherService) {}

  @Get('mine')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  mine(
    @CurrentIdentity() identity: IdentityClaims,
  ): ReturnType<NotifyDispatcherService['listInbox']> {
    return this.dispatcher.listInbox(identity.userId);
  }
}
