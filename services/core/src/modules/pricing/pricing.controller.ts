/**
 * B3 REST 面（§5 + Task 5 简报裁决）：
 *   - GET /lawyer/{id}/pricing           → 当前版本全量 {version, created_at, pricing}
 *   - PUT  /lawyer/pricing               → 全量新配置；律师本人（claims 身份，@RequireRole('lawyer')），
 *                                          幂等键=lawyer+base_version（409 冲突见 service）
 *   - GET /lawyer/{id}/pricing/history   → 版本列表（新在前）
 * 鉴权口径（B1 先例）：GET 面公开/用户态均可（用户端选律师要比价）——最小实现 GET 不设角色限制
 * （报告标注；接线 H1 后如需收紧统一处理）。出参一律 §5 契约词汇 snake_case，Money 字符串。
 */
import { Body, Controller, Get, Param, Put, UseFilters, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { parseLawyerId, parsePutPricingBody } from './pricing.http';
import { PricingConfigService } from './pricing.service';
import type { CurrentPricingView, PricingVersionHistoryItem } from './pricing.types';

@Controller('lawyer')
@UseFilters(AppHttpExceptionFilter)
export class PricingController {
  constructor(private readonly pricing: PricingConfigService) {}

  /** GET /lawyer/{id}/pricing：当前版本全量（无版本={version:0, pricing:null}，乐观锁读侧） */
  @Get(':id/pricing')
  current(@Param('id') id: string): Promise<CurrentPricingView> {
    return this.pricing.getCurrentPricing(parseLawyerId(id));
  }

  /** PUT /lawyer/pricing：全量新配置（幂等键=lawyer+base_version；lawyerId 取 JWT claims，不收 body 注入） */
  @Put('pricing')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  put(
    @CurrentIdentity() identity: IdentityClaims,
    @Body() body: unknown,
  ): Promise<CurrentPricingView> {
    return this.pricing.putPricing(identity.userId, parsePutPricingBody(body));
  }

  /** GET /lawyer/{id}/pricing/history：版本列表（新在前；C3 快照/审计取数面） */
  @Get(':id/pricing/history')
  history(@Param('id') id: string): Promise<PricingVersionHistoryItem[]> {
    return this.pricing.getHistory(parseLawyerId(id));
  }
}
