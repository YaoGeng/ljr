import 'reflect-metadata';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  OutboxRelayService,
  type RelayEvent,
} from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { MockPhoneAlertSink, SchedulerAlertService } from './scheduler-alerts';
import { SCHEDULE_JOB_FIRED_TOPIC, SchedulerService } from './scheduler.service';
import { ScheduleExecutorRegistry } from './scheduler-executor.registry';
import type { JobContext, JobExecutor } from './scheduler.types';
import { SchedulerModule } from './scheduler.module';
import type { ScheduleJobType } from './scheduler.catalog';

/**
 * I2 调度机制 e2e（需 PG）：REGISTER/CANCEL（与业务同事务）→ SKIP LOCKED 抢占 → 执行器幂等回查（R-02）
 * → 执行 → DONE + schedule_job_log（R-04）+ ScheduleJobFired 同事务落 outbox → relay 投递。
 * 覆盖 §9：抢占并发 / 回查幂等 / 作废生效（version）/ 开房优先级 / 重试退避 / 100 job 双执行器压测。
 *
 * 装配隔离：调度器不自启动（SchedulerWorker.start 仅 main.ts 调用），测试手动 tick 驱动；
 * 重试退避等需特殊参数的场景以独立装配（手动构造，backoff=0）验证，不污染默认装配用例。
 */

/** 可编程桩执行器（W1 机制验证用；SLOT_*、RULE_EFFECTIVE 等真实执行器由后续任务注册） */
class StubExecutor implements JobExecutor {
  readonly jobType: ScheduleJobType;
  executeCalls = 0;
  recheckCalls = 0;
  failTimesRemaining = 0;
  recheckResult = true;
  readonly executedRefs: string[] = [];

  constructor(jobType: ScheduleJobType) {
    this.jobType = jobType;
  }

  reset(): void {
    this.executeCalls = 0;
    this.recheckCalls = 0;
    this.failTimesRemaining = 0;
    this.recheckResult = true;
    this.executedRefs.length = 0;
  }

  async recheck(_ctx: JobContext): Promise<boolean> {
    this.recheckCalls += 1;
    return this.recheckResult;
  }

  async execute(ctx: JobContext): Promise<Record<string, unknown>> {
    this.executeCalls += 1;
    if (this.failTimesRemaining > 0) {
      this.failTimesRemaining -= 1;
      throw new Error('stub 执行失败');
    }
    this.executedRefs.push(`${ctx.job.refType}:${String(ctx.job.refId)}`);
    return { ok: true, refId: ctx.job.refId };
  }
}

/**
 * 可控阻塞失败执行器（仅竞态测试用）：execute 挂起直至 fail() 再抛错——
 * 用于确定性复现「抢占事务回滚后、善后事务执行前，job 已被另一节点推进」的竞态窗口
 * （行锁队列保序：并发方的 FOR UPDATE 请求先于善后事务排队，回滚后必先获锁）。
 */
class BlockedFailExecutor implements JobExecutor {
  readonly jobType: ScheduleJobType;
  executeCalls = 0;
  private resolveStarted!: () => void;
  private releaseFn!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  constructor(jobType: ScheduleJobType) {
    this.jobType = jobType;
  }

  async recheck(): Promise<boolean> {
    return true;
  }

  async execute(): Promise<Record<string, unknown>> {
    this.executeCalls += 1;
    this.resolveStarted();
    await new Promise<void>((resolve) => {
      this.releaseFn = resolve;
    });
    throw new Error('竞态复现：善后前已被并发推进');
  }

  fail(): void {
    this.releaseFn();
  }
}

