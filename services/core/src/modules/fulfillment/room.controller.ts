/**
 * D1 REST 面（§5 契约表逐字 + M2-W1 T1 简报，不扩面）：
 *   POST /rooms/{session_id}/close   {closed_at}；409 NOT_OPEN（已终态）/404 未开房/
 *                                    403 E_ROLE_FORBIDDEN（角色不符或归属不符——非本场律师）
 *   POST /rooms/{session_id}/open    —— §5 标注「job 内部」：ROOM_OPEN 经 I2 执行器驱动，
 *                                    不落 HTTP 路由（简报「内部 job 调用路径不走 HTTP」）
 *
 * 鉴权（D1 §5 close=「job/律师端」的律师端半边）：@UseGuards(IdentityAuthGuard,
 * IdentityRoleGuard)+@RequireRole('lawyer')+@CurrentIdentity（session.controller POST
 * /sessions 同款先例）——user token 打本面 403 E_ROLE_FORBIDDEN（角色守卫）；律师端归属
 * 校验=actor（JWT claims userId）经服务面与场次属主 lawyer_id 比对，非本人 403
 * E_ROLE_FORBIDDEN（归属越权，T1 评审 Important-1+Minor-7 落位）。job 半边=D3/W2 经服务面
 * （uow，无 actor）调用，不经 HTTP。
 */
import { Controller, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseSessionIdParam } from './room.http';
import { RoomService } from './room.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class RoomController {
  constructor(private readonly rooms: RoomService) {}

  /** POST /rooms/{session_id}/close（§5：幂等键=session；409 NOT_OPEN 当已终态；归属=JWT actor） */
  @Post('rooms/:session_id/close')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  close(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('session_id') sessionId: string,
  ): Promise<unknown> {
    return this.rooms.closeRoom(parseSessionIdParam(sessionId), {
      actorLawyerId: identity.userId, // 归属校验锚=JWT claims（lawyer_id 不收 body——防越权代关）
    });
  }
}
