/**
 * D1 房间生命周期服务（§2/§4/§5/§6 + M2-W1 T1 简报裁决）——履约域应用服务导出面
 * （PaymentModule 可剥离纪律同形：只暴露应用服务+事件契约+HTTP 契约；机器/执行器/RTC 适配器
 * 为模块内部件，其他模块禁 import）。
 *
 * 开房（ROOM_OPEN 执行器经 I2 调用，job 内部路径不走 HTTP）：
 *   快照（scheduled_start/mode）经 trade 导出面 getDetail 取（禁直连跨域 SQL，R-04 透传）；
 *   RTC 建房经 RTC_PROVIDER 适配器（mock=W1，声网=M3-W1 换装缝）；成功 → INSERT rooms
 *   （OPEN，grace_end=scheduled_start+5min **应用层锚定**——R-01 开房延迟不吞宽限，与 job
 *   实际触发时刻无关）+ 同事务预写 GRACE_END job（due=grace_end，refType='room'）与
 *   REMIND_GRACE_END job（due=grace_end−1min，M2-W1 T4——D2 宽限结束前 1min 房间提醒
 *   定时器，同锚约定时刻）+ RoomOpened 出箱；失败（适配器异常）→ CANCELLED 行直插
 *   （初始态承载，open_fail_reason 截 64）+ RoomOpenFailed 出箱——**不发出任何信用事件**
 *   （G1 桩验证），无 GRACE_END/REMIND_GRACE_END 预写。
 *
 * 宽限结束（GRACE_END 执行器）：出箱 GracePeriodEnded **即止**——判定=D3（W2 事件消费，
 * 附录 A.2 裁决；D1 §9 禁止跳过 D3 直接判缺席/改 room 状态）。
 *
 * 关闭（close API，job/律师端）：OPEN/IN_SERVICE→CLOSED（守卫+STL，entity_type='room'）+
 * closed_at（DB 钟）+ RoomClosed 出箱。律师端经 controller 传 actorLawyerId（JWT claims），
 * 与归属锚 lawyer_id 不符 → 403 RoleForbidden（归属校验）；job 路径无 actor。
 * 聚合口径：lawyer_id/firm_id 经 trade 导出面
 * closeAnchorOf（firm_id=A3a 档案绑定，A3b 进件前 null → 显式失败不静默）；paid 清单经
 * payment 域 RefundSourceRegistry.resolve('session')（R-W3-M 契约）；gross=Σ(cash+points)
 * 整数分（100 积分=1 元，D19 paid_amount 全额口径）；payment_order_id=**首单**（W3 单单
 * 绑定口径；多单会话=后续换装位——真通道多单分账时改聚合策略，头注声明）。无 PAID 单/
 * 无 firm 绑定（理论不发生）→ AppError 显式失败。
 *
 * 消费面口径（D1 §6「SessionFull/Confirmed 预建房间占位」的 W1 落地形态）：ROOM_OPEN job
 * 由 C1/C3 创建时同事务预写（M1-W3 T4 落位，session.service L318-323 同款）——job 预写即
 * 占位形态，**本批不新增 SessionFull 事件消费器**（简报裁决，防双写竞态）。
 * IN_SERVICE 迁入边生产者=D3/W2（room.machine 头注声明词汇，本批不接线）。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  REFUND_SOURCE_REF_TYPE_SESSION,
  ROOM_CLOSED_TOPIC,
  ROOM_OPENED_TOPIC,
  ROOM_OPEN_FAILED_TOPIC,
  GRACE_PERIOD_ENDED_TOPIC,
  type GracePeriodEndedPayload,
  type RoomClosedPayload,
  type RoomOpenFailedPayload,
  type RoomOpenedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { RefundSourceRegistry } from '../payment/refund.source';
import { SchedulerService } from '../schedule/scheduler.service';
import { SessionService } from '../trade/session.service';
import { ROOM_MACHINE, ROOM_TERMINAL_STATUSES } from './room.machine';
import { RTC_PROVIDER, type RtcProvider } from './rtc-provider';
import { ConversationService } from './conversation.service';
import {
  GROSS_MAX_CENTS,
  GRACE_PERIOD_MS,
  OPEN_FAIL_REASON_MAX,
  REMIND_GRACE_END_LEAD_MS,
  assertPositiveInt,
  assertRoomMode,
  centsToMoney,
  moneyToCents,
  type GraceEndOutcome,
  type GrossAggregation,
  type RoomClosedResult,
  type RoomOpenOutcome,
  type RoomStatus,
} from './room.types';

interface RoomRow {
  readonly id: string;
  readonly session_id: string;
  readonly mode: string;
  readonly scheduled_start: Date;
  readonly opened_at: Date | null;
  readonly grace_end: Date;
  readonly closed_at: Date | null;
  readonly status: string;
  readonly open_fail_reason: string | null;
}

const ROOM_COLS = `id, session_id, mode, scheduled_start, opened_at, grace_end, closed_at, status, open_fail_reason`;

@Injectable()
export class RoomService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    // 跨模块消费全部走导出服务（trade 快照/聚合锚、F2 退款源注册表）——禁跨 schema join（架构 §3.2 红线）
    private readonly sessions: SessionService,
    private readonly refundSources: RefundSourceRegistry,
    // D5 会话服务（同域同模块直注入——开房成功同事务建 room 会话，M2-W1 T3 纯加法）
    private readonly conversations: ConversationService,
    // RTC 通道适配器（Symbol token：module useFactory 装配，测试构造直传/mock 注入失败形态）
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
  ) {}

  // ===========================================================================
  // 开房（ROOM_OPEN 执行器；§5 POST /rooms/{session_id}/open 的 job 内部承载，不走 HTTP）
  // ===========================================================================

  /**
   * 开房：幂等短路（§5 幂等键=session，ux_rooms_session DB 兜底——并发双插第二路 23505 进
   * 重试后收敛到本短路）→ trade 快照 → RTC 建房 → OPEN 行+GRACE_END 预写+RoomOpened 同事务；
   * 适配器异常 → CANCELLED 行+RoomOpenFailed 同事务（平台取消分支，零信用事件）。
   */
  async openRoomForSession(uow: SqlExecutor, sessionId: number): Promise<RoomOpenOutcome> {
    const id = assertPositiveInt(sessionId, 'session_id');
    const existing = await uow.query<RoomRow>(
      `SELECT ${ROOM_COLS} FROM fulfillment.rooms WHERE session_id = $1 FOR UPDATE`,
      [id],
    );
    const prev = existing.rows[0];
    if (prev) {
      // 已建房间（含开房失败 CANCELLED——失败分支终态，不重试开房）：无副作用幂等返回
      return { opened: false, room_id: Number(prev.id), session_id: id, deduplicated: true };
    }

    // 快照经 trade 导出面（scheduled_start 同源锚；mode=场次 room_mode 透传，R-04）
    const detail = await this.sessions.getDetail(id);
    const mode = assertRoomMode(detail.room_mode);
    const scheduledStart = new Date(detail.slot_start);
    // R-01 核心锚：grace_end=scheduled_start+5min，与 job 实际触发时刻无关（misfire 90s 不吞宽限）
    const graceEnd = new Date(scheduledStart.getTime() + GRACE_PERIOD_MS);

    try {
      await this.rtc.buildRoom({ sessionId: id, mode });
    } catch (e) {
      // 开房失败→平台取消分支（D1 §4）：CANCELLED 直插（初始态承载）+RoomOpenFailed 出箱；
      // 不发信用事件（G1 桩验证）、不预写 GRACE_END（终态房间无宽限语义）
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, OPEN_FAIL_REASON_MAX);
      const failed = await uow.query<RoomRow>(
        `INSERT INTO fulfillment.rooms
           (session_id, mode, scheduled_start, grace_end, status, open_fail_reason)
         VALUES ($1, $2, $3, $4, 'CANCELLED', $5)
         RETURNING ${ROOM_COLS}`,
        [id, mode, scheduledStart, graceEnd, reason],
      );
      const failedRow = failed.rows[0]!;
      await this.outbox.recordOutbox(uow, {
        type: ROOM_OPEN_FAILED_TOPIC,
        payload: { session_id: id, reason } satisfies RoomOpenFailedPayload,
      });
      return { opened: false, room_id: Number(failedRow.id), session_id: id, reason };
    }

    const inserted = await uow.query<RoomRow>(
      `INSERT INTO fulfillment.rooms
         (session_id, mode, scheduled_start, opened_at, grace_end, status)
       VALUES ($1, $2, $3, now(), $4, 'OPEN')
       RETURNING ${ROOM_COLS}`,
      [id, mode, scheduledStart, graceEnd],
    );
    const row = inserted.rows[0]!;
    const roomId = Number(row.id);

    // D5 room 会话同事务落位（M2-W1 T3 纯加法）：开房成功即建会话（UNIQUE(type,ref_id) 幂等
    // ——重放短路路径上方已 return，此处恒新建；join 门校验会话存在的前置生产者）
    await this.conversations.ensureConversation('room', roomId, { uow });

    // GRACE_END 同事务预写（附录 A.2：due=grace_end 锚约定时刻；refType='room'）
    await this.scheduler.registerJob(uow, {
      jobType: 'GRACE_END',
      refType: 'room',
      refId: roomId,
      dueAt: graceEnd,
    });
    // REMIND_GRACE_END 同事务预写（M2-W1 T4，目录第 25 项）：D2 宽限结束前 1min 房间消息的
    // 定时器——due=grace_end−1min 同锚约定时刻（executor=D2，见 notify/reminder.executors）
    await this.scheduler.registerJob(uow, {
      jobType: 'REMIND_GRACE_END',
      refType: 'room',
      refId: roomId,
      dueAt: new Date(graceEnd.getTime() - REMIND_GRACE_END_LEAD_MS),
    });
    await this.outbox.recordOutbox(uow, {
      type: ROOM_OPENED_TOPIC,
      payload: {
        room_id: roomId,
        session_id: id,
        grace_end: graceEnd.toISOString(),
      } satisfies RoomOpenedPayload,
    });
    return { opened: true, room_id: roomId, session_id: id };
  }

  // ===========================================================================
  // 宽限结束（GRACE_END 执行器；事件即止——判定=D3/W2，D1 §9 禁止项）
  // ===========================================================================

  /** GRACE_END 幂等回查锚点（I2 目录 recheckAnchor 的字面承载）：room 仍 OPEN 才需触发 */
  async statusOf(exec: SqlExecutor, roomId: number): Promise<RoomStatus | null> {
    const res = await exec.query<{ status: string }>(
      `SELECT status FROM fulfillment.rooms WHERE id = $1`,
      [assertPositiveInt(roomId, 'room_id')],
    );
    const status = res.rows[0]?.status;
    return status === undefined ? null : (status as RoomStatus);
  }

  /**
   * D2 房间内提醒锚（M2-W1 T4 纯读窄面，加法）：场次的进行中房间 id（OPEN/IN_SERVICE——
   * D2 §4「进行中房间」字面承载；IN_SERVICE 词汇=W2 D3 生产者，查询面预留）。无房间/
   * 已终态 → null（REMIND×4 不发房间消息的判定半边）。exec=job uow 同事务读（本域直读）。
   */
  async activeRoomIdOfSession(exec: SqlExecutor, sessionId: number): Promise<number | null> {
    const res = await exec.query<{ id: string }>(
      `SELECT id FROM fulfillment.rooms
        WHERE session_id = $1 AND status IN ('OPEN', 'IN_SERVICE')
        LIMIT 1`,
      [assertPositiveInt(sessionId, 'session_id')],
    );
    const row = res.rows[0];
    return row === undefined ? null : Number(row.id);
  }

  /** 宽限结束：出箱 GracePeriodEnded 即止——不改 room 状态（IN_SERVICE/缺席判定=D3=W2 消费） */
  async endGracePeriod(uow: SqlExecutor, roomId: number): Promise<GraceEndOutcome> {
    const id = assertPositiveInt(roomId, 'room_id');
    const res = await uow.query<RoomRow>(
      `SELECT ${ROOM_COLS} FROM fulfillment.rooms WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return { ended: false, room_id: id, session_id: null };
    const sessionId = Number(row.session_id);
    if (row.status !== 'OPEN') {
      // recheck 与 execute 间的防御性复核（同 uow 无竞态；终态房间无宽限结束语义）
      return { ended: false, room_id: id, session_id: sessionId };
    }
    await this.outbox.recordOutbox(uow, {
      type: GRACE_PERIOD_ENDED_TOPIC,
      payload: { room_id: id, session_id: sessionId } satisfies GracePeriodEndedPayload,
    });
    return { ended: true, room_id: id, session_id: sessionId };
  }

  // ===========================================================================
  // 关闭（§5 POST /rooms/{session_id}/close：job/律师端；幂等键=session，409 NOT_OPEN 当已终态）
  // ===========================================================================

  /**
   * 关闭房间：FOR UPDATE 行锁 → 终态 409（NOT_OPEN）→ 归属锚（room→session→lawyer，经 trade
   * closeAnchorOf）→ **归属校验**（opts.actorLawyerId 携带时与锚 lawyer_id 比对，非本人 →
   * 403 RoleForbidden——律师端越权关他人场次；缺省=job/系统路径无 actor，D3/W2 NO_SHOW_CLOSE
   * 同形）→ 守卫迁移 CLOSED（STL 留痕）→ closed_at（DB 钟）→ RoomClosed 聚合出箱（同事务
   * ——聚合失败则整体回滚，close 不落地）。
   */
  async closeRoom(
    sessionId: number,
    opts?: { readonly uow?: SqlExecutor; readonly actorLawyerId?: number },
  ): Promise<RoomClosedResult> {
    const id = assertPositiveInt(sessionId, 'session_id');
    const run = async (exec: SqlExecutor): Promise<RoomClosedResult> => {
      const found = await exec.query<RoomRow>(
        `SELECT ${ROOM_COLS} FROM fulfillment.rooms WHERE session_id = $1 FOR UPDATE`,
        [id],
      );
      const row = found.rows[0];
      if (!row) {
        throw new AppError(ErrorCode.NotFound, `房间不存在：场次 ${id} 未开房`);
      }
      const current = row.status as RoomStatus;
      const roomId = Number(row.id);
      if ((ROOM_TERMINAL_STATUSES as readonly RoomStatus[]).includes(current)) {
        throw new AppError(
          ErrorCode.Conflict,
          `房间 ${roomId} 已终态（${current}），不可关闭（409 NOT_OPEN）`,
        );
      }

      // RoomClosed 聚合锚（F3 结算构成最小集，W3 契约定型 import 不重定义）——归属校验前置
      const anchor = await this.sessions.closeAnchorOf(id);
      if (!anchor) {
        throw new AppError(ErrorCode.NotFound, `场次不存在：${id}（房间在而场次缺失=数据漂移）`);
      }
      if (opts?.actorLawyerId !== undefined && opts.actorLawyerId !== anchor.lawyer_id) {
        throw new AppError(
          ErrorCode.RoleForbidden,
          `律师 ${opts.actorLawyerId} 非场次 ${id} 属主（lawyer=${anchor.lawyer_id}），不可关闭他人场次房间`,
        );
      }
      if (anchor.firm_id === null) {
        throw new AppError(
          ErrorCode.Conflict,
          `律师 ${anchor.lawyer_id} 未绑定律所（A3b 进件前 firm_id=null），场次 ${id} 的 RoomClosed 结算构成缺 firm_id——显式失败不静默`,
        );
      }
      await this.guard.assertTransition(ROOM_MACHINE, {
        entityId: roomId,
        from: current,
        to: 'CLOSED',
        reason: 'room_close',
        uow: exec,
      });
      const updated = await exec.query<{ closed_at: Date }>(
        `UPDATE fulfillment.rooms SET status = 'CLOSED', closed_at = now()
          WHERE id = $1 AND status = $2 RETURNING closed_at`,
        [roomId, current],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `房间 ${roomId} 已被并发迁移`);
      }
      const agg = await this.aggregateGross(id);
      await this.outbox.recordOutbox(exec, {
        type: ROOM_CLOSED_TOPIC,
        payload: {
          session_id: id,
          lawyer_id: anchor.lawyer_id,
          firm_id: anchor.firm_id,
          gross: agg.gross,
          payment_order_id: agg.payment_order_id,
        } satisfies RoomClosedPayload,
      });
      return { closed_at: new Date(updated.rows[0]!.closed_at).toISOString() };
    };
    return opts?.uow ? run(opts.uow) : this.pool.withTransaction(run);
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /**
   * gross/payment_order_id 聚合：paid 清单经 F2 退款源注册表（'session' 键=R-W3-M 契约，
   * trade 真源 T7 落位）；gross=Σ(cash 分+points)（100 积分=1 元 → 1 积分=1 分，D19
   * paid_amount 全额口径）整数分全程无浮点；payment_order_id=首单（W3 单单绑定口径）。
   */
  private async aggregateGross(sessionId: number): Promise<GrossAggregation> {
    const source = this.refundSources.resolve(REFUND_SOURCE_REF_TYPE_SESSION);
    if (!source) {
      throw new AppError(
        ErrorCode.ConfigInvalid,
        `退款源 'session' 未注册（F2 RefundSourceRegistry）——close 的 gross 聚合链路未装配`,
      );
    }
    const orders = await source.listPaidPaymentOrders(sessionId);
    if (orders.length === 0) {
      throw new AppError(
        ErrorCode.Conflict,
        `场次 ${sessionId} 无 PAID 支付单——RoomClosed 结算构成缺失（理论不发生：报名成团链先行），显式失败不静默`,
      );
    }
    let grossCents = 0;
    for (const order of orders) {
      grossCents += moneyToCents(order.cash_amount) + order.points_amount;
    }
    if (grossCents > GROSS_MAX_CENTS) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `gross 聚合超出 NUMERIC(12,2) 上限：${String(grossCents)} 分`,
      );
    }
    return { gross: centsToMoney(grossCents), payment_order_id: orders[0]!.payment_order_id };
  }
}