describe('I2 调度机制核心（默认装配，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: SchedulerService;
  let relay: OutboxRelayService;
  let sink: MockPhoneAlertSink;
  let poolSvc: PgPoolService;
  let remind: StubExecutor;
  let room: StubExecutor;

  const jobRow = async (jobId: number) => {
    const res = await pool.query<{
      id: string;
      status: string;
      version: number;
      retry_count: number;
      last_error: string | null;
      fired_at: Date | null;
    }>(
      `SELECT id, status, version, retry_count, last_error, fired_at
         FROM schedule.schedule_jobs WHERE id = $1`,
      [jobId],
    );
    return res.rows[0];
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [SchedulerModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(SchedulerService);
    relay = app.get(OutboxRelayService);
    sink = app.get(MockPhoneAlertSink);
    poolSvc = app.get(PgPoolService);
    const registry = app.get(ScheduleExecutorRegistry);
    remind = new StubExecutor('REMIND_10MIN');
    room = new StubExecutor('ROOM_OPEN');
    registry.register(remind);
    registry.register(room);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    remind.reset();
    room.reset();
    sink.alerts.length = 0;
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('R-01 全链：注册（与业务同事务）→ tick 抢占 → 回查+执行 → DONE+log+ScheduleJobFired → relay 投递消费', async () => {
    // 与业务同事务注册（调用方在自己的业务事务内调 REGISTER_JOB）
    const reg = await poolSvc.withTransaction((uow) =>
      svc.registerJob(uow, {
        jobType: 'REMIND_10MIN',
        refType: 'session',
        refId: 501,
        dueAt: new Date(Date.now() - 1_000),
      }),
    );
    expect(reg).toMatchObject({ deduplicated: false });
    expect((await jobRow(reg.jobId))?.status).toBe('PENDING');
    expect((await jobRow(reg.jobId))?.version).toBe(1);

    // 节拍驱动（测试手动 tick；生产由 SchedulerWorker interval 驱动）
    const tick = await svc.tick('normal');
    expect(tick).toMatchObject({ channel: 'normal', done: 1, cancelled: 0, retried: 0, failed: 0 });

    // 终态与版本推进（claim + done 两次迁移各 +1）
    const row = await jobRow(reg.jobId);
    expect(row).toMatchObject({ status: 'DONE', version: 3, retry_count: 0, last_error: null });
    expect(row?.fired_at).not.toBeNull();

    // R-04：执行落 schedule_job_log
    const logs = await pool.query<{ result: string; detail: string | null }>(
      `SELECT result, detail FROM schedule.schedule_job_log WHERE job_id = $1`,
      [reg.jobId],
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]?.result).toBe('DONE');
    expect(JSON.parse(logs.rows[0]?.detail ?? '{}')).toMatchObject({ ok: true, refId: 501 });

    // 状态迁移经守卫留痕（状态禁裸写）：PENDING→RUNNING + RUNNING→DONE
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

    // §6：ScheduleJobFired{job_id, type, ref} 与执行同事务落 outbox
    const evt = await pool.query<{ event_id: string; payload: Record<string, unknown> }>(
      `SELECT event_id::text AS event_id, payload FROM platform.outbox WHERE topic = $1`,
      [SCHEDULE_JOB_FIRED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]?.payload).toMatchObject({
      job_id: reg.jobId,
      type: 'REMIND_10MIN',
      ref_type: 'session',
      ref_id: 501,
    });

    // 事件链干净可用：relay 投递 → 消费者收到（W1 集成烟测同款链路）
    const received: RelayEvent[] = [];
    relay.registerHandler(SCHEDULE_JOB_FIRED_TOPIC, async (event) => {
      received.push(event);
    });
    const relayTick = await relay.tick();
    expect(relayTick.dispatched).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toMatchObject({ job_id: reg.jobId, type: 'REMIND_10MIN' });
    expect(remind.executeCalls).toBe(1);
    expect(remind.executedRefs).toEqual(['session:501']);
  });

  it('§5 REGISTER_JOB 幂等键=type+ref：同键二次注册去重回首访；不同 ref 各自成 job；非法入参拒绝', async () => {
    const input = {
      jobType: 'REMIND_10MIN' as const,
      refType: 'session',
      refId: 511,
      dueAt: new Date(Date.now() - 1_000),
    };
    const first = await svc.registerJob(pool, input);
    const second = await svc.registerJob(pool, input);
    expect(first.deduplicated).toBe(false);
    expect(second).toMatchObject({ jobId: first.jobId, deduplicated: true });

    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.schedule_jobs`,
    );
    expect(rows.rows[0]?.n).toBe(1);

    const other = await svc.registerJob(pool, { ...input, refId: 512 });
    expect(other.jobId).not.toBe(first.jobId);

    // 非法 job 类型（不在全集注册表）与非法 ref
    await expect(
      svc.registerJob(pool, { ...input, jobType: 'NOT_A_JOB' as never }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument, httpStatus: 400 });
    await expect(
      svc.registerJob(pool, { ...input, jobType: 'REMIND_10MIN', refType: '' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      svc.registerJob(pool, { ...input, jobType: 'REMIND_10MIN', refId: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    const rowsAfter = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.schedule_jobs`,
    );
    expect(rowsAfter.rows[0]?.n).toBe(2); // 非法入参未落行
  });

  it('R-02 回查幂等（§10）：业务先取消后 job 触发 → CANCELLED 无操作（执行器零调用）', async () => {
    const reg = await svc.registerJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 521,
      dueAt: new Date(Date.now() - 1_000),
    });
    const cancel = await svc.cancelJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 521,
    });
    expect(cancel).toMatchObject({ jobId: reg.jobId, cancelled: true, stale: false });

    const tick = await svc.tick('normal');
    expect(tick).toMatchObject({ done: 0, cancelled: 0, retried: 0, failed: 0 });
    expect(remind.recheckCalls).toBe(0);
    expect(remind.executeCalls).toBe(0);
    expect((await jobRow(reg.jobId))?.status).toBe('CANCELLED');

    // 业务作废走守卫留痕；调度执行日志无行（未被触发）
    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'schedule_job' AND entity_id = $1 AND to_status = 'CANCELLED' AND allowed = true`,
      [reg.jobId],
    );
    expect(stl.rows[0]?.n).toBe(1);
    const logs = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.schedule_job_log`,
    );
    expect(logs.rows[0]?.n).toBe(0);
  });

  it('R-02 执行前回查：recheck=false（业务态已过期）→ CANCELLED 无操作，execute 不触', async () => {
    remind.recheckResult = false;
    const reg = await svc.registerJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 522,
      dueAt: new Date(Date.now() - 1_000),
    });
    const tick = await svc.tick('normal');
    expect(tick).toMatchObject({ cancelled: 1, done: 0 });
    expect(remind.recheckCalls).toBe(1);
    expect(remind.executeCalls).toBe(0);
    expect((await jobRow(reg.jobId))?.status).toBe('CANCELLED');

    const logs = await pool.query<{ result: string }>(
      `SELECT result FROM schedule.schedule_job_log WHERE job_id = $1`,
      [reg.jobId],
    );
    expect(logs.rows.map((r) => r.result)).toEqual(['CANCELLED']);
  });

  it('作废生效（§9 version 比对）：按期望 version 作废一次成功；过期 version 再作废被拒（stale）；终态不可作废', async () => {
    const reg = await svc.registerJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 531,
      dueAt: new Date(Date.now() - 1_000),
    });
    // 期望 version=1 作废成功，version 推进到 2
    const ok = await svc.cancelJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 531,
      expectedVersion: 1,
    });
    expect(ok).toMatchObject({ jobId: reg.jobId, cancelled: true, stale: false });
    expect(await jobRow(reg.jobId)).toMatchObject({ status: 'CANCELLED', version: 2 });

    // 携带过期 version（并发视角已推进）再作废：0 行生效 → stale，行不再变更
    const stale = await svc.cancelJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 531,
      expectedVersion: 1,
    });
    expect(stale).toMatchObject({ jobId: reg.jobId, cancelled: false, stale: true });
    expect(await jobRow(reg.jobId)).toMatchObject({ status: 'CANCELLED', version: 2 });

    // 终态（无期望 version）作废：无可作废对象，cancelled=false 且非 version 冲突
    const terminal = await svc.cancelJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 531,
    });
    expect(terminal).toMatchObject({ jobId: reg.jobId, cancelled: false, stale: false });

    // 未在册键：jobId=null
    expect(
      await svc.cancelJob(pool, { jobType: 'REMIND_10MIN', refType: 'session', refId: 999_999 }),
    ).toMatchObject({ jobId: null, cancelled: false, stale: false });

    // 成功作废走守卫（PENDING→CANCELLED），stale/无效请求不产生第二条放行留痕
    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'schedule_job' AND entity_id = $1 AND allowed = true`,
      [reg.jobId],
    );
    expect(stl.rows[0]?.n).toBe(1);
  });

  it('REGISTER/CANCEL 与业务同事务：业务事务回滚则 job 写入/作废一并回滚', async () => {
    const input = {
      jobType: 'REMIND_10MIN' as const,
      refType: 'session',
      refId: 541,
      dueAt: new Date(Date.now() - 1_000),
    };
    await expect(
      poolSvc.withTransaction(async (uow) => {
        await svc.registerJob(uow, input);
        throw new Error('业务失败回滚');
      }),
    ).rejects.toThrow('业务失败回滚');
    const afterRegister = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.schedule_jobs`,
    );
    expect(afterRegister.rows[0]?.n).toBe(0);

    const reg = await svc.registerJob(pool, input);
    await expect(
      poolSvc.withTransaction(async (uow) => {
        await svc.cancelJob(uow, { jobType: 'REMIND_10MIN', refType: 'session', refId: 541 });
        throw new Error('业务失败回滚');
      }),
    ).rejects.toThrow('业务失败回滚');
    expect((await jobRow(reg.jobId))?.status).toBe('PENDING'); // 作废随业务事务回滚
  });

  it('NO_EXECUTOR：未注册类型的到期 job 直接 FAILED+告警（确定性配置错误，不烧重试）', async () => {
    const reg = await svc.registerJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE', // 本 describe 未注册其执行器
      refType: 'settlement',
      refId: 551,
      dueAt: new Date(Date.now() - 1_000),
    });
    const tick = await svc.tick('normal');
    expect(tick).toMatchObject({ failed: 1, done: 0, retried: 0 });
    expect((await jobRow(reg.jobId))?.status).toBe('FAILED');
    expect((await jobRow(reg.jobId))?.retry_count).toBe(0); // 未消耗重试
    expect((await jobRow(reg.jobId))?.last_error).toContain('SETTLE_HOLD_RELEASE');

    const logs = await pool.query<{ result: string }>(
      `SELECT result FROM schedule.schedule_job_log WHERE job_id = $1`,
      [reg.jobId],
    );
    expect(logs.rows.map((r) => r.result)).toEqual(['NO_EXECUTOR']);
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ kind: 'JOB_FAILED', jobType: 'SETTLE_HOLD_RELEASE' });

    // FAILED 不复活
    expect(await svc.tick('normal')).toMatchObject({ done: 0, retried: 0, failed: 0 });
  });

  // 真并发时序用例 retry（M1-W4 T0 flaky 收敛）：下列 4 例依赖多连接/锁队列时序，系统高负载下
  // 偶发翻动（W1/W2 起多轮全量偶发、隔离复跑绿）；重跑经 beforeEach TRUNCATE 从干净态起，
  // 断言语义不变——SKIP LOCKED 恰一执行的守卫本身不受 retry 影响（若真回归则两轮皆红）。
  it(
    '抢占并发（§9）：两执行器（两服务实例同池）争同一到期 job 恰一执行',
    { retry: 2 },
    async () => {
      const reg = await svc.registerJob(pool, {
        jobType: 'REMIND_10MIN',
        refType: 'session',
        refId: 561,
        dueAt: new Date(Date.now() - 1_000),
      });
      // 第二个调度器实例（模拟多节点）：同池 + 同执行器注册表
      const svc2 = new SchedulerService(
        app.get(PgPoolService),
        app.get(OutboxService),
        app.get(StateTransitionGuardService),
        app.get(ScheduleExecutorRegistry),
        app.get(SchedulerAlertService),
      );
      const [a, b] = await Promise.all([svc.tick('normal'), svc2.tick('normal')]);
      expect(a.done + b.done).toBe(1); // 恰一执行（SKIP LOCKED 抢占）
      expect(remind.executeCalls).toBe(1);
      expect((await jobRow(reg.jobId))?.status).toBe('DONE');
      const logs = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM schedule.schedule_job_log WHERE job_id = $1`,
        [reg.jobId],
      );
      expect(logs.rows[0]?.n).toBe(1);
    },
  );

  it('开房优先级（§9/R-03）：priority 通道只扫 ROOM_OPEN；normal 通道不碰 ROOM_OPEN', async () => {
    const roomJob = await svc.registerJob(pool, {
      jobType: 'ROOM_OPEN',
      refType: 'room',
      refId: 571,
      dueAt: new Date(Date.now() - 1_000),
    });
    const remindJob = await svc.registerJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 572,
      dueAt: new Date(Date.now() - 1_000),
    });

    // 高优先级通道：只执行 ROOM_OPEN
    expect(await svc.tick('priority')).toMatchObject({ channel: 'priority', done: 1 });
    expect(room.executeCalls).toBe(1);
    expect((await jobRow(roomJob.jobId))?.status).toBe('DONE');
    expect((await jobRow(remindJob.jobId))?.status).toBe('PENDING');
    expect(remind.executeCalls).toBe(0);

    // 常规通道：执行其余类型
    expect(await svc.tick('normal')).toMatchObject({ done: 1 });
    expect((await jobRow(remindJob.jobId))?.status).toBe('DONE');

    // 常规通道永不执行 ROOM_OPEN
    const roomJob2 = await svc.registerJob(pool, {
      jobType: 'ROOM_OPEN',
      refType: 'room',
      refId: 573,
      dueAt: new Date(Date.now() - 1_000),
    });
    expect(await svc.tick('normal')).toMatchObject({ done: 0 });
    expect((await jobRow(roomJob2.jobId))?.status).toBe('PENDING');
    expect(room.executeCalls).toBe(1); // 仍是首笔
  });

  it('R-03 ROOM_OPEN 延迟 >30s 电话告警（§10 模拟积压）：超阈触发、未超阈不触发', async () => {
    // 积压模拟：due_at 已过去 45s
    const late = await svc.registerJob(pool, {
      jobType: 'ROOM_OPEN',
      refType: 'room',
      refId: 581,
      dueAt: new Date(Date.now() - 45_000),
    });
    expect(await svc.tick('priority')).toMatchObject({ done: 1 });
    const delayAlerts = sink.alerts.filter((a) => a.kind === 'ROOM_OPEN_DELAY');
    expect(delayAlerts).toHaveLength(1);
    expect(delayAlerts[0]).toMatchObject({ jobType: 'ROOM_OPEN', jobId: late.jobId });

    // 准点（1s 前到期）不告警
    await svc.registerJob(pool, {
      jobType: 'ROOM_OPEN',
      refType: 'room',
      refId: 582,
      dueAt: new Date(Date.now() - 1_000),
    });
    expect(await svc.tick('priority')).toMatchObject({ done: 1 });
    expect(sink.alerts.filter((a) => a.kind === 'ROOM_OPEN_DELAY')).toHaveLength(1);
  });

  it('积压监控判定（H4 联动前置）：>60s 逾期计数与最老逾期', async () => {
    await svc.registerJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 591,
      dueAt: new Date(Date.now() - 90_000), // 逾期 >60s
    });
    await svc.registerJob(pool, {
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 592,
      dueAt: new Date(Date.now() - 5_000), // 逾期 ≤60s，不计入
    });
    const stats = await svc.backlog();
    expect(stats.overdueJobs).toBe(1);
    expect(stats.oldestOverdueSeconds).not.toBeNull();
    expect(stats.oldestOverdueSeconds ?? 0).toBeGreaterThanOrEqual(60);
  });
});

/** 独立装配套件：backoff=0 使重试耗尽在测试内确定到达（不依赖真实时间轮询） */
describe('I2 重试退避与 FAILED 处置（独立装配 backoff=0，需 PG）', () => {
  let pool: Pool;
  let sink: MockPhoneAlertSink;
  // 模拟并发节点（空执行器注册表即可：仅用其 cancelJob 制造竞态窗口；stealPoolSvc 提供事务化持锁）
  let stealSvc: SchedulerService;
  let stealPoolSvc: PgPoolService;

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * 正向探测：并发方的行锁请求已入队未授予（pg_locks 出现未授予的 transactionid/tuple 锁）——
   * 保证抢占事务回滚后「并发方先于善后事务」这一竞态前提确定性成立，不靠盲等。
   */
  const waitForLockQueued = async (): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      const res = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks
          WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`,
      );
      if (Number(res.rows[0]?.n ?? 0) > 0) return;
      await delay(20);
    }
    throw new Error('并发方未按预期阻塞在行锁上（竞态前提不成立）');
  };

  interface Harness {
    svc: SchedulerService;
    stub: StubExecutor;
    registry: ScheduleExecutorRegistry;
  }

  const buildHarness = (
    executors: JobExecutor[] = [new StubExecutor('POINTS_EXPIRE')],
  ): Harness => {
    const poolSvc = new PgPoolService(pool);
    const registry = new ScheduleExecutorRegistry();
    for (const executor of executors) registry.register(executor);
    const alerts = new SchedulerAlertService(sink);
    const svc = new SchedulerService(
      poolSvc,
      new OutboxService(),
      new StateTransitionGuardService(new StateTransitionLogService(), poolSvc),
      registry,
      alerts,
      { backoffMs: () => 0 }, // 失败后立即可重拾取，退避语义本身由退避曲线单测覆盖
    );
    return { svc, stub: executors[0] as StubExecutor, registry };
  };

  const registerFailingJob = (svc: SchedulerService, refId: number) =>
    svc.registerJob(pool, {
      jobType: 'POINTS_EXPIRE',
      refType: 'points',
      refId,
      dueAt: new Date(Date.now() - 1_000),
    });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    // 模拟并发节点（空执行器注册表即可：仅用其 cancelJob 制造竞态窗口）
    stealPoolSvc = new PgPoolService(pool);
    stealSvc = new SchedulerService(
      stealPoolSvc,
      new OutboxService(),
      new StateTransitionGuardService(new StateTransitionLogService(), new PgPoolService(pool)),
      new ScheduleExecutorRegistry(),
      new SchedulerAlertService(new MockPhoneAlertSink()),
    );
    await stealSvc.listJobs({ limit: 1 }); // 预热并发节点连接池（竞态窗口内只余查询派发延迟）
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    sink = new MockPhoneAlertSink();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('重试退避（§9）：失败 RETRY 再排程、retry_count 递增；3 次耗尽 → FAILED+告警+不复活', async () => {
    const { svc, stub } = buildHarness();
    stub.failTimesRemaining = 99;
    const reg = await registerFailingJob(svc, 601);

    expect(await svc.tick('normal')).toMatchObject({ retried: 1 });
    expect(await svc.tick('normal')).toMatchObject({ retried: 1 });
    expect(await svc.tick('normal')).toMatchObject({ retried: 1 });
    const mid = await pool.query<{ status: string; retry_count: number; next_retry_at: Date }>(
      `SELECT status, retry_count, next_retry_at FROM schedule.schedule_jobs WHERE id = $1`,
      [reg.jobId],
    );
    expect(mid.rows[0]).toMatchObject({ status: 'PENDING', retry_count: 3 }); // 未耗尽仍待拾取
    const retryLogs = await pool.query<{ result: string }>(
      `SELECT result FROM schedule.schedule_job_log WHERE job_id = $1 ORDER BY id`,
      [reg.jobId],
    );
    expect(retryLogs.rows.map((r) => r.result)).toEqual(['RETRY', 'RETRY', 'RETRY']);

    expect(await svc.tick('normal')).toMatchObject({ failed: 1 }); // 第 4 次失败：3 次重试耗尽
    expect(stub.executeCalls).toBe(4); // 1 次初始 + 3 次重试
    const row = await pool.query<{
      status: string;
      retry_count: number;
      last_error: string | null;
      fired_at: Date | null;
    }>(
      `SELECT status, retry_count, last_error, fired_at FROM schedule.schedule_jobs WHERE id = $1`,
      [reg.jobId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'FAILED', retry_count: 3 });
    expect(row.rows[0]?.last_error).toContain('stub 执行失败');
    expect(row.rows[0]?.fired_at).not.toBeNull();
    expect(await svc.tick('normal')).toMatchObject({ done: 0, retried: 0, failed: 0 }); // FAILED 不复活

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ kind: 'JOB_FAILED', jobType: 'POINTS_EXPIRE' });
    const failLogs = await pool.query<{ result: string; detail: string | null }>(
      `SELECT result, detail FROM schedule.schedule_job_log WHERE job_id = $1 ORDER BY id`,
      [reg.jobId],
    );
    expect(failLogs.rows.map((r) => r.result)).toEqual(['RETRY', 'RETRY', 'RETRY', 'FAILED']);
    expect(failLogs.rows[3]?.detail).toContain('stub 执行失败');
  });

  it('FAILED 告警收敛：同类型 5min 内去重一笔，不同类型独立告警', async () => {
    const { svc, stub, registry } = buildHarness();
    const second = new StubExecutor('SETTLE_HOLD_RELEASE');
    second.failTimesRemaining = 99;
    registry.register(second);

    stub.failTimesRemaining = 99;
    const job1 = await registerFailingJob(svc, 611);
    for (let i = 0; i < 4; i += 1) await svc.tick('normal');
    const job2 = await registerFailingJob(svc, 612); // 同类型第二笔
    for (let i = 0; i < 4; i += 1) await svc.tick('normal');
    expect((await jobRowStatus(pool, job1.jobId)) === 'FAILED').toBe(true);
    expect((await jobRowStatus(pool, job2.jobId)) === 'FAILED').toBe(true);

    const job3 = await svc.registerJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: 613,
      dueAt: new Date(Date.now() - 1_000),
    });
    for (let i = 0; i < 4; i += 1) await svc.tick('normal');
    expect((await jobRowStatus(pool, job3.jobId)) === 'FAILED').toBe(true);

    const failedAlerts = sink.alerts.filter((a) => a.kind === 'JOB_FAILED');
    expect(failedAlerts).toHaveLength(2); // POINTS_EXPIRE 去重一笔 + SETTLE_HOLD_RELEASE 一笔
    expect(failedAlerts.map((a) => a.jobType)).toEqual(['POINTS_EXPIRE', 'SETTLE_HOLD_RELEASE']);
  }, 30_000);

  it('log 重放（§10/R-04）：FAILED 经同 job_id 重新入队 → 成功 DONE；全历史 log 可追溯', async () => {
    const { svc, stub } = buildHarness();
    stub.failTimesRemaining = 99;
    const reg = await registerFailingJob(svc, 621);
    for (let i = 0; i < 4; i += 1) await svc.tick('normal');
    expect((await jobRowStatus(pool, reg.jobId)) === 'FAILED').toBe(true);

    // 运维重放：同 job_id 重新入队（幂等回查兜底安全）
    expect(await svc.replayJob(reg.jobId)).toMatchObject({ replayed: true });
    const row = await pool.query<{
      status: string;
      retry_count: number;
      last_error: string | null;
    }>(`SELECT status, retry_count, last_error FROM schedule.schedule_jobs WHERE id = $1`, [
      reg.jobId,
    ]);
    expect(row.rows[0]).toMatchObject({ status: 'PENDING', retry_count: 0, last_error: null });

    stub.failTimesRemaining = 0; // 修复后重放成功
    expect(await svc.tick('normal')).toMatchObject({ done: 1 });
    expect((await jobRowStatus(pool, reg.jobId)) === 'DONE').toBe(true);

    // 全历史：RETRY×3 + FAILED + DONE 同 job_id 可完整回放
    const history = await pool.query<{ result: string }>(
      `SELECT result FROM schedule.schedule_job_log WHERE job_id = $1 ORDER BY id`,
      [reg.jobId],
    );
    expect(history.rows.map((r) => r.result)).toEqual([
      'RETRY',
      'RETRY',
      'RETRY',
      'FAILED',
      'DONE',
    ]);

    // 非 FAILED job 不可重放；未知 id 同样拒绝
    expect(await svc.replayJob(reg.jobId)).toMatchObject({ replayed: false });
    expect(await svc.replayJob(987_654_321)).toMatchObject({ replayed: false });
  });

  it(
    '竞态（Important-1）：善后前 job 已被并发作废 → 不写 RETRY log、不计数、无告警',
    { retry: 2 },
    async () => {
      const blocker = new BlockedFailExecutor('POINTS_EXPIRE');
      const { svc } = buildHarness([blocker]);
      const reg = await registerFailingJob(svc, 631);

      const tickPromise = svc.tick('normal');
      await blocker.started; // 抢占事务持锁中，执行器挂起
      // 并发节点在善后前推进该 job：cancelJob 的 SELECT … FOR UPDATE 排队于抢占事务之后（同事务持锁
      // 到 COMMIT），抢占事务回滚后必先于善后事务生效（pg_locks 正向等待探测保证排队到位）
      const steal = stealPoolSvc.withTransaction((uow) =>
        stealSvc.cancelJob(uow, { jobType: 'POINTS_EXPIRE', refType: 'points', refId: 631 }),
      );
      await waitForLockQueued();
      blocker.fail(); // 执行器抛错 → 抢占事务回滚 → steal 获锁生效（CANCELLED）
      const [tick] = await Promise.all([tickPromise, steal]);

      // 善后放弃：不计数（旧实现 retried=1）
      expect(tick).toMatchObject({ done: 0, cancelled: 0, retried: 0, failed: 0 });
      // 不写虚构 RETRY 行（R-04 log 是法证事实源，只记真实发生的重试；旧实现会塞 1 条）
      const logs = await pool.query<{ result: string }>(
        `SELECT result FROM schedule.schedule_job_log WHERE job_id = $1`,
        [reg.jobId],
      );
      expect(logs.rows.map((r) => r.result)).toEqual([]);
      expect(await jobRowStatus(pool, reg.jobId)).toBe('CANCELLED');
      expect(sink.alerts).toHaveLength(0);
    },
  );

  it(
    '竞态（Important-1）：善后前已被并发推进且重试耗尽 → FAILED 迁移不打 StateStale、同轮告警不丢',
    { retry: 2 },
    async () => {
      const blocker = new BlockedFailExecutor('POINTS_EXPIRE');
      const prior = new StubExecutor('REMIND_1H');
      prior.failTimesRemaining = 99;
      const { svc } = buildHarness([prior, blocker]);
      // 同轮两笔均已到耗尽线（retry_count=3 fixture，不同类型各配执行器）：先到期的 prior 常规失败
      // → FAILED+告警入队；后到期的 poisoned 走阻塞失败制造善后竞态窗口
      const priorJob = await svc.registerJob(pool, {
        jobType: 'REMIND_1H',
        refType: 'session',
        refId: 642,
        dueAt: new Date(Date.now() - 2_000),
      });
      const poisoned = await registerFailingJob(svc, 643);
      await pool.query(
        `UPDATE schedule.schedule_jobs SET retry_count = 3 WHERE id = ANY($1::bigint[])`,
        [[priorJob.jobId, poisoned.jobId]],
      );

      const tickPromise = svc.tick('normal');
      await blocker.started; // 第二轮抢占 poisoned 持锁中，执行器挂起
      const steal = stealPoolSvc.withTransaction((uow) =>
        stealSvc.cancelJob(uow, { jobType: 'POINTS_EXPIRE', refType: 'points', refId: 643 }),
      );
      await waitForLockQueued();
      blocker.fail();
      const [tick] = await Promise.all([tickPromise, steal]);

      // prior 正常 FAILED 计数；poisoned 善后放弃不计数（旧实现：StateStaleEntity 炸出整轮 tick，本断言前已 reject）
      expect(tick).toMatchObject({ done: 0, cancelled: 0, retried: 0, failed: 1 });
      // 同轮更早积攒的 prior FAILED 告警不因善后异常丢失
      expect(sink.alerts.some((a) => a.kind === 'JOB_FAILED' && a.jobId === priorJob.jobId)).toBe(
        true,
      );
      // 无虚构 FAILED log、无重复告警，poisoned 保持并发方写入的 CANCELLED
      const logs = await pool.query<{ result: string }>(
        `SELECT result FROM schedule.schedule_job_log WHERE job_id = $1 ORDER BY id`,
        [poisoned.jobId],
      );
      expect(logs.rows.map((r) => r.result)).toEqual([]);
      expect(await jobRowStatus(pool, poisoned.jobId)).toBe('CANCELLED');
      expect(sink.alerts).toHaveLength(1);
    },
  );
});

