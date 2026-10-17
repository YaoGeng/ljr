/**
 * F3 事件消费端（§6；W3 可达面=合成事件桩 + A3b/I2 真通路；测试直投 outbox 沿 T2/T6 先例）：
 *   ① RoomClosed（fulfillment.room.closed，D1=M2 合成桩）：进结算 PENDING→HOLD（§4 FINISHED 链头，
 *      R-02 冻结期同事务起算）——ref=(session, session_id)；
 *   ② OneOnOneSettled（fulfillment.one_on_one.settled，D6=M2 合成桩）：进结算 ref=(one_on_one,
 *      order_id)（§3 逐字）；载荷 net=D6 实结参考价不参与构成（契约定型注记，M2 联调对齐位）；
 *   ③ AttendanceAdjudicated（fulfillment.attendance.adjudicated，D3=M2 合成桩；与 G1 同 topic
 *      扇出并存）：owner_type=user 且 result=absent → R-03 缺席 70/30 触发位；normal/late 与
 *      律师缺席（D4 违约域）不改变构成；无结算行（D3 先于 RoomClosed 的真实时序）=NO_SETTLEMENT
 *      warn 显性（M2 D3/D1 联调换装位，不炸不静默）；
 *   ④ FirmMerchantSuspended（payment.firm_merchant.suspended，A3b 真事件）：该律所未结算全量挂起
 *      SUSPENDED（R-07；CHANGING 变更期暂停语义同拒语义已在 assertSplittable 侧，事件驱动挂起位）；
 *   ⑤ FirmMerchantActivated（payment.firm_merchant.activated，A3b 真事件）：恢复重驱动——READY 化
 *      行 + 已 READY 滞留行（F-2）逐条 runSettlementById（F1 外部指令在消费链承担，resume 原子面
 *      只做状态迁移）；部分失败整体抛错进 relay 重试轨道，重入由 F-2 READY 直驱 + §10-7 幂等
 *      短路只补未结算行；
 *   ⑥ TicketResolved（ops.ticket.resolved，H3=M2 合成桩）：HOLD 工单挂起释放——冻结期未满仅闭
 *      工单不放行（R-02 双条件，24h job 到期放行）；释放与重试路径恒直驱 runSettlementById
 *      （F-2：释放已提交而结算首跳失败的 READY 滞留行由此补结算，幂等 no-op 兜底其余态）；
 *      结算行不存在=时序桩 warn。
 *   ScheduleJobFired(SETTLE_HOLD_RELEASE) 的消费真通路=I2 执行器（settlement.executors，同事务
 *   承接——执行器抛错随抢占事务整体回滚自 HOLD 重试，无 READY 滞留面），本消费器不重复注册
 *   （事件本身为审计/扇出位——报告注明）。
 *
 * 事务形态（credit/firm-merchant 消费先例）：handler 不用 relay 认领事务的 uow——服务自持事务，
 * 「释放/恢复先提交、结算后行」的崩溃与失败窗口由 F-2 READY 直驱（重投恒补结算）+ 消费幂等
 * （UNIQUE ref / 状态守卫 / §10-7）收敛（at-least-once 语义内）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  ATTENDANCE_ADJUDICATED_TOPIC,
  FIRM_MERCHANT_ACTIVATED_TOPIC,
  FIRM_MERCHANT_SUSPENDED_TOPIC,
  ONE_ON_ONE_SETTLED_TOPIC,
  ROOM_CLOSED_TOPIC,
  TICKET_RESOLVED_TOPIC,
  type AttendanceAdjudicatedPayload,
  type FirmMerchantActivatedPayload,
  type FirmMerchantSuspendedPayload,
  type OneOnOneSettledPayload,
  type RoomClosedPayload,
  type TicketResolvedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { SettlementService } from './settlement.service';
import { moneyToCents, type SettlementRefType } from './settlement.types';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 进结算载荷归一校验（RoomClosed/OneOnOneSettled 共用最小集；漂移→抛错进重试轨道，不静默） */
function assertEnterFields(fields: {
  readonly ref_id: unknown;
  readonly lawyer_id: unknown;
  readonly firm_id: unknown;
  readonly gross: unknown;
  readonly payment_order_id: unknown;
}): {
  ref_id: number;
  lawyer_id: number;
  firm_id: number;
  gross: string;
  payment_order_id: number;
} {
  if (
    !isPositiveInt(fields.ref_id) ||
    !isPositiveInt(fields.lawyer_id) ||
    !isPositiveInt(fields.firm_id) ||
    typeof fields.gross !== 'string' ||
    !/^\d+\.\d{2}$/.test(fields.gross) ||
    moneyToCents(fields.gross) <= 0 ||
    !isPositiveInt(fields.payment_order_id)
  ) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `进结算载荷非法（须 ref/lawyer/firm/payment_order 正整数、gross 两位小数正金额）：${JSON.stringify(fields)}`,
    );
  }
  return {
    ref_id: fields.ref_id,
    lawyer_id: fields.lawyer_id,
    firm_id: fields.firm_id,
    gross: fields.gross,
    payment_order_id: fields.payment_order_id,
  };
}

