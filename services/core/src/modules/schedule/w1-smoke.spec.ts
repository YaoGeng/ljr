import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  NOTIFY_DISPATCHED_TOPIC,
  NotifyDispatcherService,
} from '../notify/notify-dispatcher.service';
import { NotifyModule } from '../notify/notify.module';
import { NotifyTemplateService } from '../notify/notify-template.service';
import { ScheduleExecutorRegistry } from './scheduler-executor.registry';
import { SchedulerModule } from './scheduler.module';
import { SCHEDULE_JOB_FIRED_TOPIC, SchedulerService } from './scheduler.service';
import type { JobContext, JobExecutor } from './scheduler.types';

/**
 * M1-W1 事件链集成烟测（W1 DoD 收口）：一条链走通
 *   I2 REGISTER_JOB（dueAt=过去）→ tick 抢占执行（PENDING→RUNNING→DONE）→
 *   执行器在抢占事务内调 I1 登记 DISPATCH_NOTIFY → processPending 下发（SENT + NotificationDispatched
 *   同事务落 outbox）→ relay tick 投递 → 测试消费者幂等消费（echo 落 I1 台账）→
 *   at-least-once 重投递同事件 → 消费者恰一次生效（idempotency_key 唯一约束挡下）。
 * 验收口径：单链贯通 + 幂等，不铺组合场景（分支细节归各模块自身 spec）。
 *
 * 放置位置与断言面说明（check-schema-refs owner 纪律）：本 spec 是跨模块缝合（schedule+notify），
 * 按「落被查表的 owner 侧」落 schedule 目录——直接 DB 断言仅限 owner 表 schedule.*；
 * notify 侧断言全走 I1 服务面（registerForEvent/dispatch/listInbox）；platform.* 白名单可直查。
 * 不设 modules/integration 目录（owner=integration 引用任何业务表都会触发规则 A）。
 *
 * 借用 REMIND_24H（catalog 22 类型之一，生产执行器=D2 提醒，M2 才落位）：语义与烟测链同构
 * （到期提醒 → 通知触达），烟测执行器即 D2 形态预告；回查锚点「场次状态」属 D 域表未落位 →
 * 烟测恒 true。W1 时点该类型无任何模块注册执行器，测试内注册合法（registry 默认空表）。
 *
 * 模板复用 V4 seed 参照数据 PRICE_UP_LOCKED（INBOX 通道）：不造自定义模板 fixture——
 * schedule owner 文件直插 notify 表违反 schema-refs 规则 A，且模板文案非本烟测断言面
 * （站内信=落表即触达，INBOX 适配器无外部副作用）。
 */

/** 烟测常量：收件人/消费者用户、ref 幂等键半边（虚构 id，TRUNCATE 清场隔离） */
const SMOKE_TEMPLATE = 'PRICE_UP_LOCKED';
const RECIPIENT_USER = 901;
const CONSUMER_USER = 902;
const SMOKE_REF_TYPE = 'session';
const SMOKE_REF_ID = 9001;
const smokeRemindKey = `notify/user-${RECIPIENT_USER}/smoke-remind-${SMOKE_REF_ID}`;

/**
 * W1 烟测执行器（REMIND_24H 借用，见文件头注）：在抢占事务内经 I1 公共在事务 API
 * （registerForEvent，uow=ctx.uow）登记通知——job DONE 与通知 QUEUED 同事务原子提交，
 * 即 D2 真实执行器将来「提醒→DISPATCH_NOTIFY」的接线形态。
 */
class SmokeReminderExecutor implements JobExecutor {
  readonly jobType = 'REMIND_24H' as const;
  recheckCalls = 0;
  notificationId: number | null = null;

  constructor(private readonly dispatcher: NotifyDispatcherService) {}

  async recheck(_ctx: JobContext): Promise<boolean> {
    this.recheckCalls += 1;
    return true; // 回查锚点=场次状态（D 域 M2 落位）；烟测恒有效
  }

  async execute(ctx: JobContext): Promise<Record<string, unknown>> {
    const accepted = await this.dispatcher.registerForEvent(ctx.uow, {
      userId: RECIPIENT_USER,
      templateCode: SMOKE_TEMPLATE,
      params: { session: 'S-2041' },
      idempotencyKey: smokeRemindKey,
    });
    this.notificationId = accepted.notificationId;
    return { notification_id: accepted.notificationId, deduplicated: accepted.deduplicated };
  }
}

