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
  ROOM_CLOSED_TOPIC,
  ROOM_OPENED_TOPIC,
  ROOM_OPEN_FAILED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { grantUserRoles, seedLawyerProfile, seedUserShell } from '../identity/lawyer-fixture';
import { seedPaymentOrderRaw } from '../payment/order-fixture';
import { MockPhoneAlertSink } from '../schedule/scheduler-alerts';
import { SchedulerService } from '../schedule/scheduler.service';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from '../trade/trade-fixture';
import { FulfillmentModule } from './fulfillment.module';
import { MockRtcProvider } from './rtc-provider';
import { RoomService } from './room.service';

/**
 * D1 房间生命周期（需 PG；M2-W1 T1——W1 可验段全量）：
 *   开房成功（RoomOpened 出箱+GRACE_END 同事务预写）、R-01 宽限锚（misfire 90s 不吞宽限）、
 *   开房失败（CANCELLED+open_fail_reason+RoomOpenFailed，credit 域零新事件——G1 桩验证）、
 *   ROOM_OPEN 幂等重放（session_id UNIQUE+执行器短路，无重复副作用）、GRACE_END 准点出箱
 *   （事件即止，判定=D3/W2 禁前置）与 recheck=false（room 已终态→CANCELLED 无事件）、
 *   close API（OPEN→CLOSED+RoomClosed 聚合载荷 gross 手算+STL 留痕+重复 409）、
 *   R-03 开房延迟 >30s 告警（scheduler-alerts 既有面集成断言）。
 * 驱动：调度器不自启动，手动 tick（priority=ROOM_OPEN 通道 / normal=其余）。
 */

const MIN = 60_000;
const FIRM_ID = 8801;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

interface RoomRow {
  readonly id: number;
  readonly session_id: number;
  readonly mode: string;
  readonly scheduled_start: Date;
  readonly opened_at: Date | null;
  readonly grace_end: Date;
  readonly closed_at: Date | null;
  readonly status: string;
  readonly open_fail_reason: string | null;
}

