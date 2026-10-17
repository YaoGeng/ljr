/**
 * C6 REST 面（§5 契约表逐字；不扩面）：
 *   POST /lawyer/pricing/change        → 改价申请（引擎判定；@RequireRole('lawyer')）
 *   POST /pricing/change/{id}/approve  → 审批回调（①期人工兜底 approval_source=MANUAL）
 *   POST /pricing/change/{id}/revoke   → 24h 撤销（律师本人；他人行 404 不暴露存在性）
 *   GET  /pricing/histories?lawyer_id= → 改价记录列表（审计/比对取数面）
 *
 * 鉴权口径：/lawyer/* = JWT 本人语义面 + @RequireRole('lawyer')（B3 PUT 同款）；
 * GET 面公开（B3 GET 先例：最小实现不设角色限制，报告标注）。
 *
 * TODO(H1-W3-T10): /pricing/change/{id}/approve 统一接线 @RequireRole('admin')——本任务鉴权
 *   占位（admin 角色枚举 T10 才落位），形态照 A3b /firms/* 与 F3 /admin/settlements 先例。
 *
 * 429 FREQ_EXCEEDED 契约位保留不用：PRD §8.2 无滥用 429 明确定义（简报 T9 裁决），超限
 * 走审批兜底档（200 PENDING_APPROVAL）——本面不产生 429。
 */
import { Body, Controller, Get, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { AppError, ErrorCode } from '@ljr/shared';
import { PriceChangeService } from './price-change.service';
import { parseApproveBody, parseChangeBody, parseHistoryId } from './price-change.http';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class PriceChangeController {
  constructor(private readonly priceChange: PriceChangeService) {}

  /** POST /lawyer/pricing/change：改价申请（幂等键=lawyer+new_version，UNIQUE 物理兜底） */
  @Post('lawyer/pricing/change')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  request(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<{ result: string; history_id: number; new_version: number }> {
    return this.priceChange.requestChange(identity.userId, parseChangeBody(body));
  }

  /** POST /pricing/change/{id}/approve：①人工兜底（TODO(H1-W3-T10) admin 接线） */
  @Post('pricing/change/:id/approve')
  approve(@Param('id') id: string, @Body() body: unknown): Promise<{ result: string }> {
    return this.priceChange.approve(parseHistoryId(id), parseApproveBody(body));
  }

  /** POST /pricing/change/{id}/revoke：24h 撤销（律师本人；R-04 不扣信用） */
  @Post('pricing/change/:id/revoke')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  revoke(@Param('id') id: string, @CurrentIdentity() identity: IdentityClaims): Promise<{ status: string }> {
    return this.priceChange.revoke(parseHistoryId(id), identity.userId);
  }

  /** GET /pricing/histories?lawyer_id=：改价记录列表 */
  @Get('pricing/histories')
  list(@Query('lawyer_id') lawyerId: string | undefined): Promise<unknown[]> {
    if (lawyerId === undefined || lawyerId === '') {
      throw new AppError(ErrorCode.InvalidArgument, 'lawyer_id 查询参数必填');
    }
    return this.priceChange.listHistories(parsePositiveInt(lawyerId, 'lawyer_id'));
  }
}
