/**
 * G1 REST 面（§5 + Task 6 简报裁决）：
 *   - GET /credit/mine          → {score, recent_events, restrictions[]}（JWT 本人；owner_type=
 *                                 claims 当前激活角色——双角色同 App，user/lawyer 分账户）
 *   - GET /credit/restrictions?owner_type=&owner_id= → 活跃限制令（内部/入口校验面，C1/C3/A3a
 *                                 W3 消费查询面；30s 进程内缓存适配位 R-W2-8）
 *   - EMIT_CREDIT_EVENT 为内部接口（CreditService.emit），无 HTTP（§5「内部」行）
 * 鉴权口径（B1/B3 先例）：/credit/mine 要求 JWT（本人语义，claims 注入 owner，不收路径参数）；
 *   /credit/restrictions 为内部校验面暂不设角色限制（⚠与 B1/B3 GET 面同口径，H1 接线后统一收紧，
 *   报告标注；拦截本体不做——入口拦截=C1/C3/A3a 消费本查询面，W3 落位）。
 */
import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parseOwnerId, parseOwnerType } from './credit.http';
import { CreditService } from './credit.service';
import type { CreditMineView, RestrictionView } from './credit.types';

@Controller('credit')
@UseFilters(AppHttpExceptionFilter)
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  /** GET /credit/mine：本人信用视图（score 初始 100 回显口径见 service；限流/角色不限——双角色均可见本人分） */
  @Get('mine')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  mine(@CurrentIdentity() identity: IdentityClaims): Promise<CreditMineView> {
    return this.credit.getMine(identity.role, identity.userId);
  }

  /** GET /credit/restrictions：活跃限制令（入口校验调查询面；owner 从 query 显式给——内部面语义） */
  @Get('restrictions')
  restrictions(
    @Query('owner_type') ownerType: string | undefined,
    @Query('owner_id') ownerId: string | undefined,
  ): Promise<RestrictionView[]> {
    return this.credit.listActiveRestrictions(parseOwnerType(ownerType), parseOwnerId(ownerId));
  }
}