/** §10 压测：双执行器并发抢占 100 job 无重复 */
describe('I2 双执行器 100 job 压测（需 PG）', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it(
    '100 job 双服务并发 tick：恰 100 次执行、无重复执行、每 job 恰一 DONE 日志',
    { retry: 2, timeout: 60_000 },
    async () => {
      const poolSvc = new PgPoolService(pool);
      const build = (stub: StubExecutor): SchedulerService => {
        const registry = new ScheduleExecutorRegistry();
        registry.register(stub);
        return new SchedulerService(
          poolSvc,
          new OutboxService(),
          new StateTransitionGuardService(new StateTransitionLogService(), poolSvc),
          registry,
          new SchedulerAlertService(new MockPhoneAlertSink()),
        );
      };
      const stubA = new StubExecutor('REMIND_1H');
      const stubB = new StubExecutor('REMIND_1H');
      const svcA = build(stubA);
      const svcB = build(stubB);

      // 一个业务事务内批量注册 100 个到期 job
      await poolSvc.withTransaction(async (uow) => {
        for (let refId = 1; refId <= 100; refId += 1) {
          await svcA.registerJob(uow, {
            jobType: 'REMIND_1H',
            refType: 'stress',
            refId,
            dueAt: new Date(Date.now() - 1_000),
          });
        }
      });

      const [a, b] = await Promise.all([svcA.tick('normal', 100), svcB.tick('normal', 100)]);
      expect(a.done + b.done).toBe(100);
      expect(stubA.executeCalls + stubB.executeCalls).toBe(100);
      expect(stubA.executedRefs.length + stubB.executedRefs.length).toBe(100);
      expect(new Set([...stubA.executedRefs, ...stubB.executedRefs]).size).toBe(100); // 无重复 ref

      const doneRows = await pool.query<{ n: number; distinct: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT job_id)::int AS distinct
         FROM schedule.schedule_job_log WHERE result = 'DONE'`,
      );
      expect(doneRows.rows[0]).toMatchObject({ n: 100, distinct: 100 });
      const statuses = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM schedule.schedule_jobs WHERE status = 'DONE'`,
      );
      expect(statuses.rows[0]?.n).toBe(100);
    },
  );
});

/** 辅助：读 job 终态 */
async function jobRowStatus(pool: Pool, jobId: number): Promise<string | null> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM schedule.schedule_jobs WHERE id = $1`,
    [jobId],
  );
  return res.rows[0]?.status ?? null;
}
