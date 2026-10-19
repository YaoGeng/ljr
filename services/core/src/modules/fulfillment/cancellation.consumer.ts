/**
 * D4 事件消费端（§6 消费：AttendanceAdjudicated 律师 absent 触发缺席分支；RoomOpenFailed
 * 平台取消分支）。事务形态=效果自持事务（统一出箱点/F3 指令面各自池事务——credit.consumer
 * 「emit 自持事务」同款），handler 不占 relay 认领事务的 uow；崩溃窗口「已提交而 SENT 未
 * 标」→ 重投由出箱点 prior 短路+赔付收据键重放收敛（at-least-once 语义内恰一次）。
 *
 * 幂等（§8）：
 *   - AttendanceAdjudicated（lawyer absent）：adjudication_id 与场次 N:1（一场次一律师一
 *     缺席判定）→ 终态/既有事件短路即事件级去重（无独占表——D4 §3，报告注记）；
 *   - RoomOpenFailed：D1 开房失败一次性事件（room 幂等键=session DB 兜底），重投同短路。
 *
 * 防御位：user 缺席/late/律师 normal 等非缺席判定=无取消语义，log 跳过不进重试（确定性
 * 无害事件）；载荷缺最小集 → AppError 进重试轨道不静默丢弃（attendance.consumer 同口径）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  ATTENDANCE_ADJUDICATED_TOPIC,
  ROOM_OPEN_FAILED_TOPIC,
  type AttendanceAdjudicatedPayload,
  type RoomOpenFailedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { CancellationService } from './cancellation.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** AttendanceAdjudicated handler：仅 lawyer+absent 触发缺席自动终止（其余判定归 G1/F3/F4） */
export function createLawyerAbsenceHandler(cancellations: CancellationService): OutboxHandler {
  const logger = new Logger('D4LawyerAbsence');
  return async (event: RelayEvent) => {
    if (event.topic !== ATTENDANCE_ADJUDICATED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `缺席终止消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<AttendanceAdjudicatedPayload>;
    if (
      !isPositiveInt(payload.adjudication_id) ||
      !isPositiveInt(payload.session_id) ||
      !isPositiveInt(payload.owner_id)
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `AttendanceAdjudicated 载荷缺 adjudication_id/session_id/owner_id 最小集（进重试轨道，不静默丢弃）`,
      );
    }
    if (payload.owner_type !== 'user' && payload.owner_type !== 'lawyer') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `AttendanceAdjudicated 载荷 owner_type 越域（user|lawyer）：${String(payload.owner_type)}`,
      );
    }
    if (payload.result !== 'normal' && payload.result !== 'late' && payload.result !== 'absent') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `AttendanceAdjudicated 载荷 result 越域（normal|late|absent）：${String(payload.result)}`,
      );
    }
    if (payload.owner_type !== 'lawyer' || payload.result !== 'absent') {
      // 用户缺席（70/30 分成=F3/F4 消费）、迟到/正常——无场次取消语义（确定性无害，不烧重试）
      logger.log(
        `非律师缺席判定，跳过取消路径：owner=${payload.owner_type} result=${payload.result} session=${payload.session_id}`,
      );
      return;
    }
    const out = await cancellations.terminateForLawyerAbsence({
      sessionId: payload.session_id,
      lawyerId: payload.owner_id,
      adjudicationId: payload.adjudication_id,
    });
    if (out.executed) {
      logger.log(
        `律师缺席自动终止完成：session=${payload.session_id} lawyer=${payload.owner_id} adjudication=${payload.adjudication_id}`,
      );
    } else {
      logger.log(
        `律师缺席终止短路（终态/既有取消）：session=${payload.session_id} adjudication=${payload.adjudication_id}`,
      );
    }
  };
}

/** RoomOpenFailed handler：平台取消分支（R-06 任意时刻全退零信用——room 行 D1 已 CANCELLED） */
export function createRoomOpenFailedHandler(cancellations: CancellationService): OutboxHandler {
  const logger = new Logger('D4PlatformCancel');
  return async (event: RelayEvent) => {
    if (event.topic !== ROOM_OPEN_FAILED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `平台取消消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<RoomOpenFailedPayload>;
    if (!isPositiveInt(payload.session_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `RoomOpenFailed 载荷缺 session_id（进重试轨道，不静默丢弃）`,
      );
    }
    const out = await cancellations.cancelForPlatform(
      payload.session_id,
      `room_open_failed:${payload.reason ?? '<none>'}`,
    );
    if (!out.executed && !out.prior) {
      logger.warn(
        `开房失败平台取消撞终态：session=${payload.session_id} status=${String(out.status)}（不取消）`,
      );
    }
  };
}

@Injectable()
export class CancellationConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly cancellations: CancellationService,
  ) {}

  onModuleInit(): void {
    // 同 topic 多 handler 扇出由 relay 承接：AttendanceAdjudicated（G1/F3/F4 M1 在位）、
    // RoomOpenFailed（本批 D4 唯一新增消费方——A.4 清单）
    this.relay.registerHandler(
      ATTENDANCE_ADJUDICATED_TOPIC,
      createLawyerAbsenceHandler(this.cancellations),
    );
    this.relay.registerHandler(
      ROOM_OPEN_FAILED_TOPIC,
      createRoomOpenFailedHandler(this.cancellations),
    );
  }
}
