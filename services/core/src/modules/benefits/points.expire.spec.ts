import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { POINTS_EXPIRED_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SchedulerService } from '../schedule/scheduler.service';
import { PointsJobExecutors } from './points.executors';
import { BenefitsModule } from './points.module';

/**
 * F4 ①切片 POINTS_EXPIRE job 执行器 e2e（需 PG）：I2 目录在册执行器名（scheduler.catalog：
 * producer=F4 / executor=F4 周期 job / recheckAnchor=points_txns.expires_at）由本模块注册——
 * B2 SLOT_REAPER 先例形态：recheck 恒真（周期兜底无业务先行语义）+ 执行前独立事务自投下一日
 * （每日 03:00 Asia/Shanghai，refType=daily/refId=上海日 yyyymmdd；注册与扫描成败解耦）+
 * expireAll 全量扫。R-02 惰性路径之外的第二条过期路径（物化扣减唯一落点）。
 * frozen 截断语义与 expireUser 共内核，service spec 用例覆盖。
 */
const USER = 601;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('F4 ①切片 POINTS_EXPIRE 执行器（I2 registry 注册 + 自投下一日 + 全量扫，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let scheduler: SchedulerService;
  let registry: ScheduleExecutorRegistry;
  let executors: PointsJobExecutors;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [BenefitsModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    scheduler = app.get(SchedulerService);
    registry = app.get(ScheduleExecutorRegistry);
    executors = app.get(PointsJobExecutors);
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

  /** 夹具：过期授予行 + 账户余额（直插本 schema 表，expires 用 SQL 表达式锚定 DB 时钟） */
  const seedExpired = async (userId: number, delta: number): Promise<void> => {
    const db = app.get(PgPoolService);
    await db.query(
      `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref, expires_at)
       VALUES ($1, $2, 'COMPENSATION', $3, now() - interval '1 day')`,
      [userId, delta, `fixture:${userId}:${delta}`],
    );
    await db.query(
      `INSERT INTO benefits.points_accounts (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = benefits.points_accounts.balance + $2`,
      [userId, delta],
    );
  };

  it('执行器注册进 I2 registry（目录名 POINTS_EXPIRE）；ensureDailyJobScheduled 幂等（同键去重）', async () => {
    expect(registry.has('POINTS_EXPIRE')).toBe(true);

    const first = await executors.ensureDailyJobScheduled();
    expect(first.registered).toBe(true);
    const second = await executors.ensureDailyJobScheduled();
    expect(second.registered).toBe(false);
    expect(second.jobId).toBe(first.jobId);

    // 断言经 I2 运维视图查询面（跨 schema 禁直查 schedule 表——schema-refs 红线）
    const pending = await scheduler.listJobs({ status: 'PENDING', jobType: 'POINTS_EXPIRE' });
    expect(pending).toHaveLength(1);
  });

  it('到期 job → tick 执行：全量扫扣减 + PointsExpired 出箱 + 自投下一日 03:00（上海）job；再 tick 空转', async () => {
    await seedExpired(USER, 100);
    const due = await scheduler.registerJob(pool, {
      jobType: 'POINTS_EXPIRE',
      refType: 'daily',
      refId: 20_261_016,
      dueAt: new Date(Date.now() - 1000),
    });
    expect(due.deduplicated).toBe(false);

    const tick = await scheduler.tick('normal');
    expect(tick.done).toBe(1);

    const expired = await pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id',
      [POINTS_EXPIRED_TOPIC],
    );
    expect(expired.rows).toHaveLength(1);
    expect(expired.rows[0]!.payload).toMatchObject({ user_id: USER, delta: -100, kind: 'EXPIRE' });

    const account = await pool.query<{ balance: number }>(
      'SELECT balance FROM benefits.points_accounts WHERE user_id = $1',
      [USER],
    );
    expect(account.rows[0]?.balance).toBe(0);

    // 自投下一日：恰一条 PENDING（经 I2 运维视图查询面断言——跨 schema 禁直查 schedule 表），
    // dueAt=上海 03:00 整、refId=上海日 yyyymmdd
    const next = await scheduler.listJobs({ status: 'PENDING', jobType: 'POINTS_EXPIRE' });
    expect(next).toHaveLength(1);
    const row = next[0]!;
    expect(row.refType).toBe('daily');
    expect(row.refId).toBeGreaterThan(20_261_016);
    const shanghai = new Date(row.dueAt.getTime() + 8 * 3_600_000);
    expect(shanghai.getUTCHours()).toBe(3);
    expect(shanghai.getUTCMinutes()).toBe(0);

    // 再 tick：无到期 job → 空转（自投行 dueAt 未来）
    const idle = await scheduler.tick('normal');
    expect(idle.done).toBe(0);
  });
});
