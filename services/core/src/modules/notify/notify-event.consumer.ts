/**
 * 通知类事件消费者（I1 §6 消费：全域通知类事件 ReminderDispatched/PriceChangeApproved/...）。
 *
 * ⚠决策位（机制先行，契约对齐后置）：上游生产方（C6 改价/D2 提醒）M1-W1 尚未落位，
 * topic 与载荷契约暂以本文件为准（载荷字段=§5 DISPATCH_NOTIFY 契约 {user_id, template_code,
 * params, idempotency_key}），W2+/W3 生产方落位时联调对齐——错位即 handler 抛错进重试轨道/
 * 死信（不静默丢弃），不会误投递。
 *
 * 消费幂等：登记走 notify.notifications.idempotency_key 唯一约束（R-03）——载荷带幂等键用之，
 * 缺省回落 event.eventId（at-least-once 重投同一事件=同键，一次触达；demo 同口径以 event_id
 * 为消费幂等事实源）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError, ErrorCode, isValidIdempotencyKey } from '@ljr/shared';
import type { RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import type { OutboxHandler } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { NotifyDispatcherService } from './notify-dispatcher.service';

/** 通知类事件 topic 暂定集（⚠ 生产方落位后联调对齐，见头注） */
export const NOTIFY_EVENT_TOPICS = [
  'trade.price.change.approved',
  'schedule.reminder.dispatched',
] as const;

/** 通知类事件载荷契约（=§5 DISPATCH_NOTIFY 字段；idempotency_key 缺省回落 event_id） */
export interface NotifyEventPayload {
  readonly user_id: number;
  readonly template_code: string;
  readonly params?: Record<string, unknown>;
  readonly idempotency_key?: string;
}

/** 独立可测的消费者逻辑：载荷校验 → 幂等登记 QUEUED（渲染/偏好/下发由 dispatcher 驱动承接） */
export function createNotifyEventHandler(dispatcher: NotifyDispatcherService): OutboxHandler {
  return async (event: RelayEvent, uow: SqlExecutor): Promise<void> => {
    const payload = (event.payload ?? {}) as Partial<NotifyEventPayload>;
    if (
      typeof payload.user_id !== 'number' ||
      !Number.isInteger(payload.user_id) ||
      typeof payload.template_code !== 'string'
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `通知事件 ${event.topic} 载荷缺 user_id/template_code（进重试轨道，不静默丢弃）`,
      );
    }
    if (payload.idempotency_key !== undefined && !isValidIdempotencyKey(payload.idempotency_key)) {
      throw new AppError(
        ErrorCode.IdempotencyKeyInvalid,
        `通知事件幂等键非法：${JSON.stringify(payload.idempotency_key)}`,
      );
    }
    await dispatcher.registerForEvent(uow, {
      userId: payload.user_id,
      templateCode: payload.template_code,
      params: payload.params ?? {},
      idempotencyKey: payload.idempotency_key ?? event.eventId,
    });
  };
}

@Injectable()
export class NotifyEventConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly dispatcher: NotifyDispatcherService,
  ) {}

  onModuleInit(): void {
    const handler = createNotifyEventHandler(this.dispatcher);
    for (const topic of NOTIFY_EVENT_TOPICS) {
      this.relay.registerHandler(topic, handler);
    }
  }
}
