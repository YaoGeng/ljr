/**
 * F3 REST 面（§5 契约表逐字；不扩面）：
 *   GET /lawyer/settlements        → 本人结算列表（场次+1对1；claims 注入 lawyer 过滤）
 *   GET /admin/settlements?status= → 后台视图（status 五态过滤）
 *   RUN_SETTLEMENT / APPLY_PENALTY 为内部契约（§5：job/H3/进件恢复重驱动与 D4 调用方经
 *   SettlementService 应用服务消费），无 HTTP 受理面——不发明端点。
 *
 * 鉴权口径：/lawyer/* = JWT 本人语义面 + @RequireRole('lawyer')（refund/points mine 同款；
 * 双角色同 App 下结算属律师本人，settlements.lawyer_id=identity 侧用户 id 过滤）。
 *
 * TODO(H1-W3-T10): /admin/settlements 统一接线 @RequireRole('admin')——本任务鉴权占位
 *   （V29 角色枚举 T10 才落位；G-A 前置门同批接线），形态照 A3b /firms/* 先例（对 Core
 *   内部契约面，服务剥离后由服务间认证接管）。
 */
import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import type { SettlementStatus, SettlementView } from './settlement.types';
import { SettlementService } from './settlement.service';

const SETTLEMENT_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'HOLD',
  'READY',
  'SETTLED',
  'SUSPENDED',
]);

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class SettlementController {
  constructor(private readonly settlements: SettlementService) {}

  /** GET /lawyer/settlements：本人结算列表（§5 逐字；场次+1对1 全量，新在前） */
  @Get('lawyer/settlements')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  mine(@CurrentIdentity() identity: IdentityClaims): Promise<readonly SettlementView[]> {
    return this.settlements.listForLawyer(identity.userId);
  }

  /** GET /admin/settlements?status=HOLD：后台视图（§5；status 形状校验五态，越域 400） */
  @Get('admin/settlements')
  async adminList(@Query('status') status?: string): Promise<readonly SettlementView[]> {
    if (status !== undefined && !SETTLEMENT_STATUSES.has(status)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `status 越域（PENDING|HOLD|READY|SETTLED|SUSPENDED）：${JSON.stringify(status)}`,
      );
    }
    return this.settlements.listForAdmin({ status: status as SettlementStatus | undefined });
  }
}
