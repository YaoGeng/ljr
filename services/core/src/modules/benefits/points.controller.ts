/**
 * F4 REST 面（§5 契约表逐字 + Task 2 简报；①切片不扩面）：
 *   GET /points/mine → {balance, frozen, expiring_soon[]}（§5 契约表逐字）
 *   FREEZE/SETTLE/UNFREEZE_POINTS 与授予/退款还原均为内部接口（PointsService 应用服务，
 *   C3=T7 / F2=T6 / ②编排消费），无 HTTP（§5「内部」行）。
 *
 * 鉴权口径（A1/credit 先例）：/points/mine 为 JWT 本人语义面（claims 注入 user_id，不收
 * 路径参数）+ @RequireRole('user')——双角色同 App 下积分属用户身份（points_accounts 以
 * user_id 为 PK，与 credit 的 owner_type 分账户口径不同：积分账户跨激活角色唯一）。
 */
import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { PointsService } from './points.service';
import type { PointsMineView } from './points.types';

@Controller('points')
@UseFilters(AppHttpExceptionFilter)
export class PointsController {
  constructor(private readonly points: PointsService) {}

  /** GET /points/mine：本人积分视图（balance=惰性过期口径可用余额；§5 契约表逐字） */
  @Get('mine')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  mine(@CurrentIdentity() identity: IdentityClaims): Promise<PointsMineView> {
    return this.points.getMine(identity.userId);
  }
}
