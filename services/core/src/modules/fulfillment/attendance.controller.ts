/**
 * D3 REST 面（§5 契约表逐字 + D2 §5 confirm-arrival 同批落位）：
 *   POST /enrollments/{id}/confirm-arrival   {status}（幂等键=enrollment；D2 §5——W1 无锚
 *                                            禁建假 API，本批随 attendances 落位）
 *   GET  /rooms/{id}/attendance              [{user_id, role, status, join_at}]；403 NOT_PARTY
 *                                            （非参与方——error 词汇复用 E_ROLE_FORBIDDEN，
 *                                            shared 无 NOT_PARTY 单列码，报告注记）
 *   GET  /lawyer/attendance-stats?from=&to=  {samples, punctual_rate}（内部口径=H4；上海日界窗口）
 *
 * 鉴权（room.controller 同款先例）：confirm-arrival=IdentityAuthGuard+本人比对（报名属主
 * user 本人，body 无角色面——律师无报名）；GET attendance=IdentityAuthGuard+服务面参与方
 * 校验（user/lawyer 皆可查本场）；attendance-stats=律师角色守卫（@RequireRole('lawyer')，
 * JWT claims userId=统计属主）。
 */
import { Controller, Get, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AttendanceService } from './attendance.service';
import { parseEnrollmentIdParam, parseRoomIdParam, parseStatsWindow } from './attendance.http';
import { AppError, ErrorCode } from '@ljr/shared';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  /** POST /enrollments/{id}/confirm-arrival（D2 §5：幂等键=enrollment；属主比对防代确认） */
  @Post('enrollments/:enrollment_id/confirm-arrival')
  @UseGuards(IdentityAuthGuard)
  confirmArrival(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('enrollment_id') enrollmentId: string,
  ): Promise<unknown> {
    return this.attendance.confirmArrival(parseEnrollmentIdParam(enrollmentId), {
      actorUserId: identity.userId, // 属主校验锚=JWT claims（closeRoom.actorLawyerId 同款先例）
    });
  }

  /** GET /rooms/{id}/attendance（§5：403 NOT_PARTY=服务面参与方校验） */
  @Get('rooms/:room_id/attendance')
  @UseGuards(IdentityAuthGuard)
  listAttendance(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('room_id') roomId: string,
  ): Promise<unknown> {
    return this.attendance.listAttendance(parseRoomIdParam(roomId), identity.userId);
  }

  /** GET /lawyer/attendance-stats?from=&to=（§5：{samples, punctual_rate}，H4 口径） */
  @Get('lawyer/attendance-stats')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  stats(
    @CurrentIdentity() identity: IdentityClaims,
    @Query() query: { from?: string; to?: string },
  ): Promise<unknown> {
    const { from, to } = parseStatsWindow(query);
    if (from === '' || to === '') {
      throw new AppError(ErrorCode.InvalidArgument, 'from/to 必填（YYYY-MM-DD，上海日界窗口）');
    }
    return this.attendance.attendanceStats(identity.userId, from, to);
  }
}
