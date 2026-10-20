/**
 * D6 REST 面（§5 契约表逐字 + T2 行，不扩面）：
 *   POST /one-on-one                      {room_id, service_type, mode} → {order, payment_order}；
 *                                          402 REALNAME / 400 PRICE_MISSING；幂等键=user+room+type
 *   POST /one-on-one/{id}/accept          → {conversation_id}；409 TIMEOUT；幂等键=order
 *   POST /one-on-one/{id}/finish          {consumed_units?} → {order, advisory?}；409 NOT_IN_SERVICE
 *   POST /one-on-one/{id}/settle-confirm  {role, settle_amount} → {...}；409 MISMATCH；幂等键=order
 *   POST /one-on-one/{id}/settle-diff/pay → {diff_payment_order}；409 NOT_CONFIRMED；幂等键=order
 *   POST /one-on-one/{id}/cancel          {role?} → {order, refund}；409 NOT_CANCELLABLE
 *   POST /one-on-one/{id}/duration        {duration_seconds}——RTC 时长回调（dev 面：mock 注入用，
 *                                          真链=RTC 服务回调 M3 换装；无 JWT——通道侧面）
 *
 * 鉴权（cancellation.controller 同款先例）：create/settle-diff/pay/cancel/settle-confirm=
 *   IdentityAuthGuard（create/settle-diff/pay=user 面；settle-confirm/cancel 双角色面——body.role
 *   与 JWT 激活角色比对不符 403）；accept/finish=律师端（IdentityRoleGuard('lawyer')，归属校验
 *   在服务面 actor 比对——room.controller close 同款）；duration=dev 通道面无守卫（注记）。
 */
import { Body, Controller, Inject, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { AppHttpExceptionFilter } from '../../infrastructure/app-error.filter';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  CurrentIdentity,
  IdentityAuthGuard,
  IdentityRoleGuard,
  RequireRole,
  type IdentityClaims,
} from '../identity/identity.guards';
import { OneOnOneService } from './one-on-one.service';
import { ONE_ON_ONE_CONFIG, type OneOnOneConfig } from './one-on-one.config';
import {
  parseConsumedUnitsField,
  parseDurationSecondsField,
  parseModeField,
  parseOrderIdParam,
  parseRoomIdField,
  parseServiceTypeField,
  parseSettleAmountField,
} from './one-on-one.http';
import { parseOooRole } from './one-on-one.http';

@Controller()
@UseFilters(AppHttpExceptionFilter)
export class OneOnOneController {
  constructor(
    private readonly orders: OneOnOneService,
    // I-5b 修复环：duration 端点环境闸（Symbol token 注入——service 同款口径）
    @Inject(ONE_ON_ONE_CONFIG) private readonly config: OneOnOneConfig,
  ) {}

  /** POST /one-on-one（§5：幂等键=user+room+type；402 REALNAME/400 PRICE_MISSING） */
  @Post('one-on-one')
  @UseGuards(IdentityAuthGuard)
  create(@CurrentIdentity() identity: IdentityClaims, @Body() body: Record<string, unknown>) {
    return this.orders.create({
      room_id: parseRoomIdField(body['room_id']),
      service_type: parseServiceTypeField(body['service_type']),
      mode: parseModeField(body['mode']),
      user_id: identity.userId, // 下单人=JWT 本人（防代下单）
    });
  }

  /** POST /one-on-one/{id}/accept（§5：409 TIMEOUT；归属=JWT actor 与服务律师比对） */
  @Post('one-on-one/:id/accept')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  accept(@CurrentIdentity() identity: IdentityClaims, @Param('id') id: string) {
    return this.orders.accept(parseOrderIdParam(id), { actorLawyerId: identity.userId });
  }

  /** POST /one-on-one/{id}/finish（§5：409 NOT_IN_SERVICE；consumed 声明仅回执 W3-15） */
  @Post('one-on-one/:id/finish')
  @UseGuards(IdentityAuthGuard, IdentityRoleGuard)
  @RequireRole('lawyer')
  finish(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.orders.finish(
      parseOrderIdParam(id),
      parseConsumedUnitsField(body['consumed_units']),
      {
        actorLawyerId: identity.userId,
      },
    );
  }

  /** POST /one-on-one/{id}/settle-confirm（§5：409 MISMATCH；双方各一次，role 与 JWT 角色比对） */
  @Post('one-on-one/:id/settle-confirm')
  @UseGuards(IdentityAuthGuard)
  settleConfirm(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const role = parseOooRole(body['role']);
    if (identity.role !== role) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `body.role=${role} 与当前激活角色 ${identity.role} 不符（实结确认方=JWT 本人）`,
      );
    }
    return this.orders.settleConfirm(
      parseOrderIdParam(id),
      { role, settle_amount: parseSettleAmountField(body['settle_amount']) },
      { actorUserId: identity.userId },
    );
  }

  /** POST /one-on-one/{id}/settle-diff/pay（§5：409 NOT_CONFIRMED；幂等键=order） */
  @Post('one-on-one/:id/settle-diff/pay')
  @UseGuards(IdentityAuthGuard)
  settleDiffPay(@CurrentIdentity() identity: IdentityClaims, @Param('id') id: string) {
    return this.orders.settleDiffPay(parseOrderIdParam(id), { actorUserId: identity.userId });
  }

  /** POST /one-on-one/{id}/cancel（§5：409 NOT_CANCELLABLE；role 缺省 user 与 JWT 角色比对） */
  @Post('one-on-one/:id/cancel')
  @UseGuards(IdentityAuthGuard)
  cancel(
    @CurrentIdentity() identity: IdentityClaims,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const role = parseOooRole(body['role'], 'user');
    if (identity.role !== role) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `body.role=${role} 与当前激活角色 ${identity.role} 不符（取消发起方=JWT 本人）`,
      );
    }
    return this.orders.cancel(parseOrderIdParam(id), {
      role,
      actorUserId: identity.userId,
    });
  }

  /**
   * POST /one-on-one/{id}/duration（计量面：RTC 时长回调——voice/video 段数=ceil(秒/900) 单调
   * 上界 W3-9；首次回调触发 IN_SERVICE=W3-8）。dev 面：mock 注入用、无 JWT 守卫；**I-5b 环境
   * 闸：非 dev（staging/prod）404**（LJR_FULFILLMENT_OOO_DURATION_CALLBACK 可显式覆盖）；
   * 真链=rtc-im 服务回调（M3-W1 换装：守卫+通道验签随换装补）。
   */
  @Post('one-on-one/:id/duration')
  recordDuration(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!this.config.durationCallbackEnabled) {
      // 404 形态隐藏端点（非 dev 不暴露 dev 注入面）
      throw new AppError(
        ErrorCode.NotFound,
        `计量回调端点未开放（dev 专用面——LJR_ENV 非 dev；真链=rtc-im 服务回调，M3-W1 换装）`,
      );
    }
    return this.orders.recordDuration(
      parseOrderIdParam(id),
      parseDurationSecondsField(body['duration_seconds']),
    );
  }
}
