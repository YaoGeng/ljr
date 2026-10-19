import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { IdentityTokenService } from '../identity/identity.token.service';
import { grantUserRoles, seedUserShell } from '../identity/lawyer-fixture';
import { MetricsModule } from './metrics.module';

/**
 * H4 指标查询面 REST 契约（§5 GET /admin/dashboard/metrics?group=core|health&from=&to=）：
 * 鉴权三态（G-A 前置门，lawyer-admin 同款：未认证 401 / 未持 admin 旗标 403 E_ROLE_FORBIDDEN）；
 * group 必填值域校验 400；from/to 成对+YYYY-MM-DD；响应形状（group/from/to/metrics[{key,value,stub}]）。
 * 指标数值口径的服务级锁定=metrics.spec（本面只锁 HTTP 契约与穿透）。
 */

function testIdentityConfig(): IdentityConfig {
  return {
    phoneDataKey: randomBytes(32),
    phoneBlindPepper: randomBytes(32).toString('hex'),
    jwtSecret: randomBytes(32).toString('hex'),
  };
}

describe('H4 数据看板查询面（GET /admin/dashboard/metrics，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [MetricsModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const tokens = app.get(IdentityTokenService);

    const adminUserId = await seedUserShell(pool, 'h4-admin');
    await grantUserRoles(pool, adminUserId, ['user', 'admin']);
    adminToken = await tokens.signAccessToken({
      userId: adminUserId,
      role: 'user',
      roles: ['user', 'admin'],
    });
    const plainUserId = await seedUserShell(pool, 'h4-user');
    await grantUserRoles(pool, plainUserId, ['user']);
    userToken = await tokens.signAccessToken({
      userId: plainUserId,
      role: 'user',
      roles: ['user'],
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  it('鉴权三态：401 未认证 / 403 未持 admin / admin 200', async () => {
    const anon = await request(app.getHttpServer()).get('/admin/dashboard/metrics?group=core');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const forbidden = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=core')
      .set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe(ErrorCode.RoleForbidden);

    const ok = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=core')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.group).toBe('core');
    expect(Array.isArray(ok.body.metrics)).toBe(true);
    expect(ok.body.from).toBeNull(); // 缺省全量（窗口未给出）
    expect(ok.body.to).toBeNull();
  });

  it('group 过滤：core/health 键集互斥；group 必填+值域 400', async () => {
    const core = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=core')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(core.status).toBe(200);
    const coreKeys = (core.body.metrics as { key: string }[]).map((m) => m.key);
    expect(coreKeys).toContain('group_buy_rate_b2c');
    expect(coreKeys).not.toContain('dispute_rate');

    const health = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=health')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(health.status).toBe(200);
    const healthKeys = (health.body.metrics as { key: string }[]).map((m) => m.key);
    expect(healthKeys).toContain('dispute_rate');
    expect(healthKeys).not.toContain('group_buy_rate_b2c');

    const missing = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(ErrorCode.InvalidArgument);

    const bad = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=all')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(ErrorCode.InvalidArgument);
  });

  it('窗口参数：from/to 成对 YYYY-MM-DD（回显）；单边/坏形态/from>to 400', async () => {
    const ok = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=core&from=2026-10-01&to=2026-10-18')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.from).toBe('2026-10-01');
    expect(ok.body.to).toBe('2026-10-18');

    const half = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=core&from=2026-10-01')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(half.status).toBe(400);

    const badForm = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=core&from=2026/10/01&to=2026-10-18')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(badForm.status).toBe(400);

    const inverted = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=core&from=2026-10-18&to=2026-10-01')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(inverted.status).toBe(400);
  });

  it('响应条目形状：{key, value:number|null, stub:string|null}；桩位显式（价格稳定性指数不出现）', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/dashboard/metrics?group=health')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const metrics = res.body.metrics as {
      key: string;
      value: number | null;
      stub: string | null;
    }[];
    expect(metrics.length).toBeGreaterThan(0);
    for (const m of metrics) {
      expect(typeof m.key).toBe('string');
      expect(m.value === null || typeof m.value === 'number').toBe(true);
      expect(m.stub === null || typeof m.stub === 'string').toBe(true);
    }
    expect(metrics.map((m) => m.key)).not.toContain('price_stability_index'); // 占位不展示（04 §8 #8）
    const retention = metrics.find((m) => m.key === 'lawyer_retention_rate')!;
    expect(retention.value).toBeNull();
    expect(retention.stub).toBeTruthy();
  });
});