describe('M1-W1 事件链烟测（I2 job → I1 通知 → relay 幂等消费，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let scheduler: SchedulerService;
  let dispatcher: NotifyDispatcherService;
  let relay: OutboxRelayService;
  let executor: SmokeReminderExecutor;
  /** 消费者收到的 event_id 序列（观测 at-least-once：同一事件应出现两次） */
  const consumedEventIds: string[] = [];

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [SchedulerModule, NotifyModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // 触发 onModuleInit：notify 事件消费者注册到 relay（fired/dispatched topic 不冲突）
    scheduler = app.get(SchedulerService);
    dispatcher = app.get(NotifyDispatcherService);
    relay = app.get(OutboxRelayService);
    executor = new SmokeReminderExecutor(dispatcher);
    app.get(ScheduleExecutorRegistry).register(executor);
    // 执行模块消费形态：fired 事件由执行方承接——烟测执行器已同步内联执行，noop 承接保持 relay 全绿
    // TODO(D2): D2 提醒服务落位注册同 topic 消费者时，移除本 noop 承接（终审 Important-2）
    relay.registerHandler(SCHEDULE_JOB_FIRED_TOPIC, async () => undefined);
    // 测试消费者：消费 NotificationDispatched，效果=经 I1 公共 API 幂等登记一条回执通知（echo）。
    // 消费幂等：idempotency_key=receipt-ev-<outbox行id>（同一事件重投递必同键），UNIQUE(idempotency_key)
    // 挡二次生效（R-03）；echo 剪枝=只消费烟测原通知的回执（echo 自身回执不续链），链有界确定。
    relay.registerHandler(NOTIFY_DISPATCHED_TOPIC, async (event, uow) => {
      consumedEventIds.push(event.eventId);
      const payload = (event.payload ?? {}) as { id?: number; template_code?: string };
      if (payload.template_code !== SMOKE_TEMPLATE || payload.id !== executor.notificationId) {
        return;
      }
      await dispatcher.registerForEvent(uow, {
        userId: CONSUMER_USER,
        templateCode: SMOKE_TEMPLATE,
        params: { receipt_of: payload.id ?? 0 },
        idempotencyKey: `notify/user-${CONSUMER_USER}/receipt-ev-${event.id}`,
      });
    });
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
    consumedEventIds.length = 0;
  });

  it('单链贯通+幂等：注册(过期 dueAt) → tick 抢占执行 DONE → I1 登记/下发 SENT+回执 → relay 消费 → 重投递恰一次生效', async () => {
    // 0) 前置：seed 参照模板在位且为站内信通道（复用参照数据，见头注）
    const tpl = await app.get(NotifyTemplateService).find(SMOKE_TEMPLATE);
    expect(tpl).toMatchObject({ channel: 'INBOX', critical: false });

    // 1) I2 REGISTER_JOB：dueAt=过去（misfire 自愈口径，§5 幂等键=type+ref）
    const reg = await scheduler.registerJob(pool, {
      jobType: 'REMIND_24H',
      refType: SMOKE_REF_TYPE,
      refId: SMOKE_REF_ID,
      dueAt: new Date(Date.now() - 1_000),
    });
    expect(reg).toMatchObject({ deduplicated: false });

    // 2) I2 tick 抢占执行（测试手动驱动；生产=SchedulerWorker interval，ADR-0003 节拍器非事实源）
    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ channel: 'normal', done: 1, cancelled: 0, retried: 0, failed: 0 });
    expect(executor.recheckCalls).toBe(1); // R-02 回查发生过

    // 断言① schedule_jobs 状态迁移 PENDING→RUNNING→DONE（version 1→3；fired_at 落首次触发时刻）
    const job = await pool.query<{
      status: string;
      version: number;
      retry_count: number;
      fired_at: Date | null;
    }>(`SELECT status, version, retry_count, fired_at FROM schedule.schedule_jobs WHERE id = $1`, [
      reg.jobId,
    ]);
    expect(job.rows[0]).toMatchObject({ status: 'DONE', version: 3, retry_count: 0 });
    expect(job.rows[0]?.fired_at).not.toBeNull();

    // 断言② schedule_job_log 恰一 DONE 行，detail=执行器返回（含通知 id，重放/追溯锚点）
    const nid = executor.notificationId;
    expect(nid).not.toBeNull();
    const logs = await pool.query<{ result: string; detail: string | null }>(
      `SELECT result, detail FROM schedule.schedule_job_log WHERE job_id = $1`,
      [reg.jobId],
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]?.result).toBe('DONE');
    expect(JSON.parse(logs.rows[0]?.detail ?? '{}')).toMatchObject({
      notification_id: nid,
      deduplicated: false,
    });

    // 断言③ I1 通知已随抢占事务登记（QUEUED）：同幂等键重放回读首访、不产生第二行（R-03）
    const replay = await dispatcher.dispatch({
      userId: RECIPIENT_USER,
      templateCode: SMOKE_TEMPLATE,
      params: { session: 'S-2041' },
      idempotencyKey: smokeRemindKey,
    });
    expect(replay).toMatchObject({ notificationId: nid, deduplicated: true, status: 'QUEUED' });
    expect(await dispatcher.listInbox(RECIPIENT_USER)).toHaveLength(0); // 未下发，站内信不可见

    // ScheduleJobFired 与执行同事务落 outbox（§6；业务回滚则事件不出）
    const fired = await pool.query<{ payload: Record<string, unknown>; status: string }>(
      `SELECT payload, status FROM platform.outbox WHERE topic = $1`,
      [SCHEDULE_JOB_FIRED_TOPIC],
    );
    expect(fired.rows).toHaveLength(1);
    expect(fired.rows[0]?.status).toBe('PENDING');
    expect(fired.rows[0]?.payload).toMatchObject({
      job_id: reg.jobId,
      type: 'REMIND_24H',
      ref_type: SMOKE_REF_TYPE,
      ref_id: SMOKE_REF_ID,
    });

    // 断言⑤（schedule 侧）状态迁移经守卫留痕：PENDING→RUNNING + RUNNING→DONE，job_id 回填
    const stl = await pool.query<{ from_status: string; to_status: string; job_id: string | null }>(
      `SELECT from_status, to_status, job_id FROM platform.state_transition_log
        WHERE entity_type = 'schedule_job' AND entity_id = $1 ORDER BY id`,
      [reg.jobId],
    );
    expect(stl.rows.map((r) => `${r.from_status}→${r.to_status}`)).toEqual([
      'PENDING→RUNNING',
      'RUNNING→DONE',
    ]);
    expect(stl.rows.every((r) => r.job_id === String(reg.jobId))).toBe(true);

    // 3) I1 下发驱动（手动 processPending；生产=NotifyDispatchWorker interval）：
    //    渲染 → 偏好（缺省=投递）→ 站内信通道（落表即触达）→ SENT + NotificationDispatched 同事务
    const send = await dispatcher.processPending();
    expect(send).toMatchObject({ sent: 1, skipped: 0, failed: 0, retried: 0, gone: 0 });

    // 断言③续 notifications 恰一条且 SENT（站内信可见，params 原样往返）
    const inbox = await dispatcher.listInbox(RECIPIENT_USER);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: nid,
      templateCode: SMOKE_TEMPLATE,
      channel: 'INBOX',
      status: 'SENT',
      params: { session: 'S-2041' },
    });
    expect(inbox[0]?.sentAt).not.toBeNull();

    // 回执事件恰一条（同事务产出），载荷={id, template_code, status}
    const receipt = await pool.query<{ event_id: string; payload: Record<string, unknown> }>(
      `SELECT event_id::text AS event_id, payload FROM platform.outbox WHERE topic = $1`,
      [NOTIFY_DISPATCHED_TOPIC],
    );
    expect(receipt.rows).toHaveLength(1);
    const receiptEventId = receipt.rows[0]?.event_id ?? '';
    expect(receipt.rows[0]?.payload).toMatchObject({
      id: nid,
      template_code: SMOKE_TEMPLATE,
      status: 'SENT',
    });

    // 断言⑤（notify 侧）迁移留痕：QUEUED→SENT 放行一行
    const notifyLog = await pool.query<{
      from_status: string;
      to_status: string;
      allowed: boolean;
    }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'notify_notification' AND entity_id = $1`,
      [nid],
    );
    expect(notifyLog.rows).toHaveLength(1);
    expect(notifyLog.rows[0]).toMatchObject({
      allowed: true,
      from_status: 'QUEUED',
      to_status: 'SENT',
    });

    // 4) relay 投递（手动 tick；生产=main.ts start()）：fired（noop 承接）+ 原回执（测试消费者）各恰一次
    const relayTick1 = await relay.tick();
    expect(relayTick1).toMatchObject({ dispatched: 2, retried: 0, dead: 0 });

    // 消费效果落 I1 台账（echo 登记为 QUEUED），再驱动下发 → SENT（消费者效果走完整 I1 管线；
    // echoSend sent:1 即证 echo 存在——此时 QUEUED 仅 echo 一条）
    const echoSend = await dispatcher.processPending();
    expect(echoSend).toMatchObject({ sent: 1 });
    expect(await dispatcher.listInbox(CONSUMER_USER)).toHaveLength(1);
    // echo 的回执事件照常产出（template_code 相同但 id 不同 → 消费者剪枝，不续链）
    const echoReceipt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 AND payload->>'id' <> $2`,
      [NOTIFY_DISPATCHED_TOPIC, String(nid)],
    );
    expect(echoReceipt.rows).toHaveLength(1);

    // 5) 断言幂等：模拟 at-least-once 重投递（效果已生效、SENT 标记丢失的崩溃窗口，demo spec 同款）
    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE event_id = $1::uuid`,
      [receiptEventId],
    );
    const relayTick2 = await relay.tick();
    expect(relayTick2).toMatchObject({ dispatched: 2, retried: 0, dead: 0 }); // 原回执 + echo 回执
    expect(consumedEventIds.filter((id) => id === receiptEventId)).toHaveLength(2); // 确实投了两次

    // 消费者恰一次生效：echo 通知仍恰一条（二次投递被 UNIQUE(idempotency_key) 挡下，R-03）
    expect(await dispatcher.listInbox(CONSUMER_USER)).toHaveLength(1);
    expect(await dispatcher.listInbox(RECIPIENT_USER)).toHaveLength(1);

    // 全链收口：无死信；fired + 两笔回执事件全部 SENT（恰一投递痕迹，无残留 PENDING）
    const dead = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox_dead_letter`,
    );
    expect(dead.rows[0]?.n).toBe(0);
    const outbox = await pool.query<{ status: string }>(`SELECT status FROM platform.outbox`);
    expect(outbox.rows).toHaveLength(3);
    expect(outbox.rows.every((r) => r.status === 'SENT')).toBe(true);
  });
});
