import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import { REMINDER_DISPATCHED_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { SchedulerService } from '../schedule/scheduler.service';
import type { ScheduleJobType } from '../schedule/scheduler.catalog';
import { countJobLogsByResult } from '../schedule/job-fixture';
import {
  roomConversationMessagesRaw,
  roomRowOfSessionRaw,
} from '../fulfillment/fulfillment-fixture';
import { seedPaidEnrollmentRaw, seedSessionAtRaw, sessionStatusRaw } from '../trade/trade-fixture';
import { ReminderModule } from './reminder.module';
import { SESSION_REMIND_TEMPLATE_CODE } from './reminder.service';
import { NotifyDispatcherService } from './notify-dispatcher.service';
import { deleteTemplateRaw } from './notify-fixture';

/**
 * D2 提醒服务（需 PG；M2-W1 T4——W1 可验段全量，docs/modules/D-履约/D2-提醒服务.md §9/§10）：
 *   四档准点（R-01：REMIND×4 逐人 notifications+ReminderDispatched 出箱+job DONE）；
 *   取消/终态（R-03：终态场次 recheck=false → CANCELLED 零通知；流标路径同事务作废 REMIND×4——
 *   failOnDeadline 作废钩断言）；幂等重放（(user,kind,session) 判重：零新增通知零新增事件）；
 *   房间内同步提醒（宽限开始=RoomOpened 消费 / REMIND_1MIN 进行中房间 / REMIND_GRACE_END
 *   宽限结束前 1min——@Agent 名义 sender_role='agent'）；
 *   NO_EXECUTOR 消失并验（04 §8 #33：REMIND×4/ROOM_OPEN/GRACE_END/REMIND_GRACE_END 全有执行器，
 *   schedule_job_log 零 NO_EXECUTOR 行）；无 PAID enrollment 零通知零事件（正常路径非错误）。
 * 驱动：调度器/relay 不自启动，手动 tick（priority=ROOM_OPEN 通道 / normal=其余）。
 */

const MIN = 60_000;
const HOUR = 3_600_000;

/** C1 预写口径的 REMIND 偏移（session.service REMIND_OFFSETS_MS 同值——spec 侧锚） */
const REMIND_OFFSETS_MS: ReadonlyArray<readonly [ScheduleJobType, number]> = [
  ['REMIND_24H', 24 * HOUR],
  ['REMIND_1H', 1 * HOUR],
  ['REMIND_10MIN', 10 * MIN],
  ['REMIND_1MIN', 1 * MIN],
];

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

interface MessageRow {
  readonly seq: number;
  readonly sender_role: string;
  readonly type: string;
  readonly content: string;
  readonly mention: string | null;
}

describe('D2 提醒服务（四档/作废/幂等重放/房间内提醒/NO_EXECUTOR 消失，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let scheduler: SchedulerService;
  let dispatcher: NotifyDispatcherService;
  let relay: OutboxRelayService;
  let poolSvc: PgPoolService;

  const registerJob = async (
    jobType: ScheduleJobType,
    refType: 'session' | 'room',
    refId: number,
    dueAt: Date,
  ): Promise<void> => {
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, { jobType, refType, refId, dueAt }),
    );
  };

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY event_id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  const remindNotifications = async (): Promise<{ user_id: string; status: string }[]> => {
    const res = await pool.query<{ user_id: string; status: string }>(
      `SELECT user_id::text AS user_id, status FROM notify.notifications
        WHERE template_code = $1 ORDER BY id`,
      [SESSION_REMIND_TEMPLATE_CODE],
    );
    return res.rows;
  };

  const sessionStatus = (sessionId: number): Promise<string | undefined> =>
    sessionStatusRaw(pool, sessionId);

  const roomRowOf = (sessionId: number) => roomRowOfSessionRaw(pool, sessionId);

  /** room 会话全部消息（seq 升序；@Agent 提醒断言锚——fulfillment-fixture 承载跨域读） */
  const roomMessages = (roomId: number): Promise<readonly MessageRow[]> =>
    roomConversationMessagesRaw(pool, roomId).then((rows) =>
      rows.map((r) => ({
        seq: r.seq,
        sender_role: r.sender_role,
        type: r.type,
        content: r.content,
        mention: r.mention,
      })),
    );

  /** 经调度器真链开房（ROOM_OPEN 预写→priority tick→room OPEN+会话+RoomOpened 出箱） */
  const openRoomViaScheduler = async (
    sessionId: number,
    slotStart: Date,
  ): Promise<{ id: number; grace_end: Date }> => {
    await registerJob('ROOM_OPEN', 'session', sessionId, slotStart);
    const ticked = await scheduler.tick('priority');
    expect(ticked.done).toBe(1);
    const room = await roomRowOf(sessionId);
    expect(room.status).toBe('OPEN');
    return room;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [ReminderModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    // FulfillmentModule 随模块引入（D5 WSS 网关），init 前挂 ws 适配器（room.spec 同款）
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init(); // onModuleInit：REMIND×4/REMIND_GRACE_END 执行器+RoomOpened 消费器注册
    scheduler = app.get(SchedulerService);
    dispatcher = app.get(NotifyDispatcherService);
    relay = app.get(OutboxRelayService);
    poolSvc = app.get(PgPoolService);
  });

  afterAll(async () => {
    // 自愈模板的参照数据纪律清理（notify-fixture 头注：不入 TRUNCATE 清单，用后须删）
    await deleteTemplateRaw(pool, SESSION_REMIND_TEMPLATE_CODE);
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('R-01 四档准点：REMIND×4 到期触发 → 每人 notifications 行+ReminderDispatched 出箱（enrollment 锚）+job DONE；I1 全链（D7 站内信）可推进 SENT', async () => {
    const slotStart = new Date(Date.now() - 2 * HOUR); // 四档 due 全部已过
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');
    const e1 = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7101,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const e2 = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7102,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    for (const [jobType, offsetMs] of REMIND_OFFSETS_MS) {
      await registerJob(jobType, 'session', sessionId, new Date(slotStart.getTime() - offsetMs));
    }

    const ticked = await scheduler.tick('normal', 10);
    expect(ticked.done).toBe(4);

    // 每人×每档=8 行（QUEUED 登记即回执锚——notifications 行+事件，⚠W1-5 不建 notification_jobs；
    // 修环 M3 收紧：此刻恰 QUEUED——processPending 在本用例尾段才驱动）
    const rows = await remindNotifications();
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.status === 'QUEUED')).toBe(true);

    // ReminderDispatched 逐人出箱：ref 锚=enrollment（A.1 契约逐字）
    const events = await outboxPayloads(REMINDER_DISPATCHED_TOPIC);
    expect(events).toHaveLength(8);
    expect(events).toContainEqual({
      ref_type: 'enrollment',
      ref_id: e1,
      user_id: 7101,
      kind: 'REMIND_24H',
    });
    expect(events).toContainEqual({
      ref_type: 'enrollment',
      ref_id: e2,
      user_id: 7102,
      kind: 'REMIND_1MIN',
    });

    // job 全 DONE
    const jobs = await scheduler.listJobs({ limit: 100 });
    const remindJobs = jobs.filter((j) => REMIND_OFFSETS_MS.some(([t]) => t === j.jobType));
    expect(remindJobs).toHaveLength(4);
    expect(remindJobs.every((j) => j.status === 'DONE')).toBe(true);

    // I1 全链（D7=站内信默认）：processPending 推进 SENT（模板自愈+INBOX 通道）
    const dispatch = await dispatcher.processPending();
    expect(dispatch.sent).toBe(8);
    expect((await remindNotifications()).every((r) => r.status === 'SENT')).toBe(true);
  });

  it('R-03 终态场次：FAILED → recheck=false → job CANCELLED，零通知零事件（幽灵提醒禁令）', async () => {
    const slotStart = new Date(Date.now() - 2 * MIN);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'FAILED', slotStart, 'text');
    await registerJob('REMIND_1MIN', 'session', sessionId, new Date(slotStart.getTime() - MIN));

    const ticked = await scheduler.tick('normal', 5);
    expect(ticked.cancelled).toBe(1);
    expect(await remindNotifications()).toHaveLength(0);
    expect(await outboxPayloads(REMINDER_DISPATCHED_TOPIC)).toHaveLength(0);
    const jobs = await scheduler.listJobs({ jobType: 'REMIND_1MIN', limit: 10 });
    expect(jobs[0]!.status).toBe('CANCELLED');
  });

  it('R-03 流标路径作废钩：ENROLL_DEADLINE 流标（CREATED 且未满员）→ 同事务作废未发 REMIND×4（failOnDeadline 补钩断言）', async () => {
    const slotStart = new Date(Date.now() + 2 * HOUR); // deadline=slot-24h 已过，REMIND 未到点
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CREATED', slotStart, 'text');
    const deadline = new Date(slotStart.getTime() - 24 * HOUR);
    await registerJob('ENROLL_DEADLINE', 'session', sessionId, deadline);
    for (const [jobType, offsetMs] of REMIND_OFFSETS_MS) {
      await registerJob(jobType, 'session', sessionId, new Date(slotStart.getTime() - offsetMs));
    }

    const ticked = await scheduler.tick('normal', 10);
    expect(ticked.done).toBe(1); // 仅 ENROLL_DEADLINE 到期（REMIND×4 due 未来不拾取）
    expect(await sessionStatus(sessionId)).toBe('FAILED');

    const jobs = await scheduler.listJobs({ limit: 100 });
    const remindJobs = jobs.filter((j) => REMIND_OFFSETS_MS.some(([t]) => t === j.jobType));
    expect(remindJobs).toHaveLength(4);
    expect(remindJobs.every((j) => j.status === 'CANCELLED')).toBe(true); // 作废钩生效
    expect(await remindNotifications()).toHaveLength(0);
    expect(await outboxPayloads(REMINDER_DISPATCHED_TOPIC)).toHaveLength(0);
  });

  it('修环 I-1 收紧：CREATED 且报名已截止（ENROLL_DEADLINE 重试退避窗内未终态化）→ REMIND_24H recheck=false → CANCELLED 零通知零事件（幽灵提醒禁令）', async () => {
    // slot_start=now+2h → deadline=slot−24h=now−22h 已过；REMIND_24H due=slot−24h 同刻已过
    const slotStart = new Date(Date.now() + 2 * HOUR);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CREATED', slotStart, 'text');
    // 有 PAID 付款人也零发——recheck 半边先于 execute 拦截
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7101,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    await registerJob(
      'REMIND_24H',
      'session',
      sessionId,
      new Date(slotStart.getTime() - 24 * HOUR),
    );

    const ticked = await scheduler.tick('normal', 5);
    expect(ticked.cancelled).toBe(1);
    expect(await remindNotifications()).toHaveLength(0);
    expect(await outboxPayloads(REMINDER_DISPATCHED_TOPIC)).toHaveLength(0);
    const jobs = await scheduler.listJobs({ jobType: 'REMIND_24H', limit: 10 });
    expect(jobs[0]!.status).toBe('CANCELLED');
    // 成团链不受收紧影响：CONFIRMED 场次四档照发（既有「四档准点」用例锚，此处不再重复）
  });

  it('幂等重放：同 job 再驱动（重试形态）→ (user,kind,session) 判重 → notifications 零新增+事件零新增', async () => {
    const slotStart = new Date(Date.now() - 2 * MIN);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7101,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const due = new Date(slotStart.getTime() - MIN);
    await registerJob('REMIND_1MIN', 'session', sessionId, due);
    await scheduler.tick('normal', 5);
    expect(await remindNotifications()).toHaveLength(1);
    expect(await outboxPayloads(REMINDER_DISPATCHED_TOPIC)).toHaveLength(1);

    // 首访 job 已 DONE——同键新注册生成新 PENDING 行（重试形态），再触发一轮
    await registerJob('REMIND_1MIN', 'session', sessionId, due);
    const ticked = await scheduler.tick('normal', 5);
    expect(ticked.done).toBe(1);
    expect(await remindNotifications()).toHaveLength(1); // 零新增
    expect(await outboxPayloads(REMINDER_DISPATCHED_TOPIC)).toHaveLength(1); // 零新增
  });

  it('房间内同步提醒（@Agent 名义）：宽限开始（RoomOpened 消费）+REMIND_1MIN 进行中房间+REMIND_GRACE_END（宽限结束前 1min，D1 预写 due=grace_end−1min）', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN); // 宽限已尽：GRACE_END/REMIND_GRACE_END 均到期
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7101,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });

    const room = await openRoomViaScheduler(sessionId, slotStart);
    // D1 预写锚：REMIND_GRACE_END due=grace_end−1min（同事务预写，锚定约定时刻）
    const jobsAfterOpen = await scheduler.listJobs({ jobType: 'REMIND_GRACE_END', limit: 10 });
    expect(jobsAfterOpen).toHaveLength(1);
    expect(jobsAfterOpen[0]!.refType).toBe('room');
    expect(jobsAfterOpen[0]!.refId).toBe(room.id);
    expect(
      Math.abs(jobsAfterOpen[0]!.dueAt.getTime() - (room.grace_end.getTime() - MIN)),
    ).toBeLessThanOrEqual(5);

    // 宽限开始：RoomOpened 事件消费 → 房间消息（relay 手动驱动）
    const relayed = await relay.tick();
    expect(relayed.dispatched).toBeGreaterThanOrEqual(1);
    let messages = await roomMessages(room.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender_role).toBe('agent');
    expect(messages[0]!.mention).toBe('agent');
    expect(messages[0]!.content).toContain('宽限期已开始');
    expect(messages[0]!.content).toContain('不构成法律意见');

    // REMIND_1MIN（进行中房间）+REMIND_GRACE_END+GRACE_END 三 job 到期触发
    await registerJob('REMIND_1MIN', 'session', sessionId, new Date(slotStart.getTime() - MIN));
    const ticked = await scheduler.tick('normal', 10);
    expect(ticked.done).toBe(3);

    messages = await roomMessages(room.id);
    expect(messages).toHaveLength(3);
    const contents = messages.map((m) => m.content);
    expect(contents.some((c) => c.includes('场次提醒'))).toBe(true); // REMIND_1MIN 房间消息
    expect(contents.some((c) => c.includes('宽限期将于 1 分钟后结束'))).toBe(true); // REMIND_GRACE_END
    expect(messages.every((m) => m.sender_role === 'agent' && m.mention === 'agent')).toBe(true);
    // seq 会话内单调无洞
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);

    // REMIND_1MIN 的个人通知照发（房间消息与站内信并存）
    expect(await remindNotifications()).toHaveLength(1);
  });

  it('NO_EXECUTOR 消失并验（04 §8 #33 关闭证据）：REMIND×4/ROOM_OPEN/GRACE_END/REMIND_GRACE_END 全触发 → schedule_job_log 零 NO_EXECUTOR 行', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');
    for (const [jobType, offsetMs] of REMIND_OFFSETS_MS) {
      await registerJob(jobType, 'session', sessionId, new Date(slotStart.getTime() - offsetMs));
    }
    await registerJob('ROOM_OPEN', 'session', sessionId, slotStart); // 开房预写 GRACE_END+REMIND_GRACE_END

    const priority = await scheduler.tick('priority');
    expect(priority.done).toBe(1); // ROOM_OPEN（预写 GRACE_END+REMIND_GRACE_END）
    const normal = await scheduler.tick('normal', 10);
    expect(normal.done).toBe(6); // REMIND×4 + REMIND_GRACE_END + GRACE_END
    expect(normal.failed).toBe(0);

    // 零 NO_EXECUTOR（设计内噪音消失，04 §8 #33 关闭证据）+ 涉事六类逐型 DONE
    const auditedTypes: ScheduleJobType[] = [
      ...REMIND_OFFSETS_MS.map(([t]) => t),
      'ROOM_OPEN',
      'GRACE_END',
      'REMIND_GRACE_END',
    ];
    for (const t of auditedTypes) {
      expect(await countJobLogsByResult(pool, t, 'NO_EXECUTOR')).toBe(0);
      expect(await countJobLogsByResult(pool, t, 'DONE')).toBe(1);
    }
  });

  it('无 PAID enrollment 的场次：零通知零事件+job DONE（正常路径非错误）；进行中房间不发场次提醒消息（分发零新发门控）', async () => {
    const slotStart = new Date(Date.now() - 6 * MIN);
    const sessionId = await seedSessionAtRaw(pool, 9301, 'CONFIRMED', slotStart, 'text');
    const room = await openRoomViaScheduler(sessionId, slotStart);

    await registerJob('REMIND_1MIN', 'session', sessionId, new Date(slotStart.getTime() - MIN));
    const ticked = await scheduler.tick('normal', 5);
    expect(ticked.done).toBe(3); // 修环 M3 收紧：REMIND_1MIN+REMIND_GRACE_END+GRACE_END 恰三条
    expect(await remindNotifications()).toHaveLength(0);
    expect(await outboxPayloads(REMINDER_DISPATCHED_TOPIC)).toHaveLength(0);
    const remindJob = (await scheduler.listJobs({ jobType: 'REMIND_1MIN', limit: 10 }))[0]!;
    expect(remindJob.status).toBe('DONE');

    // 门控：分发零新发 → 不落场次提醒房间消息（REMIND_GRACE_END 消息不在此断言范围，按内容区分）
    const messages = await roomMessages(room.id);
    expect(messages.filter((m) => m.content.includes('场次提醒'))).toHaveLength(0);
  });
});
