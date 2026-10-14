import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { TRACE_LOGGER } from '../../observability/observability.module';
import type { TraceLogger } from '../../observability/trace-logger';
import { RuleCenterService } from '../ops/rule-center.service';
import { RuleCenterModule } from '../ops/rule-center.module';
import { SchedulerService } from './scheduler.service';

/**
 * RULE_EFFECTIVE 生效 job 的 job-log 痕迹断言（评审修复 Important-2，控制者 R12）：
 * 「窗口未到」（双钟漂移/伪造提前到期）不再与「被取代」（recheck=false → CANCELLED）混同——
 * 前者走执行路径 DONE + detail.outcome='window_not_due'（H4/运维可查询），后者保持 CANCELLED。
 *
 * 放置说明（check-schema-refs 规则 A）：schedule_job_log 归 schedule 域，断言 detail 必须直查
 * 该表——本文件落 modules/schedule/（owner=schedule）作为 I2×H7 缝合测试；规则行状态经 H7
 * 服务 API 断言（不直写他域表，跨界 SQL 只出现本 owner 表）。
 */

const MIN = 60_000;

describe('RULE_EFFECTIVE job-log 痕迹（Important-2，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let rules: RuleCenterService;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let loggerWarn: ReturnType<typeof vi.fn>;

  const lastLogOf = async (refId: number) => {
    const res = await pool.query<{ result: string; detail: string | null }>(
      `SELECT l.result, l.detail FROM schedule.schedule_job_log l
        JOIN schedule.schedule_jobs j ON j.id = l.job_id
        WHERE j.job_type = 'RULE_EFFECTIVE' AND j.ref_id = $1
        ORDER BY l.id DESC LIMIT 1`,
      [refId],
    );
    return res.rows[0];
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    loggerWarn = vi.fn();
    const moduleRef = await Test.createTestingModule({ imports: [RuleCenterModule] })
      .overrideProvider(TRACE_LOGGER)
      .useValue({
        debug: vi.fn(),
        info: vi.fn(),
        warn: loggerWarn,
        error: vi.fn(),
      } as unknown as TraceLogger)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    rules = app.get(RuleCenterService);
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    loggerWarn.mockClear();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  /** 提交公示后换 job：取消原在册（due=+7d+缓冲）并伪造提前到期（漂移注入位，守卫口径作废） */
  const forgeEarlyJob = async (ruleId: number): Promise<void> => {
    const pending = await scheduler.listJobs({ jobType: 'RULE_EFFECTIVE', status: 'PENDING' });
    expect(pending).toHaveLength(1);
    await poolSvc.withTransaction(async (uow) => {
      await scheduler.cancelJob(uow, {
        jobType: 'RULE_EFFECTIVE',
        refType: 'rule_definition',
        refId: ruleId,
      });
      await scheduler.registerJob(uow, {
        jobType: 'RULE_EFFECTIVE',
        refType: 'rule_definition',
        refId: ruleId,
        dueAt: new Date(Date.now() - MIN),
      });
    });
  };

  it('窗口未到（提前到期）：job DONE + detail.outcome=window_not_due + logger.warn；规则保持 PUBLISHED', async () => {
    await rules.createDraft({ ruleKey: 'credit.rules', version: 1, content: { max: 5 } });
    await rules.submitForPublication('credit.rules', 1, { now: new Date() }); // effective_at=+7d
    const pending = await scheduler.listJobs({ jobType: 'RULE_EFFECTIVE', status: 'PENDING' });
    const ruleId = pending[0]?.refId as number;
    await forgeEarlyJob(ruleId);

    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ done: 1, cancelled: 0 });

    const log = await lastLogOf(ruleId);
    expect(log?.result).toBe('DONE');
    expect(JSON.parse(log?.detail ?? '{}')).toEqual({
      rule_id: ruleId,
      transitioned: false,
      outcome: 'window_not_due',
    });
    // 规则未生效（现行版不命中）；warn 留痕（TRACE_LOGGER stub 捕获）
    expect(await rules.snapshotAt('credit.rules', new Date())).toBeNull();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[1]).toMatchObject({
      rule_id: ruleId,
      outcome: 'window_not_due',
    });
  });

  it('对照·被取代（DRAFT 行误触发）：recheck=false → CANCELLED + detail 为空（与窗口未到明确区分）', async () => {
    const draft = await rules.createDraft({
      ruleKey: 'disclaimer.rules',
      version: 1,
      content: { t: 1 },
    });
    await poolSvc.withTransaction(async (uow) => {
      await scheduler.registerJob(uow, {
        jobType: 'RULE_EFFECTIVE',
        refType: 'rule_definition',
        refId: draft.id,
        dueAt: new Date(Date.now() - MIN),
      });
    });

    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ cancelled: 1, done: 0 });

    const log = await lastLogOf(draft.id);
    expect(log?.result).toBe('CANCELLED');
    expect(log?.detail).toBeNull();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('对照·正常生效（公示期满）：DONE + detail.transitioned=true 且无 outcome 字段', async () => {
    await rules.createDraft({ ruleKey: 'cancellation.rules', version: 1, content: { free: 1 } });
    await rules.submitForPublication('cancellation.rules', 1, {
      now: new Date(Date.now() - 8 * 86_400_000),
    });
    const pending = await scheduler.listJobs({ jobType: 'RULE_EFFECTIVE', status: 'PENDING' });
    const ruleId = pending[0]?.refId as number;

    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ done: 1 });

    const log = await lastLogOf(ruleId);
    expect(log?.result).toBe('DONE');
    expect(JSON.parse(log?.detail ?? '{}')).toEqual({ rule_id: ruleId, transitioned: true });
    expect(await rules.snapshotAt('cancellation.rules', new Date())).toMatchObject({ version: 1 });
    expect(loggerWarn).not.toHaveBeenCalled();
  });
});
