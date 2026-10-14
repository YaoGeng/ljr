import 'reflect-metadata';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { SchedulerService } from './scheduler.service';
import { SchedulerModule } from './scheduler.module';

/**
 * I2 REST 契约（§5）：GET /admin/scheduler/jobs?status=&type= 运维视图。
 * 后台鉴权 ⚠决策位：admin 角色鉴权随 H1/H2（W2+）接入后替换，本批次只验证接口形态与过滤语义。
 */
describe('I2 REST 契约 GET /admin/scheduler/jobs（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: SchedulerService;

  const register = (refId: number, jobType: 'REMIND_10MIN' | 'ROOM_OPEN', dueOffsetMs: number) =>
    svc.registerJob(pool, {
      jobType,
      refType: jobType === 'ROOM_OPEN' ? 'room' : 'session',
      refId,
      dueAt: new Date(Date.now() + dueOffsetMs),
    });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [SchedulerModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(SchedulerService);
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

  it('列出全部 job（due_at 升序），视图字段齐全', async () => {
    await register(701, 'REMIND_10MIN', -3_000);
    await register(702, 'ROOM_OPEN', -1_000);

    const res = await request(app.getHttpServer()).get('/admin/scheduler/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      jobType: 'REMIND_10MIN',
      refType: 'session',
      refId: 701,
      status: 'PENDING',
      version: 1,
      retryCount: 0,
    });
    expect(res.body[0]?.dueAt).toBeTruthy();
    expect(res.body[0]?.id).toBeLessThan(res.body[1]?.id ?? 0);
  });

  it('?status= 过滤：作废后只回 CANCELLED', async () => {
    const a = await register(711, 'REMIND_10MIN', -3_000);
    await register(712, 'REMIND_10MIN', -2_000);
    await svc.cancelJob(pool, { jobType: 'REMIND_10MIN', refType: 'session', refId: 711 });

    const res = await request(app.getHttpServer()).get('/admin/scheduler/jobs?status=CANCELLED');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: a.jobId, status: 'CANCELLED' });
  });

  it('?type= 过滤：只回指定类型；status+type 组合过滤', async () => {
    await register(721, 'ROOM_OPEN', -3_000);
    await register(722, 'REMIND_10MIN', -2_000);

    const byType = await request(app.getHttpServer()).get('/admin/scheduler/jobs?type=ROOM_OPEN');
    expect(byType.status).toBe(200);
    expect(byType.body).toHaveLength(1);
    expect(byType.body[0]).toMatchObject({ jobType: 'ROOM_OPEN', refId: 721 });

    const combo = await request(app.getHttpServer()).get(
      '/admin/scheduler/jobs?status=PENDING&type=REMIND_10MIN',
    );
    expect(combo.status).toBe(200);
    expect(combo.body).toHaveLength(1);
    expect(combo.body[0]).toMatchObject({ jobType: 'REMIND_10MIN', refId: 722 });
  });

  it('?limit= 截断；非法 status/type/limit → 400 E_INVALID_ARGUMENT', async () => {
    await register(731, 'REMIND_10MIN', -3_000);
    await register(732, 'REMIND_10MIN', -2_000);

    const limited = await request(app.getHttpServer()).get('/admin/scheduler/jobs?limit=1');
    expect(limited.status).toBe(200);
    expect(limited.body).toHaveLength(1);

    const badStatus = await request(app.getHttpServer()).get('/admin/scheduler/jobs?status=FOO');
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe('E_INVALID_ARGUMENT');

    const badType = await request(app.getHttpServer()).get('/admin/scheduler/jobs?type=NOT_A_JOB');
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe('E_INVALID_ARGUMENT');

    const badLimit = await request(app.getHttpServer()).get('/admin/scheduler/jobs?limit=abc');
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.code).toBe('E_INVALID_ARGUMENT');
  });
});
