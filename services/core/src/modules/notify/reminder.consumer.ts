/**
 * D2 事件消费端（M2-W1 T4；§6 消费面之「宽限开始房间消息」）：
 *   RoomOpened（fulfillment.room.opened，D1 生产——T1 已出箱）→ postInternalMessage
 *   @Agent 名义「宽限期已开始」房间消息（sender_role='agent'、mention='agent'，非法律意见
 *   声明；postInternalMessage 头注声明的许可面之一）。
 *
 * 事务形态：消费效果经 relay 认领事务的 uow（效果与 SENT 标记同事务——conversation.consumer
 * 同款 relay-uow 形态）。幂等=relay inbox 的 SENT 标记（一事件恰一次投递）；at-least-once
 * 崩溃窗重投可能重复落消息行（messages 无系统消息判重键，W1 接受——REMIND_GRACE_END 重放
 * 同口径，头注声明；W2 评审随回执表一并收口）。
 *
 * 未消费（交接注记）：RescheduleConfirmed（改期重投）=C5/W2 落位；SessionCancelled（作废）
 * =D4/W2 落位——W1 取消面只有流标路径（session.service failOnDeadline 已补 REMIND×4 同事务
 * 作废钩）。
 */
import { AppError, ErrorCode, ROOM_OPENED_TOPIC } from '@ljr/shared';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { ReminderDispatchService } from './reminder.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** RoomOpened handler：宽限开始房间消息（@Agent 名义；载荷缺最小集进重试轨道不静默丢弃） */
export function createRoomOpenedHandler(reminders: ReminderDispatchService): OutboxHandler {
  const logger = new Logger('D2RoomOpened');
  return async (event: RelayEvent, uow) => {
    if (event.topic !== ROOM_OPENED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `宽限开始消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<{
      room_id: unknown;
      session_id: unknown;
      grace_end: unknown;
    }>;
    if (
      !isPositiveInt(payload.room_id) ||
      !isPositiveInt(payload.session_id) ||
      typeof payload.grace_end !== 'string' ||
      !Number.isFinite(Date.parse(payload.grace_end)) // 修环 M4：非解析时刻同属坏载荷
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `RoomOpened 载荷缺 room_id/session_id/grace_end 最小集或 grace_end 非可解析时刻（进重试轨道，不静默丢弃）`,
      );
    }
    await reminders.postGraceStartedReminder(uow, payload.room_id, payload.grace_end);
    logger.log(`宽限开始房间消息已发：room=${payload.room_id} session=${payload.session_id}`);
  };
}

@Injectable()
export class ReminderConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly reminders: ReminderDispatchService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(ROOM_OPENED_TOPIC, createRoomOpenedHandler(this.reminders));
  }
}
