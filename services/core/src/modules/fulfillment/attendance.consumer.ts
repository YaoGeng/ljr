/**
 * D3 事件消费端（M2-W2 T2；§6 消费面）：PresenceJoined/PresenceLeft（D5 W1 生产——presence
 * 权威链路）→ attendances 幂等写入；GracePeriodEnded（D1 W1 生产——事件即止，判定归 D3）
 * → job1 判定核心（attendance.service.adjudicateOnGraceEnd）。
 *
 * 事务形态：消费效果经 relay 认领事务的 uow（效果与 SENT 标记同事务——conversation.consumer
 * 同款 relay-uow 形态）。幂等两层：presence=UNIQUE(room_id,user_id) upsert（重复事件不双写，
 * §8）；判定=adjudicated_at 非空短路（job 重放/事件重投无重复事件）。
 *
 * 防御位（简报口径）：非 room 型会话（private/one_on_one 的 presence 无到场判定语义）与
 * 不存在的房间 → 忽略并记日志（不进重试轨道——确定性无害事件，烧重试无意义）；载荷缺
 * 最小集 → AppError 进重试轨道不静默丢弃（house 口径）。
 */
import {
  AppError,
  ErrorCode,
  GRACE_PERIOD_ENDED_TOPIC,
  PRESENCE_JOINED_TOPIC,
  PRESENCE_LEFT_TOPIC,
} from '@ljr/shared';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import type { AttendanceRole } from './attendance.types';
import { AttendanceService } from './attendance.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function parseRole(v: unknown): AttendanceRole {
  if (v !== 'user' && v !== 'lawyer') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `presence 载荷 role 越域（user|lawyer）：${String(v)}`,
    );
  }
  return v;
}

/**
 * presence handler（join/leave 共体，direction 分派）：会话锚定（room 型才判——ref_id=房间 id）
 * → 房间存在性防御 → attendances 幂等落行。at=载荷房间时刻戳（服务器接收时刻，D5 口径）。
 */
export function createPresenceHandler(
  attendance: AttendanceService,
  direction: 'joined' | 'left',
): OutboxHandler {
  const logger = new Logger(direction === 'joined' ? 'D3PresenceJoined' : 'D3PresenceLeft');
  const topic = direction === 'joined' ? PRESENCE_JOINED_TOPIC : PRESENCE_LEFT_TOPIC;
  return async (event: RelayEvent, uow) => {
    if (event.topic !== topic) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `presence 消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<{
      conversation_id: unknown;
      ref_id: unknown;
      user_id: unknown;
      role: unknown;
      at: unknown;
    }>;
    if (
      !isPositiveInt(payload.conversation_id) ||
      !isPositiveInt(payload.user_id) ||
      typeof payload.at !== 'string' ||
      !Number.isFinite(Date.parse(payload.at))
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `presence 载荷缺 conversation_id/user_id/at 最小集或 at 非可解析时刻（进重试轨道，不静默丢弃）`,
      );
    }
    const role = parseRole(payload.role);
    const at = new Date(payload.at);
    const conversation = await attendance.roomConversationRef(uow, payload.conversation_id);
    if (!conversation || conversation.type !== 'room') {
      logger.log(
        `忽略非 room 会话 presence：conversation=${String(payload.conversation_id)} type=${conversation?.type ?? '不存在'}`,
      );
      return;
    }
    if (!(await attendance.roomExists(uow, conversation.ref_id))) {
      logger.warn(`忽略不存在房间的 presence：room=${conversation.ref_id}（防御位）`);
      return;
    }
    await attendance.recordPresence(uow, conversation.ref_id, payload.user_id, role, direction, at);
  };
}

/** GracePeriodEnded handler：job1 判定核心（§4 第一级；D1 W1 事件即止的判定半边） */
export function createGracePeriodEndedHandler(attendance: AttendanceService): OutboxHandler {
  const logger = new Logger('D3GraceAdjudication');
  return async (event: RelayEvent, uow) => {
    if (event.topic !== GRACE_PERIOD_ENDED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `宽限结束消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<{ room_id: unknown; session_id: unknown }>;
    if (!isPositiveInt(payload.room_id) || !isPositiveInt(payload.session_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `GracePeriodEnded 载荷缺 room_id/session_id 最小集（进重试轨道，不静默丢弃）`,
      );
    }
    // maxEventId=判定事件上界：重放只看本事件之前已提交的 presence 序列（快照语义）
    const r = await attendance.adjudicateOnGraceEnd(uow, payload.room_id, event.id);
    if (r.judged) {
      logger.log(
        `grace_end 判定完成：room=${r.room_id} normal=${r.normal} in_service=${r.in_service} cancelled=${r.cancelled}`,
      );
    } else {
      logger.log(`grace_end 判定跳过（room 终态/缺失幂等无操作）：room=${r.room_id}`);
    }
  };
}

@Injectable()
export class AttendanceConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly attendance: AttendanceService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(
      PRESENCE_JOINED_TOPIC,
      createPresenceHandler(this.attendance, 'joined'),
    );
    this.relay.registerHandler(PRESENCE_LEFT_TOPIC, createPresenceHandler(this.attendance, 'left'));
    this.relay.registerHandler(
      GRACE_PERIOD_ENDED_TOPIC,
      createGracePeriodEndedHandler(this.attendance),
    );
  }
}
