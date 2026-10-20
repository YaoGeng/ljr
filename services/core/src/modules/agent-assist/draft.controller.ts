/**
 * E1 REST/WSS 契约面（M2-W3 T4；§5 逐字 + T4 行）：
 *   POST /drafts/{id}/action      {action: send|edit_send|discard, edited_content?} → {status}；
 *                                 409 EXPIRED；幂等键=draft+action（重复同动作幂等返回）
 *   GET  /agent/drafts?room_id=&status=  律师端断线补拉面（自定口径——draft.service.listDrafts
 *                                 头注；气泡帧丢失由本面收敛）
 *   GET  /agent/health            {status:'ok'|'degraded', last_error?, degraded_count}
 *                                 ——降级态透出（W3-7 的可观测口）
 *
 * 鉴权（one-on-one.controller 先例同款）：action/草稿拉取=律师端（IdentityAuthGuard+
 * IdentityRoleGuard+@RequireRole('lawyer')——动作发起方=JWT 本人）；health=探针面无守卫
 * （main.ts health.controller 同款；出参无原文/计数级信息，R-02 面干净）。
 * 气泡推送面=WSS（ConversationHub.publishTo 仅律师订阅者，W3-6）——不在本 HTTP 面。
 */
import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseDraftActionBody, parseDraftIdParam, parseDraftListQuery } from './draft.http';
import { DraftService } from './draft.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class DraftController {
  constructor(private readonly drafts: DraftService) {}

  /** POST /drafts/{id}/action（§5：三动作；409 EXPIRED；幂等键=draft+action） */
  @Post('drafts/:id/action')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  action(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.drafts.action(
      parseDraftIdParam(id),
      identity.userId, // 动作归属律师=JWT 本人（agent_review_logs.lawyer_id 锚）
      parseDraftActionBody(body),
    );
  }

  /** GET /agent/drafts?room_id=&status=（律师端断线补拉——气泡帧丢失的 HTTP 收敛面） */
  @Get('agent/drafts')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  list(
    @CurrentIdentity() identity: IdentityClaims,
    @Query('room_id') roomId?: string,
    @Query('status') status?: string,
  ) {
    return this.drafts.listDrafts(
      identity.userId, // per-room 归属门（T4 评审 I-2）：非该房参与方 403
      parseDraftListQuery({ room_id: roomId, status }),
    );
  }

  /** GET /agent/health（§5 健康检查：降级态透出——探针面无守卫，类注） */
  @Get('agent/health')
  health() {
    return this.drafts.health();
  }
}
