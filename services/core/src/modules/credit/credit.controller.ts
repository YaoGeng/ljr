/**
 * G1 REST 面（§5 + Task 6 简报裁决）：
 *   - GET /credit/mine          → {score, recent_events, restrictions[]}（JWT 本人；owner_type=
 *                                 claims 当前激活角色——双角色同 App，user/lawyer 分账户）
 *   - GET /credit/restrictions?owner_type=&owner_id= → 活跃限制令（内部/入口校验面，C1/C3/A3a
 *                                 W3 消费查询面；30s 进程内缓存适配位 R-W2-8）
 *   - EMIT_CREDIT_EVENT 为内部接口（CreditService.emit），无 HTTP（§5「内部」行）
 * 鉴权口径：/credit/mine 要求 JWT（本人语义，claims 注入 owner，不收路径参数）；
 *   /credit/restrictions=W3 T10 G-A 接线（R-W2-H park 关闭）@RequireRole('admin')——
 *   HTTP 面仅运营台可达；C1/C3/A3a 模块消费走 CreditService.listActiveRestrictions 服务面
 *   （不受影响），入口拦截本体=各消费模块职责，本面只做查询。
 */
import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppError, ErrorCode } from '@ljr/shared';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parseOwnerId, parseOwnerType } from './credit.http';
import { CreditService } from './credit.service';
import type { CreditMineView, RestrictionView } from './credit.types';

@Controller('credit')
@UseFilters(AppHttpExceptionFilter)
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  /**
   * GET /credit/mine：本人信用视图（score 初始 100 回显口径见 service；限流/角色不限——双角色均可见本人分）。
   * ⚠W3-8 边界：信用账户按 user/lawyer 双角色分账（G1 §3 owner_type 值域）——纯运营预置账号
   * （claims.role=admin，无 user/lawyer 激活角色）无个人信用账户语义，403 显性拒绝（不静默映射）。
   */
  @Get('mine')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  async mine(@CurrentIdentity() identity: IdentityClaims): Promise<CreditMineView> {
    if (identity.role !== 'user' && identity.role !== 'lawyer') {
      throw new AppError(
        ErrorCode.RoleForbidden,
        '信用账户按 user/lawyer 双角色分账（admin 为运营旗标，无个人信用账户）',
      );
    }
    return this.credit.getMine(identity.role, identity.userId);
  }

  /**
   * GET /credit/restrictions：活跃限制令（入口校验调查询面；owner 从 query 显式给）。
   * W3 T10 G-A 接线（R-W2-H park 关闭，终审不可降级项）：挂 admin 角色守卫——C1/C3/A3a 等
   * 模块消费走 CreditService.listActiveRestrictions 服务面（不受影响），HTTP 面仅运营台可达；
   * 未认证 401 / 未持 admin 旗标 403 E_ROLE_FORBIDDEN。
   */
  @Get('restrictions')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('admin')
  restrictions(
    @Query('owner_type') ownerType: string | undefined,
    @Query('owner_id') ownerId: string | undefined,
  ): Promise<RestrictionView[]> {
    return this.credit.listActiveRestrictions(parseOwnerType(ownerType), parseOwnerId(ownerId));
  }
}
