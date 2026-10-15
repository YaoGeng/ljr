/**
 * B1 事件消费端（§6）：SlotLocked / SlotReleased / SlotTtlExpired → 状态视图缓存主动失效。
 * 经 relay 现有机制（OutboxRelayService.registerHandler，identity.consumer 同款形态）。
 * 消费幂等：失效天然幂等，at-least-once 重投零副作用；载荷缺/坏 lawyer_id → 抛错进重试轨道
 * （不静默丢弃——载荷漂移显性化，A3a 评审口径）。Slot* 事件由 B2 生产，B1 只消费不改（W2 预检裁决）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { SLOT_LOCKED_TOPIC, SLOT_RELEASED_TOPIC, SLOT_TTL_EXPIRED_TOPIC } from './slot-lock.events';
import { SlotViewCache } from './time-table.cache';

/** 三个 Slot* 载荷的公共切面（slot-lock.events 具名载荷均含 lawyer_id） */
interface LawyerScopedPayload {
  readonly lawyer_id?: unknown;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 独立可测的失效 handler：三 topic 共用（按载荷 lawyer_id 失效该律师全部视图条目） */
export function createSlotViewCacheEvictHandler(cache: SlotViewCache): OutboxHandler {
  return async (event: RelayEvent): Promise<void> => {
    const payload = (event.payload ?? {}) as Partial<LawyerScopedPayload>;
    if (!isPositiveInt(payload.lawyer_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `事件 ${event.topic} 载荷缺 lawyer_id（进重试轨道，不静默丢弃）`,
      );
    }
    cache.invalidateLawyer(payload.lawyer_id);
  };
}

@Injectable()
export class SlotViewCacheEvictConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly cache: SlotViewCache,
  ) {}

  onModuleInit(): void {
    const handler = createSlotViewCacheEvictHandler(this.cache);
    this.relay.registerHandler(SLOT_LOCKED_TOPIC, handler);
    this.relay.registerHandler(SLOT_RELEASED_TOPIC, handler);
    this.relay.registerHandler(SLOT_TTL_EXPIRED_TOPIC, handler);
  }
}
