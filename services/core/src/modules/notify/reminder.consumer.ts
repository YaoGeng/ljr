/**
 * D2 事件消费端（M2-W1 T4；§6 消费面之「宽限开始房间消息」）：
 *   RoomOpened（fulfillment.room.opened，D1 生产——T1 已出箱）→ postInternalMessage
 *   @Agent 名义「宽限期已开始」房间消息（sender_role='agent'、mention='agent'，非法律意见
 *   声明；postInternalMessage 头注声明的许可面之一）。
 *   RescheduleConfirmed（trade.reschedule.confirmed，C5 生产——M2-W2 T5 新增）：提醒重投的
 *   **防御复核**消费位（W1 头注交接兑现）。重投效果本身零操作——REMIND×4 job 是场次锚（创建
 *   事务锚 slot_start 预写）且分发对象=执行时点 PAID 清单动态取数：确认事务旧行置
 *   RESCHEDULED_OUT 天然跌出旧场次清单、迁移新行天然进入目标场次清单（届时提醒自动重投）；
 *   本消费面复核=迁移链漂移显性化（new_enrollment_id 非 session 型 PAID 行/指向不符 → 进
 *   重试轨道不静默），通过则零动作记日志（C5 任务报告裁定口径）。
 *
 * 事务形态：消费效果经 relay 认领事务的 uow（效果与 SENT 标记同事务——conversation.consumer
 * 同款 relay-uow 形态）。幂等=relay inbox 的 SENT 标记（一事件恰一次投递）；at-least-once
 * 崩溃窗重投可能重复落消息行（messages 无系统消息判重键，W1 接受——REMIND_GRACE_END 重放
 * 同口径，头注声明；W2 评审随回执表一并收口）。
 */
import { AppError, ErrorCode, RESCHEDULE_CONFIRMED_TOPIC, ROOM_OPENED_TOPIC } from '@ljr/shared';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { EnrollmentService } from '../trade/enrollment.service';
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

/** RescheduleConfirmed handler：提醒重投防御复核（效果零操作；漂移进重试轨道不静默） */
export function createRescheduleConfirmedHandler(enrollments: EnrollmentService): OutboxHandler {
  const logger = new Logger('D2RescheduleConfirmed');
  return async (event: RelayEvent) => {
    if (event.topic !== RESCHEDULE_CONFIRMED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `改期确认消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<{
      old_enrollment_id: unknown;
      new_enrollment_id: unknown;
      session_id: unknown;
      user_id: unknown;
    }>;
    if (
      !isPositiveInt(payload.old_enrollment_id) ||
      !isPositiveInt(payload.new_enrollment_id) ||
      !isPositiveInt(payload.session_id) ||
      !isPositiveInt(payload.user_id)
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `RescheduleConfirmed 载荷缺 old/new_enrollment_id/session_id/user_id 最小集（进重试轨道，不静默丢弃）`,
      );
    }
    // 复核迁移链（trade 导出窄面 resolveEnrollment，禁跨 schema join）：新行须 session 型
    // PAID 且指向载荷场次与属主——不符=确认事务迁移链漂移，显性化进重试轨道
    const enrollment = await enrollments.resolveEnrollment(payload.new_enrollment_id);
    if (
      !enrollment ||
      enrollment.ref_type !== 'session' ||
      enrollment.ref_id !== payload.session_id ||
      enrollment.pay_status !== 'PAID' ||
      enrollment.user_id !== payload.user_id
    ) {
      throw new AppError(
        ErrorCode.InternalError,
        `改期确认 ${event.eventId} 迁移链复核失败：报名 ${payload.new_enrollment_id} 非场次 ${payload.session_id} 的 PAID 属主行（不应触达）`,
      );
    }
    logger.log(
      `改期确认复核通过（提醒重投零操作——REMIND 按目标场次 PAID 清单动态重投）：enrollment=${payload.new_enrollment_id} session=${payload.session_id}`,
    );
  };
}

@Injectable()
export class ReminderConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly reminders: ReminderDispatchService,
    private readonly enrollments: EnrollmentService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(ROOM_OPENED_TOPIC, createRoomOpenedHandler(this.reminders));
    this.relay.registerHandler(
      RESCHEDULE_CONFIRMED_TOPIC,
      createRescheduleConfirmedHandler(this.enrollments),
    );
  }
}
