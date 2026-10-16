/**
 * C2 REST 面（§5 契约表逐字 + Task 5 简报；不扩面）：
 *   POST /group-buys                  {lawyer_id, specialty, slot_start, sub_min, sub_max,
 *                                      question_tags, deadline?} → {group_buy, share_price,
 *                                      payment_order}
 *                                      409 E_SLOT_TAKEN/E_GROUP_BUY_DUP_KEY、400 越界、403 E_RESTRICTED
 *   GET  /group-buys?specialty=       列表（已加入数=桩 null/倒计时 deadline/分摊额）→ 裸数组
 *   POST /group-buys/{id}/cancel      → {status}（409 E_HAS_JOINED）
 *   POST /group-buys/{id}/recreate    → {group_buy_id}（幂等键=source_id）
 *
 * 鉴权（§5 逐字）：发起/取消/重发起 @RequireRole('user')+@CurrentIdentity（发起人=用户，
 * lawyer_id 取 body——用户指定目标律师，与 C1 律师自开团取 claims 方向相反）；GET 列表公开无鉴权
 * （沿 C1 列表口径，H1 接线统一收紧）。
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
import { parseGroupBuyBody, parseGroupBuyListQuery } from './group-buy.http';
import { GroupBuyService } from './group-buy.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class GroupBuyController {
  constructor(private readonly groupBuys: GroupBuyService) {}

  /** POST /group-buys（§5：幂等键=user+slot_start；409/400/403） */
  @Post('group-buys')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  create(@CurrentIdentity() identity: IdentityClaims, @Body() body: unknown): Promise<unknown> {
    return this.groupBuys.create({ ...parseGroupBuyBody(body), initiator_id: identity.userId });
    // §5 出参 {group_buy, share_price, payment_order} 三键（PublishGroupBuyResult 原样出站）
  }

  /** GET /group-buys?specialty=（§5：公开列表，鉴权「否」） */
  @Get('group-buys')
  list(@Query() query: Record<string, unknown>): Promise<unknown> {
    return this.groupBuys.list(parseGroupBuyListQuery(query));
  }

  /** POST /group-buys/{id}/cancel（§5：→ {status}；409 HAS_JOINED） */
  @Post('group-buys/:id/cancel')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  cancel(@CurrentIdentity() identity: IdentityClaims, @Param('id') id: string): Promise<unknown> {
    return this.groupBuys.cancel(parsePositiveInt(id, 'id'), identity.userId);
  }

  /** POST /group-buys/{id}/recreate（§5：→ 新任务 ID；幂等键=source_id） */
  @Post('group-buys/:id/recreate')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('user')
  recreate(@CurrentIdentity() identity: IdentityClaims, @Param('id') id: string): Promise<unknown> {
    return this.groupBuys.recreate(parsePositiveInt(id, 'id'), identity.userId);
  }
}