/** 独立可测的 RoomClosed handler（D1=M2 合成桩；进结算幂等=UNIQUE(ref_type, ref_id)） */
export function createRoomClosedHandler(settlements: SettlementService): OutboxHandler {
  const logger = new Logger('SettlementRoomClosed');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== ROOM_CLOSED_TOPIC) {
      throw new AppError(ErrorCode.InvalidArgument, `进结算消费器收到未注册 topic：${event.topic}`);
    }
    const raw = (event.payload ?? {}) as Partial<RoomClosedPayload>;
    const payload = assertEnterFields({
      ref_id: raw.session_id,
      lawyer_id: raw.lawyer_id,
      firm_id: raw.firm_id,
      gross: raw.gross,
      payment_order_id: raw.payment_order_id,
    });
    const res = await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: payload.ref_id,
      lawyer_id: payload.lawyer_id,
      firm_id: payload.firm_id,
      gross: payload.gross,
      payment_order_id: payload.payment_order_id,
    });
    logger.log(
      `RoomClosed 进结算：session=${payload.ref_id} created=${res.created} status=${res.settlement.status}（event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 OneOnOneSettled handler（D6=M2 合成桩；ref=(one_on_one, order_id) §3 逐字） */
export function createOneOnOneSettledHandler(settlements: SettlementService): OutboxHandler {
  const logger = new Logger('SettlementOneOnOne');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== ONE_ON_ONE_SETTLED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `1对1 结算消费器收到未注册 topic：${event.topic}`,
      );
    }
    const raw = (event.payload ?? {}) as Partial<OneOnOneSettledPayload>;
    const payload = assertEnterFields({
      ref_id: raw.order_id,
      lawyer_id: raw.lawyer_id,
      firm_id: raw.firm_id,
      gross: raw.gross,
      payment_order_id: raw.payment_order_id,
    });
    const res = await settlements.enterSettlement({
      ref_type: 'one_on_one',
      ref_id: payload.ref_id,
      lawyer_id: payload.lawyer_id,
      firm_id: payload.firm_id,
      gross: payload.gross,
      payment_order_id: payload.payment_order_id,
    });
    // 载荷 net=D6 实结参考价：F3 构成以 gross（预付冻结额）为基（契约注记；M2 D6 联调对齐位）
    logger.log(
      `OneOnOneSettled 进结算：order=${payload.ref_id} created=${res.created} status=${res.settlement.status}（event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 AttendanceAdjudicated handler（D3=M2 合成桩；R-03 触发位） */
export function createAttendanceHandler(settlements: SettlementService): OutboxHandler {
  const logger = new Logger('SettlementAttendance');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== ATTENDANCE_ADJUDICATED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `缺席分成消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<AttendanceAdjudicatedPayload>;
    if (
      !isPositiveInt(payload.session_id) ||
      (payload.owner_type !== 'user' && payload.owner_type !== 'lawyer') ||
      (payload.result !== 'normal' && payload.result !== 'late' && payload.result !== 'absent')
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `AttendanceAdjudicated 载荷非法（须 session_id 正整数、owner_type/result 合法）：${JSON.stringify(payload)}`,
      );
    }
    if (payload.owner_type !== 'user' || payload.result !== 'absent') {
      // 律师缺席=D4 违约域（APPLY_PENALTY）；normal/late 不改变构成（§8.5 缺席费仅指用户缺席）
      return;
    }
    const res = await settlements.markAbsenceShare('session', payload.session_id);
    if (res.marked) return;
    if (res.reason === 'NO_SETTLEMENT') {
      // D3 判定先于 RoomClosed 的真实时序（PRD §8.5 流：缺席处理→房间结束→结算）：
      // W3 合成桩按「先 RoomClosed 后判定」直投；真实顺序=M2 D3/D1 联调换装位（显性 warn，不炸）
      logger.warn(
        `缺席分成标记跳过：session=${payload.session_id} 结算行未建（D3 先于 RoomClosed 时序；M2 联调换装位，event_id=${event.eventId}）`,
      );
      return;
    }
    logger.warn(
      `缺席分成标记跳过：session=${payload.session_id} 已 SETTLED（钱已分，补偿流=D4/M2，event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 FirmMerchantSuspended handler（A3b 真事件；R-07 挂起位） */
export function createFirmMerchantSuspendedHandler(settlements: SettlementService): OutboxHandler {
  const logger = new Logger('SettlementMerchantSuspended');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== FIRM_MERCHANT_SUSPENDED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `进件挂起消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<FirmMerchantSuspendedPayload>;
    if (!isPositiveInt(payload.firm_id) || typeof payload.reason !== 'string') {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `FirmMerchantSuspended 载荷非法（须 firm_id 正整数、reason 字符串）：${JSON.stringify(payload)}`,
      );
    }
    const res = await settlements.suspendForFirm(payload.firm_id, payload.reason);
    logger.log(
      `进件挂起传导：firm=${payload.firm_id} reason=${payload.reason} 挂起结算 ${res.suspended} 笔（event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 FirmMerchantActivated handler（A3b 真事件；恢复重驱动链） */
export function createFirmMerchantActivatedHandler(settlements: SettlementService): OutboxHandler {
  const logger = new Logger('SettlementMerchantActivated');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== FIRM_MERCHANT_ACTIVATED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `进件恢复消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<FirmMerchantActivatedPayload>;
    if (!isPositiveInt(payload.firm_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `FirmMerchantActivated 载荷缺 firm_id（进重试轨道，不静默丢弃）`,
      );
    }
    const res = await settlements.resumeForFirm(payload.firm_id);
    const toDrive = [...res.readied, ...res.ready]; // F-2：恢复时已 READY 滞留行（此前结算首跳失败）同样直驱
    const failures: string[] = [];
    for (const id of toDrive) {
      try {
        const run = await settlements.runSettlementById(id); // R-01 唯一解冻节点重驱动
        logger.log(
          `进件恢复重驱动：settlement=${id} settled=${run.settled} suspended=${run.suspended ?? false}`,
        );
      } catch (e) {
        failures.push(`settlement-${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length > 0) {
      // 部分失败进 relay 重试轨道：重入由 resume 幂等（非 SUSPENDED 短路）+ F-2 READY 直驱 + §10-7 只补未结算行
      throw new AppError(
        ErrorCode.OutboxHandlerFailed,
        `FirmMerchantActivated 重驱动部分失败（firm=${payload.firm_id}）：${failures.join('；')}`,
      );
    }
    logger.log(
      `进件恢复传导：firm=${payload.firm_id} readied=${res.readied.length} reheld=${res.reheld} ready=${res.ready.length}（event_id=${event.eventId}）`,
    );
  };
}

/** 独立可测的 TicketResolved handler（H3=M2 合成桩；R-02 工单挂起释放） */
export function createTicketResolvedHandler(settlements: SettlementService): OutboxHandler {
  const logger = new Logger('SettlementTicketResolved');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== TICKET_RESOLVED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `工单释放消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<TicketResolvedPayload>;
    if (
      !isPositiveInt(payload.ticket_id) ||
      (payload.ref_type !== 'session' && payload.ref_type !== 'one_on_one') ||
      !isPositiveInt(payload.ref_id)
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `TicketResolved 载荷非法（须 ticket_id/ref_id 正整数、ref_type 合法）：${JSON.stringify(payload)}`,
      );
    }
    const rel = await settlements.releaseDueHoldByRef(
      payload.ref_type as SettlementRefType,
      payload.ref_id,
      'TICKET_RESOLVED',
    );
    if (rel.missing) {
      // 工单挂起时结算行应已存在（FINISHED 先于纠纷关闭）；缺=时序桩显性 warn（不炸，M2 H3 联调位）
      logger.warn(
        `工单释放跳过：${payload.ref_type}=${payload.ref_id} 结算行未建（时序联调位，ticket=${payload.ticket_id}）`,
      );
      return;
    }
    if (!rel.released) {
      // 未放行两态：HOLD_24H=冻结期未满仅闭工单（24h job 到期放行）；READY=F-2 重试直驱位
      logger.log(
        `工单释放未放行：${payload.ref_type}=${payload.ref_id} blocked=${String(rel.blocked)}（ticket=${payload.ticket_id}）`,
      );
    }
    if (rel.settlement_id !== null) {
      // F-2：释放/重试路径恒直驱（释放已提交而结算首跳失败的 READY 滞留行由此补结算；
      // 幂等——HOLD/SUSPENDED/SETTLED 行 runSettlement 短路 no-op）
      const run = await settlements.runSettlementById(rel.settlement_id);
      logger.log(
        `工单释放处理：${payload.ref_type}=${payload.ref_id} settled=${run.settled} status=${String(run.status ?? 'READY')}（ticket=${payload.ticket_id}）`,
      );
    }
  };
}

@Injectable()
export class SettlementConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly settlements: SettlementService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(ROOM_CLOSED_TOPIC, createRoomClosedHandler(this.settlements));
    this.relay.registerHandler(
      ONE_ON_ONE_SETTLED_TOPIC,
      createOneOnOneSettledHandler(this.settlements),
    );
    this.relay.registerHandler(
      ATTENDANCE_ADJUDICATED_TOPIC,
      createAttendanceHandler(this.settlements),
    );
    this.relay.registerHandler(
      FIRM_MERCHANT_SUSPENDED_TOPIC,
      createFirmMerchantSuspendedHandler(this.settlements),
    );
    this.relay.registerHandler(
      FIRM_MERCHANT_ACTIVATED_TOPIC,
      createFirmMerchantActivatedHandler(this.settlements),
    );
    this.relay.registerHandler(
      TICKET_RESOLVED_TOPIC,
      createTicketResolvedHandler(this.settlements),
    );
  }
}
