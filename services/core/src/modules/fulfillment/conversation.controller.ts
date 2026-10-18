/**
 * D5 REST 面（§5 契约表逐字 + M2-W1 T3 简报，不扩面）：
 *   GET /conversations/{id}/messages?after_seq=&limit=   [{seq, sender, content…}]（断线增量
 *     拉取；缺省 limit 50 上限 200，seq 升序）；Bearer 鉴权（IdentityAuthGuard——用户/律师
 *     双角色可读，无 @RequireRole 面约束）。
 *   GET /rooms/{id}/notice                                须知内容块（H7 数据）。
 *
 * 须知复用声明（简报「查 ops room-notice 既有面」的核实结论）：ops 既有面=GET /rooms/
 * notice-content?key=（H7 §5 键位路由，无鉴权 App 面只读）——**路径/语义部分覆盖**（按
 * rule_key 取，无 room id 存在性校验）；D5 契约=按 room id。本面=薄代理：房间存在性校验
 * （本域 rooms）→ H7 导出面 RuleCenterService.noticeContent() 取数（禁跨 schema 直读）；
 * 无鉴权沿 ops 面先例（控制者裁决：App 面只读）。
 */
import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  type IdentityClaims,
} from '../identity/identity.guards';
import { RuleCenterService } from '../ops/rule-center.service';
import type { RoomNoticeView } from '../ops/rule-center.types';
import {
  parseAfterSeq,
  parseConversationIdParam,
  parseLimit,
  parseRoomIdParam,
} from './conversation.http';
import { ConversationService } from './conversation.service';
import type { MessageView } from './conversation.types';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class ConversationController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly rules: RuleCenterService,
  ) {}

  /** GET /conversations/{id}/messages（§5：after_seq 独占下界、limit 缺省 50 上限 200；
   *  C-1 成员门：asUserId=JWT claims——room 型非参与方 403，与 WSS join/send/pull 四口同门） */
  @Get('conversations/:id/messages')
  @UseGuards(IdentityAuthGuard)
  messages(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Query('after_seq') afterSeq?: string,
    @Query('limit') limit?: string,
  ): Promise<MessageView[]> {
    return this.conversations.listMessages({
      conversationId: parseConversationIdParam(id),
      asUserId: identity.userId,
      afterSeq: parseAfterSeq(afterSeq),
      limit: parseLimit(limit),
    });
  }

  /** GET /rooms/{id}/notice（D5 §5；薄代理：房间在位校验 → H7 须知内容块） */
  @Get('rooms/:id/notice')
  async notice(@Param('id') id: string): Promise<RoomNoticeView> {
    const roomId = parseRoomIdParam(id);
    const exists = await this.conversations.roomExists(roomId);
    if (!exists) {
      throw new AppError(ErrorCode.NotFound, `房间 ${roomId} 不存在（须知面仅对在册房间开放）`);
    }
    return this.rules.noticeContent();
  }
}
