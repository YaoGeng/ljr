/**
 * F2 REST 面（§5 契约表逐字；不扩面）：
 *   GET /refunds/mine → 本人退款状态列表（含 1-3 工作日文案字段 R-01）
 *   ISSUE_REFUND 为内部契约（RefundService 应用服务，发起方模块消费），无 HTTP 受理面。
 *
 * 鉴权口径（points/mine 同款）：JWT 本人语义面（claims 注入 user_id，不收路径参数）
 * + @RequireRole('user')——双角色同 App 下退款属付款人本人（refunds.user_id 过滤）。
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
import { RefundService } from './refund.service';
import type { RefundMineItem } from './refund.types';

@Controller('refunds')
@UseFilters(AppHttpExceptionFilter)
export class RefundController {
  constructor(private readonly refunds: RefundService) {}

  /** GET /refunds/mine：本人退款状态列表（R-01 原路退回 1-3 工作日文案字段） */
  @Get('mine')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  mine(@CurrentIdentity() identity: IdentityClaims): Promise<readonly RefundMineItem[]> {
    return this.refunds.listMine(identity.userId);
  }
}
