/**
 * A3b REST 面（A3b §5 契约表逐字 + Task 3 简报；不扩面）：
 *   POST /firms/{id}/merchant/submit   {channel, materials} → {status}；409 DUPLICATE（幂等键=firm+channel）
 *   POST /firms/{id}/merchant/change   {materials} → {status: CHANGING}（R-W3-C2：Suspended 同事务出箱）
 *   POST /firms/{id}/merchant/reverify → {status}（R-03 复验完成路径——§5 未列的最小补面，报告偏差节记录）
 *   POST /firms/{id}/deposit/freeze    {lawyer_id, batch, amount?} → {escrow_status}；400 INSUFFICIENT
 *                                         （幂等键=firm+batch；amount 缺省=LJR_PAYMENT_DEPOSIT_AMOUNT）
 * 机构回调（F1 承接转投）不走 REST：进件审核结果=适配器异步应答（mock merchantReview 钩子/
 * queryMerchantStatus），经 FirmMerchantService.refreshFromChannel 推进（服务导出面）。
 *
 * TODO(H1-W3-T10): 统一接线 @RequireRole('admin')——本任务鉴权占位（V29 角色枚举 T10 才落位；
 *   G-A 前置门同批接线）。此前形态同 F1 /pay/*（对 Core 内部契约面，服务剥离后由服务间认证接管）。
 */
import { Body, Controller, Param, Post, UseFilters } from '@nestjs/common';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import {
  parseDepositFreezeBody,
  parseMerchantChangeBody,
  parseMerchantSubmitBody,
} from './firm-merchant.http';
import { FirmMerchantService } from './firm-merchant.service';
import { DepositService } from './deposit.service';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class FirmMerchantController {
  constructor(
    private readonly merchants: FirmMerchantService,
    private readonly deposits: DepositService,
  ) {}

  /** POST /firms/{id}/merchant/submit（§5：幂等键=firm+channel；409 DUPLICATE；出参 {status}） */
  @Post('firms/:firmId/merchant/submit')
  async submit(@Param('firmId') firmId: string, @Body() body: unknown): Promise<unknown> {
    const view = await this.merchants.submit({
      firm_id: parsePositiveInt(firmId, 'firmId'),
      ...parseMerchantSubmitBody(body),
    });
    return { status: view.status };
  }

  /** POST /firms/{id}/merchant/change（§5：出参 {status: CHANGING}；R-W3-C2 分账暂停语义） */
  @Post('firms/:firmId/merchant/change')
  async change(@Param('firmId') firmId: string, @Body() body: unknown): Promise<unknown> {
    const view = await this.merchants.change({
      firm_id: parsePositiveInt(firmId, 'firmId'),
      ...parseMerchantChangeBody(body),
    });
    return { status: view.status };
  }

  /** POST /firms/{id}/merchant/reverify（R-03 复验完成路径——§5 未列最小补面；出参 {status}） */
  @Post('firms/:firmId/merchant/reverify')
  async reverify(@Param('firmId') firmId: string): Promise<unknown> {
    const view = await this.merchants.reverify({ firm_id: parsePositiveInt(firmId, 'firmId') });
    return { status: view.status };
  }

  /** POST /firms/{id}/deposit/freeze（§5：幂等键=firm+batch；400 INSUFFICIENT；出参 {escrow_status}） */
  @Post('firms/:firmId/deposit/freeze')
  async freeze(@Param('firmId') firmId: string, @Body() body: unknown): Promise<unknown> {
    const view = await this.deposits.freeze({
      firm_id: parsePositiveInt(firmId, 'firmId'),
      ...parseDepositFreezeBody(body),
    });
    return { escrow_status: view.escrow_status };
  }
}
