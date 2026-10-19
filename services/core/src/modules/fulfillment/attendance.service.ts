/**
 * D3 到场与缺席判定服务（D3 §2/§4/§5/§7/§8）——fulfillment 域应用服务导出面（M2-W2 T2）。
 *
 * presence 消费（§6 消费 PresenceJoined/Left）：upsert attendances（UNIQUE(room_id,user_id)
 * 幂等——重复 join 不双写，只推 first_join_at（首次）/last_seen_at；leave 不清除行——判定看
 * 快照）。非 room 型会话（private/one_on_one）与不存在的房间=防御位忽略并记日志。
 *
 * 两级判定（§4，判定锚=grace_end 约定时刻系，禁 now() 漂移锚）：
 *   job1（GracePeriodEnded 消费，D1 W1 已发事件即止——判定归 D3）：room FOR UPDATE→仍 OPEN
 *     才判；在场性=**presence 序列重放**（D5 的 PresenceJoined/Left 事件留痕按 id 升序=事件
 *     写入序重放——D5 事件即序列事实源；attendances 无序列列，V39 蓝图逐列不加；取数经基座
 *     只读面 OutboxService.listEventsByPayload——修复环 Minor-5，域模块不持 outbox 表知识）
 *     ——join 后无 leave=在场/leave 后无 join=不在场 + 抖动容忍（[grace_end−tolerance,
 *     grace_end] 内有 join 记录即在场，配置项默认 60s，R-05 断线重连 ≤60s 不误判）。在场者
 *     status=NORMAL+adjudicated_at；律师在场且 ≥1 用户在场 → room OPEN→IN_SERVICE（守卫+
 *     STL）+ROOM_IN_SERVICE 出箱；全员（律师+全部 PAID 报名用户）缺席 → 平台取消路径：
 *     room OPEN→CANCELLED（守卫+STL，reason='no_show'）+SessionCancelled(platform)（shared
 *     既有契约，cancelled_at=DB 钟）+全员 ABSENT 判定逐人出箱。律师不在场（有用户在场）
 *     →不判律师缺席（其判定归 job2 的 15min 边界）。
 *   job2（ABSENT_15M 执行器，due=grace_end+15min=D1 预写同锚）：仍未判定成员——**presence
 *     序列重放到 deadline（grace_end+15min）判末位事件**（修复环 I-1 裁定：at<=deadline 的
 *     最后一条事件为 join（含恰好 deadline 进入，R-01 边界含端点）=LATE（旁听——期间进入且
 *     仍在/最后在房）；为 leave 或无事件=ABSENT（早进早走者不在场，补建缺席行）——旧口径
 *     「first_join_at<=deadline 即 LATE」会把宽限内进入+grace_end 前离场未归者误判 LATE，
 *     已废；first_join_at 列保留观测锚，不参与判据）；容忍窗关闭（tolerance=0——deadline
 *     判据纯末位事件）。逐人 AttendanceAdjudicated 出箱。
 *     ⚠W2-10 裁定=判定与房间生命周期正交（PRD §8.5 分成依据不因关房丢失，04 §8 回写随
 *     T10）：recheck 锚=room 非 CANCELLED（CANCELLED=平台取消路径已由 job1 全员缺席分支
 *     承载、presence 面已无意义）且存在未判定成员——律师经 close API 提前关房（OPEN→
 *     CLOSED）后缺席判定照常补判（70/30 分成依据不静默缺失）；04 §8 回写随 T10。
 *   NO_SHOW_CLOSE 执行器（due 同锚）：recheck=room 仍 OPEN（关闭动作对 OPEN 房间才有语义
 *     ——CLOSED=律师已收场、CANCELLED=job1 已处理）；执行=attendances 判定结果
 *     复核——无任何在场/已判 NORMAL|LATE 行且 presence 重放无人在场 → 平台取消路径（job1
 *     事件丢失/死信的兜底承载，附录 A.2「关闭动作承载」）；有人在场 → 无操作（房间生命周期
 *     归 close API/D4）。job1 已处理全员缺席（room CANCELLED）→ recheck=false 幂等无操作。
 *
 * AttendanceAdjudicated 出箱（§6 生产）：载荷=shared 既有契约 {adjudication_id(=本行 id),
 * session_id, owner_type(=role), owner_id, result}——D3 §6 文档形 {room_id,user_id,role,
 * status} 与 shared 冲突以 shared 为准（M1 消费面 G1/F3 在用，任务裁定禁双写漂移）。幂等=
 * adjudicated_at 非空不重写不重发（§8 判定 job 重放短路）。R-02：本模块只发事件不实现金额
 * （70/30 分成/30% 积分=F3/F4 消费侧）。
 *
 * confirm-arrival（D2 §5 契约，M2-W2 T2 落位——W1 无锚禁建假 API 的补位）：幂等键=enrollment
 * ——经 trade 导出面 resolveEnrollment 解析 user+session→room（本域）→ 写/改 attendances
 * （status=NORMAL+first_join_at=now()：人工确认到场=NORMAL，D2 文档注记口径）+恰一次
 * AttendanceAdjudicated(normal)。已判定行（adjudicated_at 非空）→ 无操作返回现状（判定
 * 终态不翻案：>15min 缺席者确认到场不改 ABSENT，R-01 费用不退口径）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  ATTENDANCE_ADJUDICATED_TOPIC,
  PRESENCE_JOINED_TOPIC,
  PRESENCE_LEFT_TOPIC,
  ROOM_IN_SERVICE_TOPIC,
  SESSION_CANCELLED_TOPIC,
  type AttendanceAdjudicatedPayload,
  type RoomInServicePayload,
  type SessionCancelledPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { EnrollmentService } from '../trade/enrollment.service';
import { SessionService } from '../trade/session.service';
import { ATTENDANCE_CONFIG, type AttendanceConfig } from './attendance.config';
import { ROOM_MACHINE } from './room.machine';
import { ABSENT_AFTER_MS, assertPositiveInt } from './room.types';
import {
  STATUS_TO_RESULT,
  presentUserIdsAt,
  type AbsentWindowOutcome,
  type AttendanceRole,
  type AttendanceStatsView,
  type AttendanceStatus,
  type AttendanceView,
  type ConfirmArrivalResult,
  type GraceAdjudicationOutcome,
  type NoShowCloseOutcome,
  type PresenceSample,
} from './attendance.types';

interface RoomRow {
  readonly id: string;
  readonly session_id: string;
  readonly scheduled_start: Date;
  readonly grace_end: Date;
  readonly status: string;
  readonly open_fail_reason: string | null;
}

interface AttendanceRow {
  readonly id: string;
  readonly room_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly first_join_at: Date | null;
  readonly last_seen_at: Date | null;
  readonly status: string;
  readonly adjudicated_at: Date | null;
}

const ATTENDANCE_COLS = `id, room_id, user_id, role, first_join_at, last_seen_at, status, adjudicated_at`;

/** 自然日毫秒（stats 窗口 [from 00:00, to+1d 00:00) 的右开上界推算） */
const DAY_MS = 86_400_000;

