/**
 * F4 ②全量券指令消费端（M2-W2 T6）：PRICE_COUPON_INSTRUCTED（C6 W3 已出箱，GT10 档）→
 * CouponService.grantPriceComp（ACTIVE 行+CouponGranted 出箱；幂等=UNIQUE(source,
 * source_ref)——指令 at-least-once 重放短路）。载荷非法进重试轨道不静默丢弃（house 口径）。
 *
 * 独立文件防环：points.module（BenefitsModule）装配本消费端，absence.consumer.ts 反向
 * import BenefitsModule（BenefitsConsumersModule 装配）——券指令面并入该文件即成
 * points.module ↔ absence.consumer 文件环（Nest 扫描期 undefined），故独立置文件。
 */
import {
  AppError,
  ErrorCode,
  PRICE_COUPON_INSTRUCTED_TOPIC,
  type PriceCouponInstructedPayload,
} from '@ljr/shared';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { CouponService } from './coupon.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** PRICE_COUPON_INSTRUCTED → 券发放（独立可测工厂，attendance.consumer 同形态） */
export function createPriceCouponInstructedHandler(coupons: CouponService): OutboxHandler {
  const logger = new Logger('F4CouponInstruction');
  return async (event: RelayEvent) => {
    if (event.topic !== PRICE_COUPON_INSTRUCTED_TOPIC) {
      throw new AppError(ErrorCode.InvalidArgument, `券指令消费器收到未注册 topic：${event.topic}`);
    }
    const payload = (event.payload ?? {}) as Partial<PriceCouponInstructedPayload>;
    if (
      !isPositiveInt(payload.price_change_id) ||
      !isPositiveInt(payload.lawyer_id) ||
      !isPositiveInt(payload.user_id) ||
      payload.coupon_kind !== 'PRICE_COMP'
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `PRICE_COUPON_INSTRUCTED 载荷非法（须 price_change_id/lawyer_id/user_id 正整数且 coupon_kind=PRICE_COMP）：${JSON.stringify(payload)}`,
      );
    }
    const r = await coupons.grantPriceComp({
      price_change_id: payload.price_change_id,
      user_id: payload.user_id,
    });
    if (r.deduplicated) {
      logger.log(
        `券指令幂等短路：price_change=${payload.price_change_id} user=${payload.user_id} grant=${r.grant.id}（event_id=${event.eventId}）`,
      );
      return;
    }
    logger.log(
      `券发放完成：price_change=${payload.price_change_id} user=${payload.user_id} grant=${r.grant.id} 面额=${r.grant.face_value} 到期=${r.grant.expires_at}`,
    );
  };
}

/** 消费端装配（onModuleInit 注册进 relay；BenefitsModule 内——无 payment 依赖） */
@Injectable()
export class CouponInstructionConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly coupons: CouponService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(
      PRICE_COUPON_INSTRUCTED_TOPIC,
      createPriceCouponInstructedHandler(this.coupons),
    );
  }
}
