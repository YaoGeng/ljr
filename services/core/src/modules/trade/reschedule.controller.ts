/**
 * C5 REST 面（§5 契约表逐字 + M2-W2 T5 简报；不扩面）：
 *   POST /enrollments/{id}/reschedule {target_session_id}  → {request}（user 面）
 *                                400 E_INVALID_ARGUMENT（<2H/形状）/ 409 E_NO_SEAT|E_RESCHEDULE_USED
 *                                |E_CONFLICT（非 PAID/已有进行中请求）/ 403 E_RESTRICTED（非属主）
 *   POST /reschedule/{id}/cancel                            → {status}（user 面=报名属主；
 *                                409 E_CONFLICT=CONFIRMED 已确认不可撤）
 *   POST /reschedule/{id}/confirm                           → {new_enrollment_id}（lawyer 面；
 *                                409 E_RESCHEDULE_EXPIRED|E_NO_SEAT）
 *
 * 鉴权（§5 + A.4「律师端面=identity JWT（actor 律师=场次属主校验同 D1 close 先例）」）：
 * user_id/lawyer_id 一律取 JWT claims（不收 body 字段——防越权代申请/代确认，C4 同口径）。
 * 幂等：申请键=enrollment（服务层 PENDING 同目标短路）、确认键=request（CONFIRMED 短路）。
 */
import { Body, Controller, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseRescheduleBody } from './reschedule.http';
import { RescheduleService } from './reschedule.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class RescheduleController {
  constructor(private readonly reschedules: RescheduleService) {}

  /** POST /enrollments/{id}/reschedule（§5：幂等键=enrollment；400/403/409）→ {request} */
  @Post('enrollments/:id/reschedule')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  apply(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.reschedules.apply(
      parsePositiveInt(id, 'id'),
      identity.userId,
      parseRescheduleBody(body).target_session_id,
    );
  }

  /** POST /reschedule/{id}/cancel（§2 确认前；409 CONFIRMED）→ {status} */
  @Post('reschedule/:id/cancel')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  cancel(@CurrentIdentity() identity: IdentityClaims, @Param('id') id: string): Promise<unknown> {
    return this.reschedules.cancel(parsePositiveInt(id, 'id'), identity.userId);
  }

  /** POST /reschedule/{id}/confirm（§4 确认事务；幂等键=request；409 EXPIRED|NO_SEAT）→ {new_enrollment_id} */
  @Post('reschedule/:id/confirm')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  confirm(@CurrentIdentity() identity: IdentityClaims, @Param('id') id: string): Promise<unknown> {
    return this.reschedules.confirm(parsePositiveInt(id, 'id'), identity.userId);
  }
}
