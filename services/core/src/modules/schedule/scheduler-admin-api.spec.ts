import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { SchedulerService } from './scheduler.service';
import { SchedulerModule } from './scheduler.module';

/**
 * I2 REST 契约（§5）：GET /admin/scheduler/jobs?status=&type= 运维视图。
 * W3 T10 G-A 同批接线：⚠决策位占位兑现——运维视图属 admin 面，挂 @RequireRole('admin')
 * （未认证 401 / 未持 admin 旗标 403）；过滤语义用例改持 admin 夹具发起。
 */
describe('I2 REST 契约 GET /admin/scheduler/jobs（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: SchedulerService;
  let adminToken: string;
  let userToken: string;

  const adminGet = (url: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${adminToken}`);

  const register = (refId: number, jobType: 'REMIND_10MIN' | 'ROOM_OPEN', dueOffsetMs: number) =>
    svc.registerJob(pool, {
      jobType,
      refType: jobType === 'ROOM_OPEN' ? 'room' : 'session',
      refId,
      dueAt: new Date(Date.now() + dueOffsetMs),
    });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const jwtSecret = randomBytes(32).toString('hex');
    const identityConfig: IdentityConfig = {
      phoneDataKey: randomBytes(32),
      phoneBlindPepper: randomBytes(32).toString('hex'),
      jwtSecret,
    };
    const moduleRef = await Test.createTestingModule({ imports: [SchedulerModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(identityConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(SchedulerService);
    const jwt = new JwtService({ secret: jwtSecret });
    adminToken = await jwt.signAsync({ sub: '990005', role: 'user', roles: ['user', 'admin'] });
    userToken = await jwt.signAsync({ sub: '990006', role: 'user', roles: ['user'] });
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

    const res = await adminGet('/admin/scheduler/jobs');
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

    const res = await adminGet('/admin/scheduler/jobs?status=CANCELLED');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: a.jobId, status: 'CANCELLED' });
  });

  it('?type= 过滤：只回指定类型；status+type 组合过滤', async () => {
    await register(721, 'ROOM_OPEN', -3_000);
    await register(722, 'REMIND_10MIN', -2_000);

    const byType = await adminGet('/admin/scheduler/jobs?type=ROOM_OPEN');
    expect(byType.status).toBe(200);
    expect(byType.body).toHaveLength(1);
    expect(byType.body[0]).toMatchObject({ jobType: 'ROOM_OPEN', refId: 721 });

    const combo = await adminGet('/admin/scheduler/jobs?status=PENDING&type=REMIND_10MIN');
    expect(combo.status).toBe(200);
    expect(combo.body).toHaveLength(1);
    expect(combo.body[0]).toMatchObject({ jobType: 'REMIND_10MIN', refId: 722 });
  });

  it('?limit= 截断；非法 status/type/limit → 400 E_INVALID_ARGUMENT', async () => {
    await register(731, 'REMIND_10MIN', -3_000);
    await register(732, 'REMIND_10MIN', -2_000);

    const limited = await adminGet('/admin/scheduler/jobs?limit=1');
    expect(limited.status).toBe(200);
    expect(limited.body).toHaveLength(1);

    const badStatus = await adminGet('/admin/scheduler/jobs?status=FOO');
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe('E_INVALID_ARGUMENT');

    const badType = await adminGet('/admin/scheduler/jobs?type=NOT_A_JOB');
    expect(badType.status).toBe(400);
    expect(badType.body.code).toBe('E_INVALID_ARGUMENT');

    const badLimit = await adminGet('/admin/scheduler/jobs?limit=abc');
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.code).toBe('E_INVALID_ARGUMENT');
  });

  it('G-A 同批接线：未认证 401 / 未持 admin 旗标 403 / admin 200', async () => {
    const anon = await request(app.getHttpServer()).get('/admin/scheduler/jobs');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('E_UNAUTHORIZED');

    const asUser = await request(app.getHttpServer())
      .get('/admin/scheduler/jobs')
      .set('Authorization', `Bearer ${userToken}`);
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe('E_ROLE_FORBIDDEN');

    const ok = await adminGet('/admin/scheduler/jobs');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([]);
  });
});
