/**
 * C1 REST 面（§5 契约表逐字 + Task 4 简报；不扩面）：
 *   POST /sessions                  {slot_start, price_mode, unit_price?, capacity, enroll_deadline?, room_mode} → {session}
 *                                   409 E_SLOT_TAKEN/E_SESSION_DUP_KEY、403 E_RESTRICTED、429（B2 滥用计数）
 *   GET  /sessions?specialty=&lawyer=&from=&to=   列表（仅 PASSED 律师）→ 裸数组（出参列「列表」无包键）
 *   GET  /sessions/{id}             详情+剩余席位
 *   GET  /lawyer/sessions/stats?from=&to=  四率
 *
 * 鉴权（A1 §10-5 律师端 HTTP 复验落点）：POST /sessions 与 stats 挂
 * @UseGuards(IdentityAuthGuard, IdentityRoleGuard)+@RequireRole('lawyer')+@CurrentIdentity
 * （user token 打律师面 403 E_ROLE_FORBIDDEN，双向用例钉住）；GET 列表/详情公开（§5 鉴权「否」）。
 * lawyer_id 一律取 JWT claims（不收 body 字段——防越权代开团）。
 */
import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseListQuery, parseSessionBody, parseStatsQuery } from './session.http';
import { SessionService } from './session.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  /** POST /sessions（§5：幂等键=lawyer+slot_start；409/403） */
  @Post('sessions')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  create(@CurrentIdentity() identity: IdentityClaims, @Body() body: unknown): Promise<unknown> {
    return this.sessions
      .create({ ...parseSessionBody(body), lawyer_id: identity.userId })
      .then((session) => ({ session })); // §5 出参 {session} 包键（{refund}/{result} 同形先例）
  }

  /** GET /sessions?specialty=&lawyer=&from=&to=（§5：列表仅 lawyer 审核 PASSED） */
  @Get('sessions')
  list(@Query() query: Record<string, unknown>): Promise<unknown> {
    return this.sessions.list(parseListQuery(query));
  }

  /** GET /sessions/{id}（§5：详情+剩余席位） */
  @Get('sessions/:id')
  detail(@Param('id') id: string): Promise<unknown> {
    return this.sessions.getDetail(parsePositiveInt(id, 'id'));
  }

  /** GET /lawyer/sessions/stats?from=&to=（§5：四率；本批两率+两桩） */
  @Get('lawyer/sessions/stats')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  stats(
    @CurrentIdentity() identity: IdentityClaims,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    const { from, to } = parseStatsQuery(query);
    return this.sessions.stats(identity.userId, from, to);
  }
}
