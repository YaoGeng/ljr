/**
 * C4 REST 面（§5 契约表逐字 + M2-W2 T4 简报；不扩面）：
 *   GET  /lawyer/group-buys?status=PENDING_LAWYER   接单大厅（已选定自己+待确认清单）→ 裸数组
 *   POST /group-buys/{id}/confirm                   → {session_id}（409 E_NOT_REACHED / 403 E_RESTRICTED）
 *   POST /group-buys/{id}/reject  {reason?}         → {status}（409 E_NOT_PENDING）
 *   POST /group-buys/{id}/convert {capacity?, price?} → {session_id}（409 E_NOT_CONVERTIBLE）
 *   GET  /lawyer/response-stats?from=&to=           → {samples, avg_confirm_minutes}（内部/H4 聚合源）
 *
 * 鉴权（§5 + A1 §10-5 律师端复验先例）：全部 @RequireRole('lawyer')+@CurrentIdentity——
 * lawyer_id 一律取 JWT claims（不收 body/query 字段——防越权代响应；user token 打律师面 403
 * E_ROLE_FORBIDDEN，session.controller 同口径）。幂等键=gb（§5 逐字）：服务层目标态短路承载。
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
import {
  parseConvertBody,
  parseHallQuery,
  parseRejectBody,
  parseResponseStatsQuery,
} from './group-buy-response.http';
import { GroupBuyResponseService } from './group-buy-response.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class GroupBuyResponseController {
  constructor(private readonly responses: GroupBuyResponseService) {}

  /** GET /lawyer/group-buys?status=PENDING_LAWYER（§5 接单大厅：子范围/标签/截止 lawyer_confirm_by） */
  @Get('lawyer/group-buys')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  list(
    @CurrentIdentity() identity: IdentityClaims,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    parseHallQuery(query);
    return this.responses.listPendingForLawyer(identity.userId);
  }

  /** POST /group-buys/{id}/confirm（§5：→ {session_id}；幂等键=gb；409 NOT_REACHED/#36 403） */
  @Post('group-buys/:id/confirm')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  confirm(@CurrentIdentity() identity: IdentityClaims, @Param('id') id: string): Promise<unknown> {
    return this.responses.confirm(parsePositiveInt(id, 'id'), identity.userId);
  }

  /** POST /group-buys/{id}/reject（§5：→ {status}；幂等键=gb；409 NOT_PENDING） */
  @Post('group-buys/:id/reject')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  reject(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.responses.reject(
      parsePositiveInt(id, 'id'),
      identity.userId,
      parseRejectBody(body).reason,
    );
  }

  /** POST /group-buys/{id}/convert（§5：→ {session_id}；幂等键=gb；409 NOT_CONVERTIBLE） */
  @Post('group-buys/:id/convert')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  convert(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.responses.convert(
      parsePositiveInt(id, 'id'),
      identity.userId,
      parseConvertBody(body),
    );
  }

  /** GET /lawyer/response-stats?from=&to=（§5：12h 确认时长，口径=H4——H1 实力档案聚合源） */
  @Get('lawyer/response-stats')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  responseStats(
    @CurrentIdentity() identity: IdentityClaims,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    const { from, to } = parseResponseStatsQuery(query);
    return this.responses.responseStats(identity.userId, from, to);
  }
}
