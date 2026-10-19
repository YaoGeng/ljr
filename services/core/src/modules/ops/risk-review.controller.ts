/**
 * H5 人审闭环 REST 面（§5 契约表，M2-W2 T7）：
 *   GET  /admin/risk/queue                    人审队列（待处置记录，新在前+筛选分页）
 *   POST /admin/risk/records/{id}/review      处置 {verdict, note?}（已处置 409 DONE；
 *                                             幂等键=record——不翻案、恰一次审计）
 *
 * 鉴权：word-admin/ticket 同款 guard 形态（A.4 逐字）——类级 IdentityAuthGuard+
 * IdentityRoleGuard + 每端点 @RequireRole('admin')：未认证 401 / 未持 admin 旗标 403。
 * reviewed_by=claims userId（@CurrentIdentity 注入，audit-log.actor 同口径）。
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { parseQueueQuery, parseReviewBody } from './risk-review.http';
import { RiskReviewService } from './risk-review.service';

@Controller('admin/risk')
@UseFilters(AppHttpExceptionFilter)
@UseGuards(IdentityAuthGuard, IdentityRoleGuard)
export class RiskReviewController {
  constructor(private readonly riskReview: RiskReviewService) {}

  /** GET /admin/risk/queue?dict_type=&action=&limit=&offset=：待处置队列（处置后自动跌出） */
  @Get('queue')
  @RequireRole('admin')
  async queue(
    @Query('dict_type') dictType?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: Awaited<ReturnType<RiskReviewService['listQueue']>> }> {
    const items = await this.riskReview.listQueue(
      parseQueueQuery({ dict_type: dictType, action, limit, offset }),
    );
    return { items };
  }

  /** POST /admin/risk/records/{id}/review：处置（verdict 三值；FALSE_POSITIVE 通知位=V1
   *  直发桩；已处置 409 DONE；reviewed_at=DB 钟） */
  @Post('records/:id/review')
  @HttpCode(200) // 动作端点非资源创建（ticket resolve/rule-admin @HttpCode(200) 先例）
  @RequireRole('admin')
  async review(
    @Param('id') id: string,
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<Awaited<ReturnType<RiskReviewService['reviewRecord']>>> {
    const { verdict, note } = parseReviewBody(body);
    return this.riskReview.reviewRecord({
      recordId: parsePositiveInt(id, 'record_id'),
      operatorId: identity.userId,
      verdict,
      note,
    });
  }
}