/** 律师端到场面：GET /rooms/{id}/attendance 的 403 NOT_PARTY 词汇（§5；error 词汇表复用
 * E_ROLE_FORBIDDEN——shared 未单列 NOT_PARTY 码，报告注记） */
export const NOT_PARTY_MESSAGE = '非本场参与方（PAID 报名/场次律师），无权查看到场判定';

/** 'YYYY-MM-DD' → 上海日界 0 点时刻（stats 窗口锚；格式非法 400） */
function shanghaiDayStart(date: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为 YYYY-MM-DD：${date}`);
  }
  const ms = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(ms)) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 非法日期：${date}`);
  }
  return new Date(ms);
}

/** 4 位小数四舍五入（比率展示口径；比率非金额，不受 Money 禁 float 约束——session.stats 同款） */
function rate4(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function toAttendanceView(row: AttendanceRow): AttendanceView {
  return {
    user_id: Number(row.user_id),
    role: row.role as AttendanceRole,
    status: row.status as AttendanceStatus,
    join_at: row.first_join_at === null ? null : new Date(row.first_join_at).toISOString(),
  };
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    // 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2 红线）：trade 快照/报名清单窄面
    private readonly sessions: SessionService,
    private readonly enrollments: EnrollmentService,
    @Inject(ATTENDANCE_CONFIG) private readonly config: AttendanceConfig,
  ) {}

  // ===========================================================================
  // presence 消费（§6：PresenceJoined/Left → attendances 幂等写入）
  // ===========================================================================

  /**
   * presence 事件落行（relay uow 内）：join=first_join_at（首次，COALESCE 语义）+last_seen_at
   * 推进；leave=仅 last_seen_at 推进（不清除行——判定看快照）。UNIQUE(room_id,user_id)
   * upsert=重复事件不双写（§8）。
   */
  async recordPresence(
    uow: SqlExecutor,
    roomId: number,
    userId: number,
    role: AttendanceRole,
    kind: 'joined' | 'left',
    at: Date,
  ): Promise<void> {
    const rid = assertPositiveInt(roomId, 'room_id');
    const uid = assertPositiveInt(userId, 'user_id');
    if (kind === 'joined') {
      // 首次 join 落 first_join_at（后续重连 join 不改首进锚——job2 边界用首进时刻）；
      // 冲突路径只推 last_seen_at（role 取首建行，不随事件漂移）
      await uow.query(
        `INSERT INTO fulfillment.attendances (room_id, user_id, role, first_join_at, last_seen_at, status)
         VALUES ($1, $2, $3, $4, $4, 'NORMAL')
         ON CONFLICT (room_id, user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
        [rid, uid, role, at],
      );
      return;
    }
    await uow.query(
      `INSERT INTO fulfillment.attendances (room_id, user_id, role, last_seen_at, status)
       VALUES ($1, $2, $3, $4, 'NORMAL')
       ON CONFLICT (room_id, user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [rid, uid, role, at],
    );
  }

  /** room 会话定位（presence 消费前置）：conversation_id → {type, ref_id}；null=会话不存在 */
  async roomConversationRef(
    exec: SqlExecutor,
    conversationId: number,
  ): Promise<{ type: string; ref_id: number } | null> {
    const res = await exec.query<{ type: string; ref_id: string }>(
      `SELECT type, ref_id FROM fulfillment.conversations WHERE id = $1`,
      [assertPositiveInt(conversationId, 'conversation_id')],
    );
    const row = res.rows[0];
    return row ? { type: row.type, ref_id: Number(row.ref_id) } : null;
  }

  /** 房间存在性（presence 防御位：不存在的房间忽略——join 门已保证存在，重放/漂移兜底） */
  async roomExists(exec: SqlExecutor, roomId: number): Promise<boolean> {
    const res = await exec.query(`SELECT 1 FROM fulfillment.rooms WHERE id = $1`, [
      assertPositiveInt(roomId, 'room_id'),
    ]);
    return res.rows.length > 0;
  }

  // ===========================================================================
  // job1：grace_end 判定（GracePeriodEnded 消费核心；§4 两级判定第一级）
  // ===========================================================================

  /**
   * 宽限结束时点判定：room FOR UPDATE→仍 OPEN 才判（终态/IN_SERVICE=幂等无操作：事件重投/
   * 判定后状态已推进）；在场性=presence 序列重放+容忍窗口（presentUserIdsAt 纯函数）。
   * maxEventId=判定事件 id（重放上界=只看判定事件之前已提交的 presence 序列，快照语义）。
   */
  async adjudicateOnGraceEnd(
    uow: SqlExecutor,
    roomId: number,
    maxEventId?: number,
  ): Promise<GraceAdjudicationOutcome> {
    const rid = assertPositiveInt(roomId, 'room_id');
    const found = await uow.query<RoomRow>(
      `SELECT id, session_id, scheduled_start, grace_end, status, open_fail_reason
         FROM fulfillment.rooms WHERE id = $1 FOR UPDATE`,
      [rid],
    );
    const room = found.rows[0];
    if (!room || room.status !== 'OPEN') {
      // 开房失败行（CANCELLED 直插，R-04）与已判/已终态房间：无判定（律师零 G1 事件）
      return { room_id: rid, judged: false, normal: 0, cancelled: false, in_service: false };
    }
    const sessionId = Number(room.session_id);
    const graceEnd = new Date(room.grace_end);
    const roster = await this.rosterOf(sessionId);
    const present = await this.presenceAt(uow, rid, graceEnd, maxEventId);

    const presentUserIds = roster.userIds.filter((uid) => present.has(uid));
    const lawyerPresent = present.has(roster.lawyerId);

    // 全员缺席（律师+全部 PAID 报名用户）→ 平台取消路径（§4：通知 D1 平台取消的 D3 侧承载）
    if (presentUserIds.length === 0 && !lawyerPresent) {
      await this.cancelRoomForNoShow(uow, room, roster);
      return { room_id: rid, judged: true, normal: 0, cancelled: true, in_service: false };
    }

    // 在场者 NORMAL（律师在场亦判 NORMAL；已判定行幂等跳过）
    let normal = 0;
    const presentMembers: Array<{ userId: number; role: AttendanceRole }> = [
      { userId: roster.lawyerId, role: 'lawyer' },
      ...roster.userIds.map((uid) => ({ userId: uid, role: 'user' as const })),
    ];
    for (const m of presentMembers) {
      if (!present.has(m.userId)) continue;
      if (await this.adjudicateRow(uow, rid, sessionId, m.userId, m.role, 'NORMAL')) {
        normal += 1;
      }
    }

    // 律师在场且 ≥1 用户在场 → IN_SERVICE（守卫+STL）+ROOM_IN_SERVICE 出箱
    if (lawyerPresent && presentUserIds.length >= 1) {
      await this.transitionRoom(uow, rid, 'OPEN', 'IN_SERVICE', 'attendance_in_service');
      await this.outbox.recordOutbox(uow, {
        type: ROOM_IN_SERVICE_TOPIC,
        payload: { room_id: rid, session_id: sessionId } satisfies RoomInServicePayload,
      });
      return { room_id: rid, judged: true, normal, cancelled: false, in_service: true };
    }
    // 律师不在场（有用户在场）→ 不判律师缺席（job2 边界判）；律师在场无用户 → 房间留 OPEN
    return { room_id: rid, judged: true, normal, cancelled: false, in_service: false };
  }

  // ===========================================================================
  // job2：grace_end+15min 判定（ABSENT_15M 执行器核心；R-01 边界）
  // ===========================================================================

  /**
   * 15min 窗口判定（修复环 I-1 裁定）：仍未判定成员——presence 序列重放到 deadline
   * （grace_end+15min）**判末位事件**：该成员 at<=deadline 的最后一条事件为 join（含恰好
   * deadline 进入，R-01 边界含端点）→ LATE（旁听）；为 leave 或无事件 → ABSENT（早进早走
   * 者不在场——旧「first_join_at<=deadline 即 LATE」口径会误判，已废；first_join_at 保留
   * 观测锚）。容忍窗关闭（tolerance=0）。逐人出箱（adjudicated_at 幂等——重放短路）；
   * 名册外行（理论不可达：presence 成员门拦报名外用户）不判——只判名册成员。
   * Minor-3 收敛面：grace 末瞬在飞 join（at 略越 grace_end、job1 快照不可见）在 deadline
   * 重放中可见——末位 join → LATE 兜底不误伤 ABSENT。
   */
  async adjudicateAbsentWindow(uow: SqlExecutor, roomId: number): Promise<AbsentWindowOutcome> {
    const rid = assertPositiveInt(roomId, 'room_id');
    const found = await uow.query<RoomRow>(
      `SELECT id, session_id, grace_end FROM fulfillment.rooms WHERE id = $1 FOR UPDATE`,
      [rid],
    );
    const room = found.rows[0];
    if (!room) return { room_id: rid, late: 0, absent: 0 };
    const sessionId = Number(room.session_id);
    const deadline = new Date(new Date(room.grace_end).getTime() + ABSENT_AFTER_MS);
    const roster = await this.rosterOf(sessionId);
    const rows = await uow.query<AttendanceRow>(
      `SELECT ${ATTENDANCE_COLS} FROM fulfillment.attendances WHERE room_id = $1`,
      [rid],
    );
    const byUser = new Map<number, AttendanceRow>();
    for (const r of rows.rows) byUser.set(Number(r.user_id), r);

    // 末位事件判据：deadline 锚重放+容忍窗关闭（presentUserIdsAt 主规则=「末位事件为 join」）
    const presentAtDeadline = await this.presenceAt(uow, rid, deadline, undefined, 0);

    let late = 0;
    let absent = 0;
    const members: Array<{ userId: number; role: AttendanceRole }> = [
      { userId: roster.lawyerId, role: 'lawyer' },
      ...roster.userIds.map((uid) => ({ userId: uid, role: 'user' as const })),
    ];
    for (const m of members) {
      const row = byUser.get(m.userId);
      if (row && row.adjudicated_at !== null) continue; // 已判定（job1 NORMAL/cancel ABSENT）幂等跳过
      if (presentAtDeadline.has(m.userId)) {
        if (await this.adjudicateRow(uow, rid, sessionId, m.userId, m.role, 'LATE')) late += 1;
      } else {
        if (await this.adjudicateRow(uow, rid, sessionId, m.userId, m.role, 'ABSENT')) absent += 1;
      }
    }
    return { room_id: rid, late, absent };
  }

  /**
   * ABSENT_15M recheck 半边（I2 R-02 幂等回查锚）：room 非 CANCELLED（⚠W2-10：判定与房间
   * 生命周期正交——CLOSED=律师经 close API 提前收场，缺席判定照常补判，PRD §8.5 分成依据
   * 不因关房丢失；CANCELLED=平台取消路径已由 job1 全员缺席分支承载、presence 面已无意义）
   * 且名册存在未判定成员（已判 NORMAL 行/无行的未进入者皆算——无行者由 execute 补建缺席行）
   * 才需执行；名册成员皆已判（全员在场全 NORMAL）→ false → job CANCELLED 无操作。
   */
  async hasUnadjudicated(uow: SqlExecutor, roomId: number): Promise<boolean> {
    const rid = assertPositiveInt(roomId, 'room_id');
    const room = await uow.query<{ session_id: string; status: string }>(
      `SELECT session_id, status FROM fulfillment.rooms WHERE id = $1`,
      [rid],
    );
    const row = room.rows[0];
    if (!row || row.status === 'CANCELLED') return false;
    const roster = await this.rosterOf(Number(row.session_id));
    const rows = await uow.query<{ user_id: string }>(
      `SELECT user_id FROM fulfillment.attendances WHERE room_id = $1 AND adjudicated_at IS NOT NULL`,
      [rid],
    );
    const adjudicated = new Set(rows.rows.map((r) => Number(r.user_id)));
    if (!adjudicated.has(roster.lawyerId)) return true;
    return roster.userIds.some((uid) => !adjudicated.has(uid));
  }

  // ===========================================================================
  // NO_SHOW_CLOSE 执行器核心（附录 A.2：关闭动作承载；job1 全员缺席已处理时幂等无操作）
  // ===========================================================================

  /**
   * 无人到场关闭：room 仍 OPEN（recheck 已滤）→ attendances 判定结果复核——已判 NORMAL|LATE
   * 或 presence 重放有人在场 → 无操作（房间生命周期归 close API/D4）；否则（=job1 事件丢失/
   * 死信的兜底场景：无人到场且零判定）→ 平台取消路径（全员 ABSENT+room CANCELLED+
   * SessionCancelled(platform)）。job1 已取消（room CANCELLED）→ recheck=false 不达此处。
   */
  async closeForNoShow(uow: SqlExecutor, roomId: number): Promise<NoShowCloseOutcome> {
    const rid = assertPositiveInt(roomId, 'room_id');
    const found = await uow.query<RoomRow>(
      `SELECT id, session_id, scheduled_start, grace_end, status, open_fail_reason
         FROM fulfillment.rooms WHERE id = $1 FOR UPDATE`,
      [rid],
    );
    const room = found.rows[0];
    if (!room || room.status !== 'OPEN') return { room_id: rid, closed: false };

    const sessionId = Number(room.session_id);
    const roster = await this.rosterOf(sessionId);
    const attended = await uow.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.attendances
        WHERE room_id = $1 AND adjudicated_at IS NOT NULL AND status IN ('NORMAL', 'LATE')`,
      [rid],
    );
    if ((attended.rows[0]?.n ?? 0) > 0) {
      return { room_id: rid, closed: false }; // 有人到场（判定已终态）——无操作
    }
    const present = await this.presenceAt(uow, rid, new Date(room.grace_end));
    if (present.has(roster.lawyerId) || roster.userIds.some((uid) => present.has(uid))) {
      return { room_id: rid, closed: false }; // 有人在场但判定未落（job1 滞后）——不抢判，无操作
    }
    await this.cancelRoomForNoShow(uow, room, roster);
    return { room_id: rid, closed: true };
  }

  // ===========================================================================
  // confirm-arrival（D2 §5 契约：POST /enrollments/{id}/confirm-arrival，幂等键=enrollment）
  // ===========================================================================

  /**
   * 人工确认到场：enrollment（trade 导出面）→user+session→room（本域）→写/改 attendances
   * （status=NORMAL+first_join_at=now()——人工确认=NORMAL，D2 文档注记口径）+恰一次
   * AttendanceAdjudicated(normal)。已判定行无操作返回现状（幂等键=enrollment：重复请求与
   * 判定后补确认同收敛）；未开房/终态房间/非 PAID/非 session 报名 → 409 显式失败不静默。
   */
  async confirmArrival(
    enrollmentId: number,
    opts?: { readonly actorUserId?: number },
  ): Promise<ConfirmArrivalResult> {
    const eid = assertPositiveInt(enrollmentId, 'enrollment_id');
    const enrollment = await this.enrollments.resolveEnrollment(eid);
    if (!enrollment) {
      throw new AppError(ErrorCode.NotFound, `报名不存在：${eid}`);
    }
    if (opts?.actorUserId !== undefined && opts.actorUserId !== enrollment.user_id) {
      throw new AppError(
        ErrorCode.RoleForbidden,
        `用户 ${opts.actorUserId} 非报名 ${eid} 属主（user=${enrollment.user_id}），不可代确认到场`,
      );
    }
    if (enrollment.ref_type !== 'session') {
      throw new AppError(
        ErrorCode.Conflict,
        `报名 ${eid} 非场次报名（ref_type=${enrollment.ref_type}），无到场确认语义（拼团转化链=W3）`,
      );
    }
    if (enrollment.pay_status !== 'PAID') {
      throw new AppError(
        ErrorCode.Conflict,
        `报名 ${eid} 未支付（pay_status=${enrollment.pay_status}），到场确认仅对 PAID 报名开放`,
      );
    }
    const sessionId = enrollment.ref_id;
    return this.pool.withTransaction(async (uow) => {
      const found = await uow.query<RoomRow>(
        `SELECT id, session_id, status FROM fulfillment.rooms WHERE session_id = $1 FOR UPDATE`,
        [sessionId],
      );
      const room = found.rows[0];
      if (!room) {
        throw new AppError(
          ErrorCode.Conflict,
          `场次 ${sessionId} 房间未开（ROOM_OPEN 未执行/失败），到场确认需进行中房间`,
        );
      }
      if (room.status !== 'OPEN' && room.status !== 'IN_SERVICE') {
        throw new AppError(
          ErrorCode.Conflict,
          `场次 ${sessionId} 房间已终态（${room.status}），到场确认关闭`,
        );
      }
      const rid = Number(room.id);
      const existing = await uow.query<AttendanceRow>(
        `SELECT ${ATTENDANCE_COLS} FROM fulfillment.attendances WHERE room_id = $1 AND user_id = $2`,
        [rid, enrollment.user_id],
      );
      const row = existing.rows[0];
      if (row && row.adjudicated_at !== null) {
        // 幂等键=enrollment 的第二半边：判定终态不翻案（>15min ABSENT 不因补确认改 NORMAL）
        return { status: row.status as AttendanceStatus };
      }
      // first_join_at：人工确认=到场记录锚（缺省 now()；已有 presence 首进锚不回退）
      await uow.query(
        `INSERT INTO fulfillment.attendances (room_id, user_id, role, first_join_at, last_seen_at, status)
         VALUES ($1, $2, 'user', now(), now(), 'NORMAL')
         ON CONFLICT (room_id, user_id) DO UPDATE SET
           first_join_at = COALESCE(fulfillment.attendances.first_join_at, now()),
           last_seen_at = now()`,
        [rid, enrollment.user_id],
      );
      await this.adjudicateRow(uow, rid, sessionId, enrollment.user_id, 'user', 'NORMAL');
      return { status: 'NORMAL' as const };
    });
  }

  // ===========================================================================
  // 查询面（§5：GET /rooms/{id}/attendance + GET /lawyer/attendance-stats）
  // ===========================================================================

  /**
   * 房间到场判定视图（§5 [{user_id, role, status, join_at}]）：403 NOT_PARTY=非参与方
   * （room→session 经 trade isSessionParticipant——PAID 报名/场次律师，conversation 成员门
   * 同口径）；404=房间不存在。
   */
  async listAttendance(roomId: number, asUserId: number): Promise<AttendanceView[]> {
    const rid = assertPositiveInt(roomId, 'room_id');
    const uid = assertPositiveInt(asUserId, 'asUserId');
    const room = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM fulfillment.rooms WHERE id = $1`,
      [rid],
    );
    const row = room.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `房间不存在：${rid}`);
    }
    const participant = await this.enrollments.isSessionParticipant(Number(row.session_id), uid);
    if (!participant) {
      throw new AppError(ErrorCode.RoleForbidden, NOT_PARTY_MESSAGE);
    }
    const rows = await this.pool.query<AttendanceRow>(
      `SELECT ${ATTENDANCE_COLS} FROM fulfillment.attendances WHERE room_id = $1 ORDER BY user_id`,
      [rid],
    );
    return rows.rows.map(toAttendanceView);
  }

  /**
   * 律师准时到场率（§5 {samples, punctual_rate}；口径=H4/02 §7.2「到场率←attendances.status」）：
   * 样本=窗口内该律师场次（slot_start∈[from,to) 上海日界，经 trade 导出面取场次清单——禁跨
   * schema join）的房间上 role='lawyer' 已判定行；punctual=其中 NORMAL 行。samples=0 →
   * punctual_rate=0（空窗不除零）。
   */
  async attendanceStats(lawyerId: number, from: string, to: string): Promise<AttendanceStatsView> {
    const lid = assertPositiveInt(lawyerId, 'lawyer_id');
    const fromInstant = shanghaiDayStart(from, 'from');
    const toExclusive = new Date(shanghaiDayStart(to, 'to').getTime() + DAY_MS);
    if (fromInstant.getTime() >= toExclusive.getTime()) {
      throw new AppError(ErrorCode.InvalidArgument, `from 须早于 to：${from} >= ${to}`);
    }
    const sessionIds = await this.sessions.sessionIdsOfLawyerBetween(lid, fromInstant, toExclusive);
    if (sessionIds.length === 0) return { samples: 0, punctual_rate: 0 };
    const rows = await this.pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n
         FROM fulfillment.attendances
        WHERE role = 'lawyer' AND adjudicated_at IS NOT NULL
          AND room_id IN (SELECT id FROM fulfillment.rooms WHERE session_id = ANY($1::bigint[]))
        GROUP BY status`,
      [sessionIds],
    );
    let samples = 0;
    let punctual = 0;
    for (const r of rows.rows) {
      samples += r.n;
      if (r.status === 'NORMAL') punctual += r.n;
    }
    return { samples, punctual_rate: samples === 0 ? 0 : rate4(punctual, samples) };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /** 判定名册：场次律师（trade getDetail）+ PAID 报名用户（trade listPaidEnrollmentUsers） */
  private async rosterOf(sessionId: number): Promise<{
    lawyerId: number;
    userIds: number[];
  }> {
    const detail = await this.sessions.getDetail(sessionId);
    const users = await this.enrollments.listPaidEnrollmentUsers(this.pool, sessionId);
    return { lawyerId: detail.lawyer_id, userIds: users.map((u) => u.user_id) };
  }

  /**
   * presence 序列重放（R-05 判定源）：D5 的 PresenceJoined/Left 事件留痕即序列事实源
   * （attendances 无序列列——V39 蓝图逐列不加）。取数经基座只读面 OutboxService.
   * listEventsByPayload（修复环 Minor-5：「业务经基座服务访问」白名单注释纪律——域模块
   * 不持 outbox 表知识）；按会话锚（conversation_id=room 会话）过滤规避 ref_id 数值撞车
   * （private/one_on_one 的 ref_id=订单 id）；id 升序=事件写入序（relay 同序投递）；
   * maxEventId=判定事件上界（job1 消费形态的快照语义；缺省=无上界——job2/NO_SHOW_CLOSE）。
   * anchor=判定锚时刻（job1/NO_SHOW_CLOSE=grace_end、job2=deadline）；toleranceMs=容忍窗
   * （缺省=config；job2 判据传 0=关闭容忍半边，纯末位事件）。
   */
  private async presenceAt(
    uow: SqlExecutor,
    roomId: number,
    anchor: Date,
    maxEventId?: number,
    toleranceMs: number = this.config.toleranceMs,
  ): Promise<Set<number>> {
    const conv = await uow.query<{ id: string }>(
      `SELECT id FROM fulfillment.conversations WHERE type = 'room' AND ref_id = $1`,
      [roomId],
    );
    const conversationId = conv.rows[0]?.id;
    if (conversationId === undefined) return new Set(); // 会话缺失=零 presence（理论不可达防御）
    const events = await this.outbox.listEventsByPayload(
      uow,
      [PRESENCE_JOINED_TOPIC, PRESENCE_LEFT_TOPIC],
      'conversation_id',
      conversationId,
      maxEventId,
    );
    const samples: PresenceSample[] = [];
    for (const e of events) {
      const payload = (e.payload ?? {}) as { user_id?: unknown; at?: unknown };
      const at = typeof payload.at === 'string' ? Date.parse(payload.at) : Number.NaN;
      if (!Number.isFinite(at)) continue; // 坏载荷（理论不可达：D5 生产侧已校验）——跳过不炸判定
      samples.push({
        userId: Number(payload.user_id),
        kind: e.topic === PRESENCE_JOINED_TOPIC ? 'joined' : 'left',
        at,
      });
    }
    return presentUserIdsAt(samples, anchor.getTime(), toleranceMs);
  }

  /**
   * 判定唯一写点（「禁裸 UPDATE 扩散」的收口）：占位行确保存在（未判定行 status='NORMAL'
   * 占位，V39 头注口径）→ adjudicated_at IS NULL 才落 status+adjudicated_at=now() 并出箱
   * AttendanceAdjudicated（已判定返回 false——job 重放/事件重投幂等短路，§8）。
   */
  private async adjudicateRow(
    uow: SqlExecutor,
    roomId: number,
    sessionId: number,
    userId: number,
    role: AttendanceRole,
    status: AttendanceStatus,
  ): Promise<boolean> {
    await uow.query(
      `INSERT INTO fulfillment.attendances (room_id, user_id, role, status)
       VALUES ($1, $2, $3, 'NORMAL')
       ON CONFLICT (room_id, user_id) DO NOTHING`,
      [roomId, userId, role],
    );
    const updated = await uow.query<{ id: string }>(
      `UPDATE fulfillment.attendances
          SET status = $3, adjudicated_at = now()
        WHERE room_id = $1 AND user_id = $2 AND adjudicated_at IS NULL
        RETURNING id`,
      [roomId, userId, status],
    );
    const row = updated.rows[0];
    if (!row) return false; // 已判定（幂等短路，不重发事件）
    await this.outbox.recordOutbox(uow, {
      type: ATTENDANCE_ADJUDICATED_TOPIC,
      payload: {
        adjudication_id: Number(row.id),
        session_id: sessionId,
        owner_type: role,
        owner_id: userId,
        result: STATUS_TO_RESULT[status],
      } satisfies AttendanceAdjudicatedPayload,
    });
    return true;
  }

  /**
   * 平台取消路径（job1 全员缺席 + NO_SHOW_CLOSE 兜底共用）：room OPEN→CANCELLED（守卫+STL，
   * reason='no_show'）+SessionCancelled(platform)（shared 既有契约；cancelled_at=DB 钟、
   * session_start_at=room.scheduled_start 快照）+全员（律师+PAID 用户）ABSENT 判定逐人出箱。
   */
  private async cancelRoomForNoShow(
    uow: SqlExecutor,
    room: RoomRow,
    roster: { lawyerId: number; userIds: number[] },
  ): Promise<void> {
    const roomId = Number(room.id);
    const sessionId = Number(room.session_id);
    const nowRow = await uow.query<{ now: Date }>(`SELECT now() AS now`);
    await this.transitionRoom(uow, roomId, 'OPEN', 'CANCELLED', 'no_show');
    await this.outbox.recordOutbox(uow, {
      type: SESSION_CANCELLED_TOPIC,
      payload: {
        session_id: sessionId,
        cancelled_by: 'platform',
        cancelled_by_user_id: null,
        cancelled_at: new Date(nowRow.rows[0]!.now).toISOString(),
        session_start_at: new Date(room.scheduled_start).toISOString(),
      } satisfies SessionCancelledPayload,
    });
    const members: Array<{ userId: number; role: AttendanceRole }> = [
      { userId: roster.lawyerId, role: 'lawyer' },
      ...roster.userIds.map((uid) => ({ userId: uid, role: 'user' as const })),
    ];
    for (const m of members) {
      await this.adjudicateRow(uow, roomId, sessionId, m.userId, m.role, 'ABSENT');
    }
    this.logger.log(
      `全员缺席平台取消：room=${roomId} session=${sessionId}（律师 ${roster.lawyerId} + 用户 ${roster.userIds.length} 人 ABSENT 判定）`,
    );
  }

  /** room 状态迁移唯一写点：守卫+STL（entity_type='room'，room.machine 词汇）+条件更新兜底 */
  private async transitionRoom(
    uow: SqlExecutor,
    roomId: number,
    from: 'OPEN',
    to: 'IN_SERVICE' | 'CANCELLED',
    reason: string,
  ): Promise<void> {
    await this.guard.assertTransition(ROOM_MACHINE, {
      entityId: roomId,
      from,
      to,
      reason,
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE fulfillment.rooms SET status = $2 WHERE id = $1 AND status = $3 RETURNING id`,
      [roomId, to, from],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new AppError(
        ErrorCode.StateStaleEntity,
        `房间 ${roomId} 已被并发迁移（${from}→${to}）`,
      );
    }
  }
}
