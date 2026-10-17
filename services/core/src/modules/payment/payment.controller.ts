/**
 * F1 REST 面（§5 契约表逐字 + Task 1 简报；不扩面）：
 *   POST /pay/orders                  {biz_type, biz_id, cash_amount, points_amount, idempotency_key} → {payment_order, pay_params}；409 DUP_KEY
 *   POST /pay/refund                  {order_id, cash_refund, points_refund, reason, idempotency_key} → {refund}；409 DUP
 *   POST /pay/split                   {order_id, splits[], idempotency_key} → {result}；409 DUP
 *   POST /pay/deduct                  {lawyer_id, amount, from: settlement|deposit, idempotency_key} → {result}；400 INSUFFICIENT
 *   POST /callbacks/{channel}         通道报文（验签）→ 200 / 403 SIGN_FAIL（Inbox 去重）
 *   POST /admin/payment/reconcile     {period, channels?}（⚠W3-10 手动触发面，@UseFilters 新过滤器形态）
 *
 * 鉴权口径：/pay/* 为「对 Core」内部契约面（模块化单体=进程内服务调用为主，HTTP 面是契约
 * 钉死与联调通道；§5 未列鉴权列）——服务剥离（V2 演进）后由服务间认证接管（报告注明）；
 * /callbacks/* 由通道调用（验签即鉴权）；/admin/payment/reconcile=运营手动触发面（W3 T10
 * 修复轮，评审 Important-1：⚠决策位占位兑现）挂 @RequireRole('admin')——未认证 401 /
 * 未持 admin 旗标 403；服务剥离后由服务间认证接管。
 * 回调验签需原始字节（rawBody）——进程入口 main.ts 以 rawBody:true 装载。
 */
import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { IdentityAuthGuard, IdentityRoleGuard, RequireRole } from '../identity/identity.guards';
import type { RawBodyRequest } from './payment.http';
import {
  parseDeductBody,
  parseOrderBody,
  parseReconcileBody,
  parseRefundBody,
  parseSplitBody,
} from './payment.http';
import { PaymentGatewayService } from './payment.gateway.service';
import { PaymentReconcileService } from './payment.reconcile.service';

/** 通道回调签名头（通道无关统一头；报文原文=rawBody 字节） */
const SIGNATURE_HEADER = 'x-payment-signature';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class PaymentController {
  constructor(
    private readonly gateway: PaymentGatewayService,
    private readonly recon: PaymentReconcileService,
  ) {}

  /** POST /pay/orders（§5：幂等键=idempotency_key；409 DUP_KEY） */
  @Post('pay/orders')
  createOrder(@Body() body: unknown): Promise<unknown> {
    return this.gateway.createOrder(parseOrderBody(body));
  }

  /** POST /pay/refund（§5：指令下发→REFUNDING；409 DUP 同口径；出参 {refund} 契约表逐字） */
  @Post('pay/refund')
  refund(@Body() body: unknown): Promise<unknown> {
    return this.gateway.refund(parseRefundBody(body)).then((r) => ({ refund: r }));
  }

  /** POST /pay/split（§5：splits 求和 ≤ 可分金额；409 DUP；出参 {result} 契约表逐字） */
  @Post('pay/split')
  split(@Body() body: unknown): Promise<unknown> {
    return this.gateway.split(parseSplitBody(body)).then((r) => ({ result: r }));
  }

  /** POST /pay/deduct（§5：400 INSUFFICIENT；幂等键；出参 {result} 契约表逐字） */
  @Post('pay/deduct')
  deduct(@Body() body: unknown): Promise<unknown> {
    return this.gateway.deduct(parseDeductBody(body)).then((r) => ({ result: r }));
  }

  /** POST /callbacks/{channel}（§5：200/403 SIGN_FAIL；Inbox 去重） */
  @Post('callbacks/:channel')
  @HttpCode(200)
  callback(@Param('channel') channel: string, @Req() req: RawBodyRequest): Promise<unknown> {
    if (req.rawBody === undefined) {
      // 进程未以 rawBody:true 装载——验签无法字节级进行，显性化不静默
      throw new AppError(
        ErrorCode.InternalError,
        '回调验签要求 rawBody（main.ts 须以 rawBody:true 装载）',
      );
    }
    const header = req.headers[SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;
    return this.gateway.ingestCallback(channel, req.rawBody, signature ?? null);
  }

  /** POST /admin/payment/reconcile（⚠W3-10：手动触发；T+1 定时挂 I2 属 M2；W3 T10 修复轮 admin 守卫） */
  @Post('admin/payment/reconcile')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('admin')
  @HttpCode(200)
  reconcile(@Body() body: unknown): Promise<unknown> {
    return this.recon.reconcile(parseReconcileBody(body));
  }
}
