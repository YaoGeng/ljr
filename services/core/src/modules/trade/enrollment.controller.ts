/**
 * C3 REST 面（§5 契约表逐字 + Task 7 简报；不扩面）：
 *   POST /sessions/{id}/enroll    {points_to_use?} → {enrollment, payment_order, pay_params}
 *                                 402 E_REALNAME_REQUIRED / 403 E_RESTRICTED / 409 E_FULL_OR_DEADLINE
 *                                 / 409 E_ENROLL_DUP_KEY（幂等键=user+ref：同键同载荷幂等返回原支付单）
 *   POST /group-buys/{id}/join    同上 + 409 E_REACHED_LOCKED
 *   GET  /enrollments/mine        {status, amounts, refund_status}（§5 鉴权口径：user 本人面）
 *
 * 鉴权：三端点挂 @UseGuards(IdentityAuthGuard, IdentityRoleGuard)+@RequireRole('user')
 * （user_id 一律取 JWT claims，不收 body 字段——防越权代报名，C1 lawyer_id 同口径）。
 * 出参：§5 逐字 {payment_order} 包键 + 简报补位 pay_params/enrollment（端上唤起支付与幂等对账
 * 必需，报告注明）。
 */
import { Body, Controller, Get, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseEnrollBody, parsePathId } from './enrollment.http';
import { EnrollmentService } from './enrollment.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class EnrollmentController {
  constructor(private readonly enrollments: EnrollmentService) {}

  /** POST /sessions/{id}/enroll（§5：幂等键=user+ref；402/403/409） */
  @Post('sessions/:id/enroll')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  enroll(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.enrollments
      .create({
        ref_type: 'session',
        ref_id: parsePathId(id, 'id'),
        user_id: identity.userId,
        ...parseEnrollBody(body),
      })
      .then((r) => ({
        enrollment: {
          id: r.enrollment_id,
          ref_type: r.ref_type,
          ref_id: r.ref_id,
          paid_amount: r.paid_amount,
          cash_amount: r.cash_amount,
          points_amount: r.points_amount,
        },
        payment_order: r.payment_order,
        pay_params: r.pay_params,
      }));
  }

  /** POST /group-buys/{id}/join（§5：同上 + 409 REACHED_LOCKED） */
  @Post('group-buys/:id/join')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  join(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.enrollments
      .create({
        ref_type: 'groupbuy',
        ref_id: parsePathId(id, 'id'),
        user_id: identity.userId,
        ...parseEnrollBody(body),
      })
      .then((r) => ({
        enrollment: {
          id: r.enrollment_id,
          ref_type: r.ref_type,
          ref_id: r.ref_id,
          paid_amount: r.paid_amount,
          cash_amount: r.cash_amount,
          points_amount: r.points_amount,
        },
        payment_order: r.payment_order,
        pay_params: r.pay_params,
      }));
  }

  /** GET /enrollments/mine（§5：{status, amounts, refund_status}；user 本人面） */
  @Get('enrollments/mine')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  mine(@CurrentIdentity() identity: IdentityClaims): Promise<unknown> {
    return this.enrollments.listMine(identity.userId);
  }
}
