/**
 * D4 REST 面（§5 契约表逐字 + M2-W2 T3 简报，不扩面）：
 *   POST /sessions/{id}/cancel       {role: user|lawyer, reason} → {result, approval?}；
 *                                    409 NOT_CANCELLABLE=场次终态（含已被其他角色取消）；
 *                                    400 <2H_USE_ENROLLMENT_CANCEL（用户 <2h 场次级取消——
 *                                    choice 在报名维度 API，session 级无 choice 位）
 *   POST /enrollments/{id}/cancel    {choice: refund50|credit} → {result}；
 *                                    400 >=2H_USE_RESCHEDULE（≥2h 应走 C5 改期——T5 落位，
 *                                    本批仅指引位不代做）
 *   审批回调（§5 H3 POST /cancellations/{id}/approve）=H3 工单处置路径承载：律师 <24h 取消
 *   建 category=cancel_lt24h 工单（挂 ref=session），admin 经 POST /admin/tickets/{id}/resolve
 *   {action_payload:{target:'d4', cancellation_id}} 处置 → TicketResolveCallbackRegistry 路由
 *   到 D4 续跑（cancellation.service.onApprovalResolved）——D4 无独立 approve 端点（无独占表，
 *   cancellation_id=session_id，报告注记）。
 *
 * 鉴权：IdentityAuthGuard（双角色面——role 由 body 携带并与 JWT 激活角色比对，不符 403
 * E_ROLE_FORBIDDEN）；归属校验在服务面（user=PAID 参与方 / lawyer=场次属主，actor=JWT
 * claims userId——closeRoom.actorLawyerId 同款先例）。
 */
import { Body, Controller, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppError, ErrorCode } from '@ljr/shared';
import { CancellationService } from './cancellation.service';
import {
  parseCancelReason,
  parseCancelRole,
  parseEnrollmentIdParam,
  parseSessionIdParam,
  parseUserLateChoice,
} from './cancellation.http';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class CancellationController {
  constructor(private readonly cancellations: CancellationService) {}

  /** POST /sessions/{id}/cancel（§5：幂等键=session+role；归属=服务面 actor 比对） */
  @Post('sessions/:session_id/cancel')
  @UseGuards(IdentityAuthGuard)
  cancelSession(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('session_id') sessionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    const role = parseCancelRole(body['role']);
    if (identity.role !== role) {
      // body.role 与 JWT 激活角色必须一致（防 lawyer token 冒 user 取消/反之）
      throw new AppError(
        ErrorCode.RoleForbidden,
        `body.role=${role} 与当前激活角色 ${identity.role} 不符（取消发起方=JWT 本人）`,
      );
    }
    return this.cancellations.cancelSession(
      {
        sessionId: parseSessionIdParam(sessionId),
        role,
        reason: parseCancelReason(body['reason']),
      },
      { actorUserId: identity.userId },
    );
  }

  /** POST /enrollments/{id}/cancel（§5：幂等键=enrollment；400 >=2H_USE_RESCHEDULE） */
  @Post('enrollments/:enrollment_id/cancel')
  @UseGuards(IdentityAuthGuard)
  cancelEnrollment(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('enrollment_id') enrollmentId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.cancellations.cancelEnrollment(
      {
        enrollmentId: parseEnrollmentIdParam(enrollmentId),
        choice: parseUserLateChoice(body['choice']),
      },
      { actorUserId: identity.userId },
    );
  }
}
