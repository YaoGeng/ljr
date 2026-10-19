/**
 * F4 券 REST 面（②全量，M2-W2 T6；§5 契约表「GET /coupons/mine → 券列表」逐字）：
 * 惰性到期在读路径内完成（ACTIVE→EXPIRED 守卫+STL 翻转——见 coupon.service）。
 *
 * 鉴权口径（points.controller 同款）：JWT 本人语义面（claims 注入 user_id）+
 * @RequireRole('user')——券属用户身份（coupon_grants.user_id）。
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
import { CouponService } from './coupon.service';
import type { CouponGrantView } from './coupon.types';

@Controller('coupons')
@UseFilters(AppHttpExceptionFilter)
export class CouponController {
  constructor(private readonly coupons: CouponService) {}

  /** GET /coupons/mine：本人券列表（含惰性到期翻转；§5 契约表逐字） */
  @Get('mine')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  mine(@CurrentIdentity() identity: IdentityClaims): Promise<readonly CouponGrantView[]> {
    return this.coupons.listMine(identity.userId);
  }
}