describe('D1 房间生命周期（开房/宽限锚/失败分支/幂等/GRACE_END/close/R-03 告警，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let rooms: RoomService;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let rtc: MockRtcProvider;
  let sink: MockPhoneAlertSink;

  /** 直读本域房间行（owner=fulfillment，合法直触点） */
  const roomRow = async (sessionId: number): Promise<RoomRow> => {
    const res = await pool.query<RoomRow>(
      `SELECT id::int AS id, session_id::int AS session_id, mode, scheduled_start, opened_at,
              grace_end, closed_at, status, open_fail_reason
         FROM fulfillment.rooms WHERE session_id = $1`,
      [sessionId],
    );
    return res.rows[0]!;
  };

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY event_id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  const registerJob = async (
    jobType: 'ROOM_OPEN' | 'GRACE_END',
    refType: 'session' | 'room',
    refId: number,
    dueAt: Date,
  ): Promise<void> => {
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, { jobType, refType, refId, dueAt }),
    );
  };

  /** 经调度器真链开房（ROOM_OPEN 预写→priority tick）——misfire 语义由 slotStart 过去量注入 */
  const openRoomViaScheduler = async (sessionId: number, slotStart: Date): Promise<RoomRow> => {
    await registerJob('ROOM_OPEN', 'session', sessionId, slotStart);
    const ticked = await scheduler.tick('priority');
    expect(ticked.done).toBe(1);
    return roomRow(sessionId);
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    // D5 WSS 网关随模块注册后（M2-W1 T3），init 前须挂 ws 适配器（否则 Nest 回落加载未安装的
    // platform-socket.io 直接退出）——仅初始化不 listen，不承载连接
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init(); // onModuleInit：ROOM_OPEN/GRACE_END 执行器注册
    rooms = app.get(RoomService);
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
    rtc = app.get(MockRtcProvider);
    sink = app.get(MockPhoneAlertSink);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    sink.alerts.length = 0;
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('开房成功：room OPEN（mode=场次 room_mode 透传，R-04）+ grace_end=scheduled_start+5min + RoomOpened 出箱 + GRACE_END 同事务预写（due=grace_end）', async () => {
    const slotStart = new Date(Date.now() - 5_000);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'voice');

    const room = await openRoomViaScheduler(sessionId, slotStart);
    expect(room.status).toBe('OPEN');
    expect(room.mode).toBe('voice');
    expect(room.opened_at).not.toBeNull();
    expect(room.closed_at).toBeNull();
    expect(room.open_fail_reason).toBeNull();
    expect(Math.abs(room.scheduled_start.getTime() - slotStart.getTime())).toBeLessThanOrEqual(5);

    const expectedGrace = slotStart.getTime() + 5 * MIN;
    expect(Math.abs(room.grace_end.getTime() - expectedGrace)).toBeLessThanOrEqual(5);

    const opened = await outboxPayloads(ROOM_OPENED_TOPIC);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toEqual({
      room_id: room.id,
      session_id: sessionId,
      grace_end: room.grace_end.toISOString(),
    });

    const jobs = await scheduler.listJobs({ limit: 100 });
    const graceJobs = jobs.filter(
      (j) => j.jobType === 'GRACE_END' && j.refType === 'room' && j.refId === room.id,
    );
    expect(graceJobs).toHaveLength(1);
    expect(graceJobs[0]!.status).toBe('PENDING');
    expect(Math.abs(graceJobs[0]!.dueAt.getTime() - room.grace_end.getTime())).toBeLessThanOrEqual(
      5,
    );
  });

  it('R-01 核心用例：开房延迟 90s（misfire 补执行），grace_end 仍=scheduled_start+5min（锚定约定时刻，不随触发时刻漂移）', async () => {
    const slotStart = new Date(Date.now() - 90_000);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');

    const room = await openRoomViaScheduler(sessionId, slotStart);
    const expectedGrace = slotStart.getTime() + 5 * MIN;
    expect(Math.abs(room.grace_end.getTime() - expectedGrace)).toBeLessThanOrEqual(5);
    // 反证锚点：若误以触发时刻（now）计算，grace_end 会落在 now+5min 附近——锚定后必早于 now+4min
    expect(room.grace_end.getTime()).toBeLessThan(Date.now() + 4 * MIN);
  });

  it('开房失败（mock 注入）：room CANCELLED+open_fail_reason 落值+RoomOpenFailed 出箱，credit 域零新事件（G1 桩验证），无 GRACE_END 预写', async () => {
    rtc.failNextRoom('RTC_CHANNEL_DOWN');
    const slotStart = new Date(Date.now() - 2_000);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');

    const room = await openRoomViaScheduler(sessionId, slotStart);
    expect(room.status).toBe('CANCELLED');
    expect(room.open_fail_reason).toBe('RTC_CHANNEL_DOWN');
    expect(room.opened_at).toBeNull();
    // 失败行 grace_end 仍同锚计算（R-01 锚不因失败分支漂移）
    expect(
      Math.abs(room.grace_end.getTime() - (slotStart.getTime() + 5 * MIN)),
    ).toBeLessThanOrEqual(5);

    const failed = await outboxPayloads(ROOM_OPEN_FAILED_TOPIC);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({ session_id: sessionId, reason: 'RTC_CHANNEL_DOWN' });

    // G1 桩验证：开房失败不扣律师信用——credit 域零新事件
    const creditEvents = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic LIKE 'credit.%'`,
    );
    expect(creditEvents.rows[0]!.n).toBe(0);

    // 终态房间不预写宽限 job
    const jobs = await scheduler.listJobs({ limit: 100 });
    expect(jobs.filter((j) => j.jobType === 'GRACE_END')).toHaveLength(0);
  });

  it('幂等重放：ROOM_OPEN 二次触发（job 重试形态）不重复建房间/出事件/预写宽限 job（session_id UNIQUE+执行器短路）', async () => {
    const slotStart = new Date(Date.now() - 5_000);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');
    const first = await openRoomViaScheduler(sessionId, slotStart);
    expect(first.status).toBe('OPEN');

    // 首访 job 已 DONE——同键新注册生成新 PENDING 行（重放/重试形态），再触发一轮
    await registerJob('ROOM_OPEN', 'session', sessionId, slotStart);
    const ticked = await scheduler.tick('priority');
    expect(ticked.done).toBe(1);

    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.rooms WHERE session_id = $1`,
      [sessionId],
    );
    expect(count.rows[0]!.n).toBe(1);
    expect(await outboxPayloads(ROOM_OPENED_TOPIC)).toHaveLength(1);
    const jobs = await scheduler.listJobs({ limit: 100 });
    expect(jobs.filter((j) => j.jobType === 'GRACE_END' && j.refId === first.id)).toHaveLength(1);
  });

  it('GRACE_END 准点触发：出箱 GracePeriodEnded 即止（room 仍 OPEN，判定=D3/W2 禁前置——D1 §9）；重放无重复事件', async () => {
    // slot_start 6min 前 → grace_end=scheduled_start+5min 已过（1min 前），宽限 job 到期可拾取
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');
    const room = await openRoomViaScheduler(sessionId, slotStart);

    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBe(1);
    const ended = await outboxPayloads(GRACE_PERIOD_ENDED_TOPIC);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toEqual({ room_id: room.id, session_id: sessionId });

    // 事件即止：room 不改状态（IN_SERVICE/缺席判定=D3=W2，本批禁做）
    const after = await roomRow(sessionId);
    expect(after.status).toBe('OPEN');

    // 再 tick 无在册到期 job，无重复事件
    const again = await scheduler.tick('normal');
    expect(again.done).toBe(0);
    expect(await outboxPayloads(GRACE_PERIOD_ENDED_TOPIC)).toHaveLength(1);
  });

  it('GRACE_END recheck=false：room 已 CLOSED（终态）→ job CANCELLED 无事件', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      9301,
      'CONFIRMED',
      new Date(Date.now() - 10 * MIN),
      'text',
    );
    // 直插一已关闭房间（本域 fixture；close 链路另测）
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO fulfillment.rooms
         (session_id, mode, scheduled_start, grace_end, closed_at, status)
       VALUES ($1, 'text', now() - interval '10 minutes', now() - interval '5 minutes',
               now(), 'CLOSED')
       RETURNING id`,
      [sessionId],
    );
    const roomId = Number(inserted.rows[0]!.id);

    await registerJob('GRACE_END', 'room', roomId, new Date(Date.now() - 60_000));
    const ticked = await scheduler.tick('normal');
    expect(ticked.cancelled).toBe(1);
    expect(await outboxPayloads(GRACE_PERIOD_ENDED_TOPIC)).toHaveLength(0);
  });

  it('close API：OPEN→CLOSED（守卫+STL 留痕）+closed_at 落值+RoomClosed 聚合载荷（gross=cash+points/100 手算、payment_order_id=首单、lawyer_id/firm_id 经 trade 导出面）；重复 close 409', async () => {
    // 律师账号壳+角色+档案（firm_id 绑定——A3b 进件后形态）
    const lawyerId = await seedUserShell(pool, 'd1-close');
    await grantUserRoles(pool, lawyerId, ['lawyer']);
    await seedLawyerProfile(pool, lawyerId, 'PASSED', 'd1-close', undefined, FIRM_ID);

    const slotStart = new Date(Date.now() - 5_000);
    const sessionId = await seedSessionAtRaw(pool, lawyerId, 'CONFIRMED', slotStart, 'text');
    // 两笔 PAID 报名+配对支付单（幂等键 enroll/e{id}/pay）：gross=(10000+100)+8050=18150 分=181.50
    //（100 积分=1 元 → 1 积分=1 分，D19 paid_amount 全额口径；e2 纯现金 80.50）
    const e1 = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7101,
      cash: '100.00',
      points: 100,
      unitPrice: '100.00',
    });
    const o1 = await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(e1),
      bizId: e1,
      cash: '100.00',
      points: 100,
    });
    const e2 = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7102,
      cash: '80.50',
      points: 0,
      unitPrice: '80.50',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(e2),
      bizId: e2,
      cash: '80.50',
      points: 0,
    });

    const room = await openRoomViaScheduler(sessionId, slotStart);
    expect(room.status).toBe('OPEN');

    const res = await rooms.closeRoom(sessionId);
    expect(typeof res.closed_at).toBe('string');
    expect(Number.isNaN(Date.parse(res.closed_at))).toBe(false);

    const closed = await roomRow(sessionId);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closed_at).not.toBeNull();

    const events = await outboxPayloads(ROOM_CLOSED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      session_id: sessionId,
      lawyer_id: lawyerId,
      firm_id: FIRM_ID,
      gross: '181.50', // 手算：(10000+100) + 8050 = 18150 分（100 积分=1 元 → 1 积分=1 分）
      payment_order_id: o1, // 首单（W3 单单绑定口径；多单会话=换装位）
    });

    // 守卫留痕（entity_type='room'，OPEN→CLOSED allowed）
    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'room' AND entity_id = $1
          AND from_status = 'OPEN' AND to_status = 'CLOSED' AND allowed`,
      [room.id],
    );
    expect(stl.rows[0]!.n).toBe(1);

    // 幂等键=session：重复 close → 409 NOT_OPEN（已终态）
    await expect(rooms.closeRoom(sessionId)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    expect(await outboxPayloads(ROOM_CLOSED_TOPIC)).toHaveLength(1);
  });

  it('R-03 集成断言：ROOM_OPEN dueAt 过去 45s 触发 → 延迟告警记录在 mock sink（>30s 电话告警面）', async () => {
    const slotStart = new Date(Date.now() - 45_000);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');

    await openRoomViaScheduler(sessionId, slotStart);
    const delayed = sink.alerts.filter((a) => a.kind === 'ROOM_OPEN_DELAY');
    expect(delayed).toHaveLength(1);
    expect(delayed[0]!.jobType).toBe('ROOM_OPEN');
    expect(typeof delayed[0]!.jobId).toBe('number');
  });
});
