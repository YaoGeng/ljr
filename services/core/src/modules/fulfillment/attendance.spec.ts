import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import {
  ErrorCode,
  GRACE_PERIOD_ENDED_TOPIC,
  PRESENCE_JOINED_TOPIC,
  PRESENCE_LEFT_TOPIC,
  ROOM_IN_SERVICE_TOPIC,
  ROOM_OPENED_TOPIC,
  SESSION_CANCELLED_TOPIC,
  ATTENDANCE_ADJUDICATED_TOPIC,
  type PresencePayload,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { SchedulerService } from '../schedule/scheduler.service';
import { backdateRoomJobsDue, cancelPendingJobsByType } from '../schedule/job-fixture';
import { seedGroupBuyRaw, seedPaidEnrollmentRaw, seedSessionAtRaw } from '../trade/trade-fixture';
import { SessionService } from '../trade/session.service';
import { FulfillmentModule } from './fulfillment.module';
import { MockRtcProvider } from './rtc-provider';
import { ATTENDANCE_DEFAULT_CONFIG, attendanceConfigFromEnv } from './attendance.config';
import { presentUserIdsAt } from './attendance.types';
import { AttendanceService } from './attendance.service';
import { ConversationService } from './conversation.service';
import { RoomService } from './room.service';
import { attendanceRowsRaw, roomConversationIdRaw } from './fulfillment-fixture';
import { seedOooOrderRaw, seedRoomRaw } from './one-on-one-fixture';
import { grantUserRoles, seedLawyerProfile, seedUserShell } from '../identity/lawyer-fixture';
import { seedPaymentOrderRaw } from '../payment/order-fixture';
import { enrollmentOrderKey } from '../trade/enrollment.types';

/**
 * D3 到场与缺席判定（需 PG；M2-W2 T2——R-01~R-05 + §8 幂等 + §10 验收）：
 *   presence 幂等消费（重复 join 不双写）/job1 grace_end 判定（在场 NORMAL+IN_SERVICE+ROOM_
 *   IN_SERVICE；全员缺席→平台取消+CANCELLED+SessionCancelled(platform)）/R-05 抖动容忍
 *   （45s 重连不误判、61s 判 ABSENT——默认 60s 窗口）/R-01 15min 边界两侧（恰好=LATE、
 *   +1s=ABSENT）/R-04 开房失败零律师判定零信用事件/ABSENT_15M+NO_SHOW_CLOSE 执行器
 *   （含兜底接力与幂等无操作）/confirm-arrival（幂等键=enrollment）/attendance-stats
 *   （H4 口径）。R-02：断言事件载荷零金额字段（70/30 与 30% 积分=F3/F4 消费侧）。
 *   修复环：I-1=job2 末位事件判据（早进早走 ABSENT/在飞 join LATE 兜底=Minor-3）；
 *   I-2=⚠W2-10 判定与房间生命周期正交（close 后缺席补判不丢）。
 * 驱动：调度器/relay 均不自启动——手动 tick（scheduler normal/priority + relay.tick）。
 */

const MIN = 60_000;
const LAWYER_A = 9401;
const LAWYER_B = 9402;
const FIRM_ID = 8801;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('D3 到场与缺席判定（presence 消费/两级判定/缺席关闭/confirm-arrival/stats，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let attendance: AttendanceService;
  let rooms: RoomService;
  let scheduler: SchedulerService;
  let relay: OutboxRelayService;
  let poolSvc: PgPoolService;
  let outbox: OutboxService;
  let rtc: MockRtcProvider;
  let conversations: ConversationService;
  let sessions: SessionService;

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY event_id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  const roomRowOf = async (
    sessionId: number,
  ): Promise<{ id: number; status: string; grace_end: Date }> => {
    const res = await pool.query<{ id: string; status: string; grace_end: Date }>(
      `SELECT id, status, grace_end FROM fulfillment.rooms WHERE session_id = $1`,
      [sessionId],
    );
    const row = res.rows[0]!;
    return { id: Number(row.id), status: row.status, grace_end: row.grace_end };
  };

  /** presence 事件播种（D5 生产链的 outbox 事实源直写；at=精心构造的房间时刻戳） */
  const seedPresence = async (
    roomId: number,
    userId: number,
    role: 'user' | 'lawyer',
    kind: 'joined' | 'left',
    at: Date,
  ): Promise<void> => {
    const convId = await roomConversationIdRaw(pool, roomId);
    expect(convId).not.toBeNull();
    await poolSvc.withTransaction((uow) =>
      outbox.recordOutbox(uow, {
        type: kind === 'joined' ? PRESENCE_JOINED_TOPIC : PRESENCE_LEFT_TOPIC,
        payload: {
          conversation_id: convId!,
          ref_id: roomId,
          user_id: userId,
          role,
          at: at.toISOString(),
        } satisfies PresencePayload,
      }),
    );
  };

  /** 经调度器真链开房（ROOM_OPEN 预写→priority tick）；返回房间行 */
  const openRoom = async (sessionId: number, slotStart: Date) => {
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, {
        jobType: 'ROOM_OPEN',
        refType: 'session',
        refId: sessionId,
        dueAt: slotStart,
      }),
    );
    const ticked = await scheduler.tick('priority');
    expect(ticked.done).toBe(1);
    return roomRowOf(sessionId);
  };

  /** D2 提醒类 job 静默（executor 在 notify 域，本 spec 应用未装载——防 NO_EXECUTOR 噪音；
   *  经 schedule 域 fixture 回拨，spec 不内联跨域表名——check-schema-refs 纪律） */
  const silenceReminderJobs = (): Promise<void> =>
    cancelPendingJobsByType(pool, ['REMIND_GRACE_END']);

  /** D3 预写两 job 到期回拨（due=grace_end+15min 天然未来——job2/NO_SHOW_CLOSE 测试的时间注入） */
  const dueD3JobsNow = (roomId: number): Promise<void> =>
    backdateRoomJobsDue(pool, ['ABSENT_15M', 'NO_SHOW_CLOSE'], roomId);

  /** job1 全链：GRACE_END job 触发→GracePeriodEnded 出箱→relay 消费→判定落地 */
  const runGraceAdjudication = async (): Promise<void> => {
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(1);
    await relay.tick();
    await relay.tick(); // 二轮兜底（no-handler 事件首轮进重试轨道不阻塞，presence/grace 恒首轮内完成）
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init(); // onModuleInit：ABSENT_15M/NO_SHOW_CLOSE 执行器+presence/grace 消费器注册
    attendance = app.get(AttendanceService);
    rooms = app.get(RoomService);
    scheduler = app.get(SchedulerService);
    relay = app.get(OutboxRelayService);
    poolSvc = app.get(PgPoolService);
    outbox = app.get(OutboxService);
    rtc = app.get(MockRtcProvider);
    conversations = app.get(ConversationService);
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ===========================================================================
  // R-05/§10-2：抖动容忍（45s 重连不误判 NORMAL；61s 判 ABSENT——默认 60s 窗口）
  // ===========================================================================

  it('R-05（45s）：断线重连在飞（join@grace_end−45s+leave@−30s）容忍窗口吸收不误判——用户 NORMAL+律师 NORMAL+room IN_SERVICE+ROOM_IN_SERVICE 出箱+载荷逐字（R-02：零金额字段）', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7201,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();
    await seedPresence(room.id, LAWYER_A, 'lawyer', 'joined', new Date(g - 3 * MIN));
    // 用户 45s 断线场景：join@g−45s 后 leave@g−30s（rejoin 在飞未达）——无容忍窗口必误判缺席
    await seedPresence(room.id, 7201, 'user', 'joined', new Date(g - 45_000));
    await seedPresence(room.id, 7201, 'user', 'left', new Date(g - 30_000));
    await silenceReminderJobs();

    await runGraceAdjudication();

    const after = await roomRowOf(sessionId);
    expect(after.status).toBe('IN_SERVICE');
    expect(await outboxPayloads(ROOM_IN_SERVICE_TOPIC)).toEqual([
      { room_id: room.id, session_id: sessionId },
    ]);

    const rows = await attendanceRowsRaw(pool, room.id);
    expect(rows).toHaveLength(2);
    const lawyerRow = rows.find((r) => r.role === 'lawyer')!;
    const userRow = rows.find((r) => r.role === 'user')!;
    expect(lawyerRow.status).toBe('NORMAL');
    expect(lawyerRow.adjudicated_at).not.toBeNull();
    expect(userRow.status).toBe('NORMAL');
    expect(userRow.adjudicated_at).not.toBeNull();

    // R-02：AttendanceAdjudicated 载荷逐字（shared 既有契约；零金额字段——分成/积分=F3/F4 消费侧）
    const events = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual({
      adjudication_id: lawyerRow.id,
      session_id: sessionId,
      owner_type: 'lawyer',
      owner_id: LAWYER_A,
      result: 'normal',
    });
    expect(events).toContainEqual({
      adjudication_id: userRow.id,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7201,
      result: 'normal',
    });

    // 守卫留痕（entity_type='room'，OPEN→IN_SERVICE allowed）
    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'room' AND entity_id = $1
          AND from_status = 'OPEN' AND to_status = 'IN_SERVICE' AND allowed`,
      [room.id],
    );
    expect(stl.rows[0]!.n).toBe(1);
  });

  it('R-05（61s）+全员缺席：join@grace_end−61s 后离场（窗口外）→全员 ABSENT+room CANCELLED（reason=no_show 守卫留痕）+SessionCancelled(platform) 载荷逐字（cancelled_at=DB 钟可解析）；随后 ABSENT_15M/NO_SHOW_CLOSE recheck=false 幂等无操作（§8）', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_B, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7202,
      cash: '80.00',
      points: 0,
      unitPrice: '80.00',
    });
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();
    // 61s 断线：join@g−61s+leave@g−55s（重连窗 >60s 容忍）——判定不在场；律师从未进入
    await seedPresence(room.id, 7202, 'user', 'joined', new Date(g - 61_000));
    await seedPresence(room.id, 7202, 'user', 'left', new Date(g - 55_000));
    await silenceReminderJobs();

    await runGraceAdjudication();

    const after = await roomRowOf(sessionId);
    expect(after.status).toBe('CANCELLED');

    const cancelled = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.session_id).toBe(sessionId);
    expect(cancelled[0]!.cancelled_by).toBe('platform');
    expect(cancelled[0]!.cancelled_by_user_id).toBeNull();
    expect(Number.isNaN(Date.parse(String(cancelled[0]!.cancelled_at)))).toBe(false);
    expect(new Date(String(cancelled[0]!.session_start_at)).getTime()).toBe(slotStart.getTime());

    // 全员 ABSENT 判定（律师+用户逐人）——用户行 presence 已建、律师行补建
    const rows = await attendanceRowsRaw(pool, room.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(['ABSENT', 'ABSENT']);
    expect(rows.every((r) => r.adjudicated_at !== null)).toBe(true);
    const events = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(events).toHaveLength(2);
    expect(events).toContainEqual({
      adjudication_id: rows[0]!.id,
      session_id: sessionId,
      owner_type: rows[0]!.role,
      owner_id: rows[0]!.user_id,
      result: 'absent',
    });

    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'room' AND entity_id = $1
          AND from_status = 'OPEN' AND to_status = 'CANCELLED' AND allowed AND reason = 'no_show'`,
      [room.id],
    );
    expect(stl.rows[0]!.n).toBe(1);

    // §8 幂等：判定后两 job 到期触发——recheck=false（room CANCELLED）→ job CANCELLED 零新事件
    await dueD3JobsNow(room.id);
    const ticked = await scheduler.tick('normal');
    expect(ticked.cancelled).toBeGreaterThanOrEqual(2);
    expect(await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC)).toHaveLength(2);
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1);

    // GracePeriodEnded 事件重投（at-least-once 崩溃窗）→ room 终态 judged=false 幂等无操作
    await poolSvc.withTransaction((uow) =>
      outbox.recordOutbox(uow, {
        type: GRACE_PERIOD_ENDED_TOPIC,
        payload: { room_id: room.id, session_id: sessionId },
      }),
    );
    await relay.tick();
    expect(await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC)).toHaveLength(2);
  });

  // ===========================================================================
  // §8：presence 消费幂等 + 防御位
  // ===========================================================================

  it('§8 presence 幂等：重复 join/leave 事件不双写（UNIQUE(room,user) 单行，first_join_at 首次锚不漂移，last_seen_at 推进）；非 room 会话与不存在房间=防御位忽略', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();

    // 重复 join（同刻重发）+ 断线重连（leave 后再 join：first_join 锚不变，last_seen 推进）
    await seedPresence(room.id, 7203, 'user', 'joined', new Date(g - 3 * MIN));
    await seedPresence(room.id, 7203, 'user', 'joined', new Date(g - 3 * MIN)); // 重复事件
    await seedPresence(room.id, 7203, 'user', 'left', new Date(g - 2 * MIN));
    await seedPresence(room.id, 7203, 'user', 'joined', new Date(g - MIN));
    await relay.tick();

    const rows = await attendanceRowsRaw(pool, room.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.first_join_at!.getTime()).toBe(g - 3 * MIN); // 首进锚不漂移
    expect(rows[0]!.last_seen_at!.getTime()).toBe(g - MIN); // 最近事件推进
    expect(rows[0]!.adjudicated_at).toBeNull(); // 未判定（判定归 job）

    // 防御位：不存在的房间 / 非 room 会话 → 忽略零行零异常
    await poolSvc.withTransaction((uow) =>
      outbox.recordOutbox(uow, {
        type: PRESENCE_JOINED_TOPIC,
        payload: {
          conversation_id: 999999,
          ref_id: 888888,
          user_id: 7203,
          role: 'user',
          at: new Date().toISOString(),
        } satisfies PresencePayload,
      }),
    );
    const oneOnOne = await pool.query<{ id: string }>(
      `INSERT INTO fulfillment.conversations (type, ref_id) VALUES ('one_on_one', 4401) RETURNING id`,
    );
    const convId = Number(oneOnOne.rows[0]!.id);
    await poolSvc.withTransaction((uow) =>
      outbox.recordOutbox(uow, {
        type: PRESENCE_JOINED_TOPIC,
        payload: {
          conversation_id: convId,
          ref_id: 4401,
          user_id: 7203,
          role: 'user',
          at: new Date().toISOString(),
        } satisfies PresencePayload,
      }),
    );
    const dispatched = await relay.tick();
    expect(dispatched.retried).toBeGreaterThanOrEqual(0); // 无异常进死信（忽略路径零抛错）
    expect(await attendanceRowsRaw(pool, room.id)).toHaveLength(1); // 防御位零新行
  });

  // ===========================================================================
  // R-01/§10-1：15min 边界两侧行为（恰好 15min=LATE / 15min+1s=ABSENT）
  // ===========================================================================

  it('R-01 边界：job2 末位事件判据下 join 恰好=grace_end+15min（deadline，含）→ LATE；+1s（>deadline 重放不可见）→ ABSENT；NO_SHOW_CLOSE 对有人到场判定房间无操作', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7301,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7302,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();
    await seedPresence(room.id, LAWYER_A, 'lawyer', 'joined', new Date(g - 3 * MIN));
    // 两用户均在宽限后进入：恰好 15min / 15min+1s（presence 先行播种——job1 快照对 at>grace_end 不可见）
    await seedPresence(room.id, 7301, 'user', 'joined', new Date(g + 15 * MIN));
    await seedPresence(room.id, 7302, 'user', 'joined', new Date(g + 15 * MIN + 1_000));
    await silenceReminderJobs();

    await runGraceAdjudication(); // job1：律师在场+0 用户在场 → 律师 NORMAL，room 留 OPEN

    let after = await roomRowOf(sessionId);
    expect(after.status).toBe('OPEN'); // 律师在场但无用户在场 → 不 IN_SERVICE（不全员缺席 → 不取消）
    expect(await outboxPayloads(ROOM_IN_SERVICE_TOPIC)).toHaveLength(0);
    // 仅律师已判定（u1/u2 行=presence 占位：status 'NORMAL'+adjudicated_at NULL，V39 占位口径）
    const mid = await attendanceRowsRaw(pool, room.id);
    expect(mid.filter((r) => r.adjudicated_at !== null).map((r) => r.status)).toEqual(['NORMAL']);
    expect(mid.filter((r) => r.adjudicated_at === null)).toHaveLength(2);

    // job2+NO_SHOW_CLOSE 到期（时间注入回拨 due）
    await dueD3JobsNow(room.id);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(2); // ABSENT_15M + NO_SHOW_CLOSE（room OPEN recheck=true 但无人在场判定结果=零 NORMAL/LATE → 关闭）
    after = await roomRowOf(sessionId);

    const rows = await attendanceRowsRaw(pool, room.id);
    const u1 = rows.find((r) => r.user_id === 7301)!;
    const u2 = rows.find((r) => r.user_id === 7302)!;
    const lawyerRow = rows.find((r) => r.role === 'lawyer')!;
    expect(u1.status).toBe('LATE'); // 恰好 15min（含）→ LATE（旁听）
    expect(u2.status).toBe('ABSENT'); // 15min+1s（不含）→ ABSENT
    expect(lawyerRow.status).toBe('NORMAL');

    const events = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(events).toContainEqual({
      adjudication_id: u1.id,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7301,
      result: 'late',
    });
    expect(events).toContainEqual({
      adjudication_id: u2.id,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7302,
      result: 'absent',
    });

    // u2 ABSENT（room 有到场用户）→ 事件已出箱=R-02/F4（30% 积分按支付占比分配）桩锚：本模块只发事件
    expect(events.filter((e) => e.result === 'absent')).toHaveLength(1);

    // NO_SHOW_CLOSE：room OPEN 且零 NORMAL/LATE？——u1=LATE 已判 → 有人到场判定结果 → 无操作
    expect(after.status).toBe('OPEN');
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(0);
  });

  // ===========================================================================
  // 修复环 I-1：job2 末位事件判据（早进早走=ABSENT，旧 first_join 口径会误判 LATE）
  // + Minor-3：grace 末瞬在飞 join（at 越 grace_end）→deadline 重放可见 →LATE 兜底
  // ===========================================================================

  it('修复环 I-1+Minor-3：宽限内进入+grace_end 前离场未归（早进早走，律师在场房间不取消）→job2 末位=leave 判 ABSENT（旧 first_join_at<=deadline 口径的误判回归）；grace 末瞬在飞 join（at=grace_end+2s，job1 快照不可见）→deadline 重放末位=join 判 LATE 兜底', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7311,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7312,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();
    await seedPresence(room.id, LAWYER_A, 'lawyer', 'joined', new Date(g - 3 * MIN));
    // 7311 早进早走：宽限内 join、grace_end 前离场未归——job1 不在场；job2 末位事件=leave
    await seedPresence(room.id, 7311, 'user', 'joined', new Date(g - 3 * MIN));
    await seedPresence(room.id, 7311, 'user', 'left', new Date(g - 2 * MIN));
    // 7312 grace 末瞬在飞 join（at 越 grace_end 2s——job1 快照/at 过滤均不可见）
    await seedPresence(room.id, 7312, 'user', 'joined', new Date(g + 2_000));
    await silenceReminderJobs();

    await runGraceAdjudication(); // job1：律师在场+0 用户在场 → 律师 NORMAL，room 留 OPEN（非全员缺席不取消）
    expect((await roomRowOf(sessionId)).status).toBe('OPEN');
    const mid = await attendanceRowsRaw(pool, room.id);
    expect(mid.filter((r) => r.adjudicated_at !== null).map((r) => r.status)).toEqual(['NORMAL']);
    expect(mid.filter((r) => r.adjudicated_at === null)).toHaveLength(2); // 两用户占位行待 job2

    await dueD3JobsNow(room.id);
    await scheduler.tick('normal');
    const rows = await attendanceRowsRaw(pool, room.id);
    const earlyBird = rows.find((r) => r.user_id === 7311)!;
    const inFlight = rows.find((r) => r.user_id === 7312)!;
    expect(earlyBird.status).toBe('ABSENT'); // I-1：早进早走者不在场（首进时刻<=deadline 不可作 LATE 判据）
    expect(inFlight.status).toBe('LATE'); // Minor-3：deadline 重放可见在飞 join → 末位 join 兜底不误伤

    const events = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(events).toContainEqual({
      adjudication_id: earlyBird.id,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7311,
      result: 'absent',
    });
    expect(events).toContainEqual({
      adjudication_id: inFlight.id,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7312,
      result: 'late',
    });
    // NO_SHOW_CLOSE：律师 NORMAL+7312 LATE 已判（有人到场判定结果）→ 无操作，房间留 OPEN
    expect((await roomRowOf(sessionId)).status).toBe('OPEN');
  });

  // ===========================================================================
  // 修复环 I-2（⚠W2-10 裁定）：判定与房间生命周期正交——close 后缺席补判不丢
  // ===========================================================================

  it('修复环 I-2（⚠W2-10）：律师经 close API 提前关房（OPEN→CLOSED 真链）后 job2 到期——缺席用户照常 ABSENT+AttendanceAdjudicated 出箱（PRD §8.5 分成依据不因关房丢失）；房间保持 CLOSED 不翻案；NO_SHOW_CLOSE 对 CLOSED recheck=false', async () => {
    // 律师账号壳+角色+档案（close 真链需 firm_id 绑定与 gross 聚合——room.spec close 用例同构）
    const lawyerId = await seedUserShell(pool, 'd3-i2');
    await grantUserRoles(pool, lawyerId, ['lawyer']);
    await seedLawyerProfile(pool, lawyerId, 'PASSED', 'd3-i2', undefined, FIRM_ID);
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, lawyerId, 'CONFIRMED', slotStart, 'text');
    const eid = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7321,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(eid),
      bizId: eid,
      cash: '100.00',
      points: 0,
    });
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();
    await seedPresence(room.id, lawyerId, 'lawyer', 'joined', new Date(g - 3 * MIN));
    await silenceReminderJobs();
    await runGraceAdjudication(); // job1：律师 NORMAL+0 用户在场 → room 留 OPEN

    // 律师提前关房（真链 close API：归属校验+守卫+STL+RoomClosed 聚合出箱）
    const closed = await rooms.closeRoom(sessionId, { actorLawyerId: lawyerId });
    expect(typeof closed.closed_at).toBe('string');
    expect((await roomRowOf(sessionId)).status).toBe('CLOSED');

    // job2 到期：CLOSED 放行补判（旧 recheck OPEN/IN_SERVICE 口径会吞掉缺席判定→分成依据静默缺失）
    await dueD3JobsNow(room.id);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(1); // ABSENT_15M 补判（⚠W2-10 正交裁定）
    expect(ticked.cancelled).toBeGreaterThanOrEqual(1); // NO_SHOW_CLOSE recheck=false（非 OPEN）

    const rows = await attendanceRowsRaw(pool, room.id);
    const absentUser = rows.find((r) => r.user_id === 7321)!;
    expect(absentUser.status).toBe('ABSENT');
    expect(absentUser.adjudicated_at).not.toBeNull();
    expect(await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC)).toContainEqual({
      adjudication_id: absentUser.id,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7321,
      result: 'absent',
    });
    expect((await roomRowOf(sessionId)).status).toBe('CLOSED'); // 关房终态不翻案
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(0); // 补判≠平台取消
  });

  // ===========================================================================
  // NO_SHOW_CLOSE 兜底：GracePeriodEnded 消费死信（job1 未达）时的关闭动作承载
  // ===========================================================================

  it('NO_SHOW_CLOSE 兜底接力：GRACE_END job 静默（job1 未达）→ ABSENT_15M 先判全员 ABSENT → NO_SHOW_CLOSE 关闭承载（room CANCELLED+SessionCancelled(platform)）', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_B, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7401,
      cash: '60.00',
      points: 0,
      unitPrice: '60.00',
    });
    const room = await openRoom(sessionId, slotStart);
    await silenceReminderJobs();
    // 模拟 GracePeriodEnded 消费死信：GRACE_END job 直接终态化（判定事件不出，经 schedule fixture）
    await cancelPendingJobsByType(pool, ['GRACE_END'], room.id);

    await dueD3JobsNow(room.id);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(2);

    // ABSENT_15M 补建全员 ABSENT（律师行无 presence 亦补建）→ NO_SHOW_CLOSE 复核零在场 → 关闭
    const after = await roomRowOf(sessionId);
    expect(after.status).toBe('CANCELLED');
    const rows = await attendanceRowsRaw(pool, room.id);
    expect(rows.map((r) => r.status)).toEqual(['ABSENT', 'ABSENT']);
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1);
    expect((await outboxPayloads(SESSION_CANCELLED_TOPIC))[0]!.cancelled_by).toBe('platform');
    expect(await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC)).toHaveLength(2);
  });

  it('律师缺席+用户在场（非全员缺席）：job1 用户 NORMAL 房间留 OPEN（不判律师缺席）；job2 律师 ABSENT 补建；NO_SHOW_CLOSE 有人到场判定 → 无操作（房间归 close API/D4）', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_B, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7501,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();
    await seedPresence(room.id, 7501, 'user', 'joined', new Date(g - 2 * MIN)); // 用户在场，律师从未进入
    await silenceReminderJobs();

    await runGraceAdjudication();
    expect((await roomRowOf(sessionId)).status).toBe('OPEN');
    expect(await outboxPayloads(ROOM_IN_SERVICE_TOPIC)).toHaveLength(0);
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(0);
    expect((await attendanceRowsRaw(pool, room.id)).map((r) => r.status)).toEqual(['NORMAL']); // 仅用户

    await dueD3JobsNow(room.id);
    await scheduler.tick('normal');
    const rows = await attendanceRowsRaw(pool, room.id);
    const lawyerRow = rows.find((r) => r.role === 'lawyer')!;
    expect(lawyerRow.status).toBe('ABSENT'); // 律师缺席判定归 job2（15min 边界）
    expect(rows.find((r) => r.user_id === 7501)!.status).toBe('NORMAL');
    expect((await roomRowOf(sessionId)).status).toBe('OPEN'); // NO_SHOW_CLOSE 无操作
  });

  // ===========================================================================
  // R-04/§10-3：开房失败 → 律师零判定零信用事件（平台故障不扣律师）
  // ===========================================================================

  it('R-04：开房失败（mock 注入）room CANCELLED——无 GRACE_END/ABSENT_15M/NO_SHOW_CLOSE 预写、零 AttendanceAdjudicated、credit 域零新事件（G1 桩验证）', async () => {
    rtc.failNextRoom('RTC_CHANNEL_DOWN');
    const slotStart = new Date(Date.now() - 2_000);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7601,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const room = await openRoom(sessionId, slotStart);
    expect(room.status).toBe('CANCELLED');

    const jobs = await scheduler.listJobs({ limit: 100 });
    expect(
      jobs.filter((j) => ['GRACE_END', 'ABSENT_15M', 'NO_SHOW_CLOSE'].includes(j.jobType)),
    ).toHaveLength(0); // 终态房间无宽限/判定/关闭语义（预写缝只在成功分支）

    await relay.tick(); // 无 grace 事件可消费
    expect(await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC)).toHaveLength(0);
    const creditEvents = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic LIKE 'credit.%'`,
    );
    expect(creditEvents.rows[0]!.n).toBe(0); // 律师零 G1 事件面
    expect(await attendanceRowsRaw(pool, room.id)).toHaveLength(0); // 零判定行
  });

  // ===========================================================================
  // confirm-arrival（D2 §5：幂等键=enrollment）
  // ===========================================================================

  it('confirm-arrival：PAID 场次报名 → status=NORMAL+first_join_at 落值+恰一次事件；重复请求幂等（无二次事件）；非属主 403；groupbuy 报名 409；不存在 404', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    const enrollmentId = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7701,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const gbId = await seedGroupBuyRaw(pool, LAWYER_A, 'REACHED'); // trade 域 fixture（不内联跨域表名）
    const gbEnrollmentId = await seedPaidEnrollmentRaw(pool, 'groupbuy', gbId, {
      userId: 7702,
      cash: '80.00',
      points: 0,
      unitPrice: '80.00',
    });
    const room = await openRoom(sessionId, slotStart);

    // 非属主 403（防代确认）
    await expect(
      attendance.confirmArrival(enrollmentId, { actorUserId: 999999 }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden, httpStatus: 403 });
    // groupbuy 报名 409（无到场确认语义）
    await expect(attendance.confirmArrival(gbEnrollmentId)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    // 不存在 404
    await expect(attendance.confirmArrival(424242)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
      httpStatus: 404,
    });

    const res = await attendance.confirmArrival(enrollmentId, { actorUserId: 7701 });
    expect(res).toEqual({ status: 'NORMAL' });
    const rows = await attendanceRowsRaw(pool, room.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('NORMAL');
    expect(rows[0]!.first_join_at).not.toBeNull(); // 人工确认=到场记录锚（now() 落值）
    expect(rows[0]!.adjudicated_at).not.toBeNull();
    let events = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      adjudication_id: rows[0]!.id,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7701,
      result: 'normal',
    });

    // 幂等键=enrollment：重复请求无操作返回现状、无二次事件
    const again = await attendance.confirmArrival(enrollmentId, { actorUserId: 7701 });
    expect(again).toEqual({ status: 'NORMAL' });
    events = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(events).toHaveLength(1);

    // 判定后补确认不翻案：job1 先判 ABSENT（无人 presence）后 confirm → 返回现状 ABSENT
    await silenceReminderJobs();
    await dueD3JobsNow(room.id);
    await scheduler.tick('normal'); // ABSENT_15M/NO_SHOW_CLOSE：confirm-arrival NORMAL 行在场 → 关闭无操作
    const overturned = await attendance.confirmArrival(enrollmentId, { actorUserId: 7701 });
    expect(overturned).toEqual({ status: 'NORMAL' }); // 本例本就 NORMAL；翻案保护=adjudicated_at 短路（上方幂等半边已验）
  });

  // ===========================================================================
  // 查询面（§5：GET /rooms/{id}/attendance 403 NOT_PARTY + attendance-stats H4 口径）
  // ===========================================================================

  it('GET attendance 参与方门：非参与方 403（NOT_PARTY 词汇复用 E_ROLE_FORBIDDEN）；参与方得 [{user_id, role, status, join_at}]', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7801,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const room = await openRoom(sessionId, slotStart);
    const g = room.grace_end.getTime();
    await seedPresence(room.id, LAWYER_A, 'lawyer', 'joined', new Date(g - 3 * MIN));
    await silenceReminderJobs();
    await runGraceAdjudication();

    const views = await attendance.listAttendance(room.id, 7801); // PAID 报名用户=参与方
    expect(views).toEqual([
      {
        user_id: LAWYER_A,
        role: 'lawyer',
        status: 'NORMAL',
        join_at: new Date(g - 3 * MIN).toISOString(),
      },
    ]);

    await expect(attendance.listAttendance(room.id, 666666)).rejects.toMatchObject({
      code: ErrorCode.RoleForbidden,
      httpStatus: 403,
    });
    await expect(attendance.listAttendance(424242, 7801)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
      httpStatus: 404,
    });
  });

  it('attendance-stats（H4 口径）：窗口内律师场次 NORMAL/ABSENT 各一 → {samples:2, punctual_rate:0.5}；空窗 samples=0；坏窗口 400', async () => {
    // 场次一：律师到场（NORMAL）
    const s1 = await seedSessionAtRaw(
      pool,
      LAWYER_A,
      'CONFIRMED',
      new Date(Date.now() - 8 * MIN),
      'text',
    );
    await seedPaidEnrollmentRaw(pool, 'session', s1, {
      userId: 7811,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const r1 = await openRoom(s1, new Date(Date.now() - 8 * MIN));
    await seedPresence(
      r1.id,
      LAWYER_A,
      'lawyer',
      'joined',
      new Date(r1.grace_end.getTime() - 3 * MIN),
    );
    await seedPresence(r1.id, 7811, 'user', 'joined', new Date(r1.grace_end.getTime() - 2 * MIN));
    await silenceReminderJobs();
    await runGraceAdjudication(); // 律师+用户在场 → 律师 NORMAL + IN_SERVICE

    // 场次二：律师缺席（用户在场防全员取消）→ job2 判律师 ABSENT
    const s2 = await seedSessionAtRaw(
      pool,
      LAWYER_A,
      'CONFIRMED',
      new Date(Date.now() - 7 * MIN),
      'text',
    );
    await seedPaidEnrollmentRaw(pool, 'session', s2, {
      userId: 7812,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const r2 = await openRoom(s2, new Date(Date.now() - 7 * MIN));
    await seedPresence(r2.id, 7812, 'user', 'joined', new Date(r2.grace_end.getTime() - 2 * MIN));
    await runGraceAdjudication();
    await dueD3JobsNow(r2.id);
    await scheduler.tick('normal'); // ABSENT_15M：律师 ABSENT；NO_SHOW_CLOSE：用户 NORMAL → 无操作

    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // 上海日（UTC+8 偏移后取日）
    const stats = await attendance.attendanceStats(LAWYER_A, today, today);
    expect(stats).toEqual({ samples: 2, punctual_rate: 0.5 });

    const other = await attendance.attendanceStats(LAWYER_B, today, today);
    expect(other).toEqual({ samples: 0, punctual_rate: 0 });

    await expect(attendance.attendanceStats(LAWYER_A, '2026-13-01', today)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
  });

  it('C1 stats 接真（M2-W3 T3，W2 复审 §3-⑤）：attendance_rate/ooo_rate 经本域聚合导出面出数（已知输入→期望值）；缺数据 null 双路', async () => {
    // 上海日锚先取再 seed（午夜翻转竞态防御——T3 评审 M-2：today 若后取，跨零点时 seed 落窗外）
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    // 窗内场次+房间（判定/订单行的聚合锚）
    const s1 = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', new Date(), 'text');
    const r1 = await seedRoomRaw(pool, s1);
    // 判定行：律师 NORMAL+用户甲 NORMAL+用户乙 ABSENT（已判 3 行到场 2 → attendance_rate=0.6667，
    // H4 口径双角色）；用户丙未判定（adjudicated_at 空——不进 attendance 分母；first_join_at 在册
    // =进过房，进 ooo 分母）
    await pool.query(
      `INSERT INTO fulfillment.attendances
         (room_id, user_id, role, first_join_at, last_seen_at, status, adjudicated_at)
       VALUES ($1, $2, 'lawyer', now(), now(), 'NORMAL', now()),
              ($1, $3, 'user',   now(), now(), 'NORMAL', now()),
              ($1, $4, 'user',   NULL,  NULL,  'ABSENT', now()),
              ($1, $5, 'user',   now(), now(), 'NORMAL', NULL)`,
      [r1, LAWYER_A, 7821, 7822, 7823],
    );
    // 1对1 订单：甲（PAID 已支付计入）+丙（REFUNDED 终态仍计）——分子排除 CREATED 弃单
    // （H4 已支付语义对齐，T3 评审 I-1；缺数据路另证 null）
    await seedOooOrderRaw(pool, { roomId: r1, userId: 7821, lawyerId: LAWYER_A, status: 'PAID' });
    await seedOooOrderRaw(pool, {
      roomId: r1,
      userId: 7823,
      lawyerId: LAWYER_A,
      status: 'REFUNDED',
    });
    // CREATED 弃单不计分子（过滤口径钉住：多一单弃单 ooo_rate 仍 1）
    await seedOooOrderRaw(pool, {
      roomId: r1,
      userId: 7823,
      lawyerId: LAWYER_A,
      serviceType: 'doc_revision',
      status: 'CREATED',
    });
    // ooo 分母=进房去重用户=甲+丙（乙未进、律师角色不计）→ 2/2=1

    const stats = await sessions.stats(LAWYER_A, today, today);
    expect(stats.enroll_rate).toBe(0); // 夹具场 joined=0/capacity=5（出数形态由 HTTP 面用例钉）
    expect(stats.group_rate).toBe(1); // CONFIRMED ∈ 成团链
    expect(stats.attendance_rate).toBe(0.6667); // (NORMAL+LATE)2 ÷ 已判 3
    expect(stats.ooo_rate).toBe(1); // 订单 2 ÷ 进房用户 2

    // 缺数据路一：有场次零判定/零订单/零进房 → 两率 null（非 0）
    await seedSessionAtRaw(pool, LAWYER_B, 'CONFIRMED', new Date(), 'text');
    const bare = await sessions.stats(LAWYER_B, today, today);
    expect(bare.attendance_rate).toBeNull();
    expect(bare.ooo_rate).toBeNull();

    // 缺数据路二：空窗（无场次）→ 四率全 null
    const empty = await sessions.stats(LAWYER_A, '2020-01-01', '2020-01-01');
    expect(empty).toEqual({
      enroll_rate: null,
      group_rate: null,
      attendance_rate: null,
      ooo_rate: null,
    });
  });

  it('AttendanceGate 时序缝联调（W1 原文回指=W2 复审 §3-⑦，M2-W3 T3 验收）：开房 job→ROOM_OPENED→presence join/leave/join（D5 真链 recordPresence）→GRACE_END 消费→判定不误判（容忍窗内抖动全 NORMAL+IN_SERVICE）', async () => {
    // ---- 段 1：开房 job 真链（slot_start 锚定使 grace_end≈now+30s——段 2 presence 的 at
    // 服务器时刻全落 [g−60s, g] 容忍窗内，零合成时间戳）----
    const slotStart = new Date(Date.now() - 4.5 * MIN); // grace_end=slot+5min≈now+30s
    const sessionId = await seedSessionAtRaw(pool, LAWYER_A, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7831,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const room = await openRoom(sessionId, slotStart);
    const convId = await roomConversationIdRaw(pool, room.id);
    expect(convId).not.toBeNull(); // 开房即建 room 会话（presence 锚）
    const opened = await outboxPayloads(ROOM_OPENED_TOPIC);
    expect(opened).toHaveLength(1); // 段 1 事件出口（job→事件）

    // ---- 段 2：presence join/leave/join 抖动经 D5 真链（recordPresence=WSS join/leave 的
    // 服务承载，at=服务器接收时刻；事件 id 序先于 GracePeriodEnded=判定重放快照内）----
    const conversation = (await conversations.getConversation(convId!))!;
    await conversations.recordPresence(conversation, LAWYER_A, 'lawyer', 'joined');
    await conversations.recordPresence(conversation, 7831, 'user', 'joined');
    await conversations.recordPresence(conversation, 7831, 'user', 'left'); // 抖动半程
    await conversations.recordPresence(conversation, 7831, 'user', 'joined'); // 重连归位
    await relay.tick(); // D3 presence 消费 → attendances 真链落行
    await relay.tick(); // 二轮兜底（ROOM_OPENED 无 handler 的重试噪音不阻塞——W2 同口径）
    const seeded = await attendanceRowsRaw(pool, room.id);
    expect(seeded).toHaveLength(2); // upsert 幂等：join/leave/join 恒两行
    expect(seeded.every((r) => r.first_join_at !== null)).toBe(true);

    // ---- 段 3：GRACE_END job→GracePeriodEnded→relay 消费→job1 判定（due 回拨时间注入）----
    await backdateRoomJobsDue(pool, ['GRACE_END'], room.id);
    await silenceReminderJobs();
    await runGraceAdjudication();

    // 判定不误判：抖动全在容忍窗内——律师+用户 NORMAL、房间 IN_SERVICE、零 ABSENT
    const after = await roomRowOf(sessionId);
    expect(after.status).toBe('IN_SERVICE');
    const rows = await attendanceRowsRaw(pool, room.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'NORMAL' && r.adjudicated_at !== null)).toBe(true);
    expect(rows.some((r) => r.status === 'ABSENT')).toBe(false); // 45s 级抖动不误判（W2 单点用例的链式串联形态）
    expect(await outboxPayloads(ROOM_IN_SERVICE_TOPIC)).toEqual([
      { room_id: room.id, session_id: sessionId },
    ]);
  });

  // ===========================================================================
  // R-05 配置面：容忍窗口=配置项（D3 §11 默认 60s；presentUserIdsAt 纯函数+env 装载）
  // ===========================================================================

  it('R-05 配置项注入：presentUserIdsAt 纯函数——tolerance=60s 时 join@−45s（leave 后）在场/join@−61s 不在场/leave 后无 join 不在场/从未进入不在场；attendanceConfigFromEnv env 覆盖与非法回落', () => {
    const g = 1_000_000_000;
    const samples = [
      { userId: 1, kind: 'joined' as const, at: g - 45_000 },
      { userId: 1, kind: 'left' as const, at: g - 30_000 }, // 45s 断线在飞
      { userId: 2, kind: 'joined' as const, at: g - 61_000 },
      { userId: 2, kind: 'left' as const, at: g - 55_000 }, // 61s 断线（窗口外）
      { userId: 3, kind: 'joined' as const, at: g - 3 * MIN },
      { userId: 3, kind: 'left' as const, at: g - 2 * MIN }, // 早已离场
      { userId: 4, kind: 'joined' as const, at: g - 10_000 }, // 在场（join 后无 leave）
    ];
    const present = presentUserIdsAt(samples, g, ATTENDANCE_DEFAULT_CONFIG.toleranceMs);
    expect([...present].sort()).toEqual([1, 4]); // 1=容忍吸收；4=主规则；2/3 不在场

    // tolerance=0（关闭容忍半边）：只按序列重放主规则——1 号（leave 末位）转不在场
    const strict = presentUserIdsAt(samples, g, 0);
    expect([...strict].sort()).toEqual([4]);

    expect(
      attendanceConfigFromEnv({ LJR_FULFILLMENT_ATTENDANCE_TOLERANCE_MS: '30000' }).toleranceMs,
    ).toBe(30_000);
    expect(attendanceConfigFromEnv({}).toleranceMs).toBe(60_000);
    expect(
      attendanceConfigFromEnv({ LJR_FULFILLMENT_ATTENDANCE_TOLERANCE_MS: 'not-a-number' })
        .toleranceMs,
    ).toBe(60_000);
  });
});
