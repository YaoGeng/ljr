import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import type { UserRole } from '../identity/identity.machine';
import { IdentityModule } from '../identity/identity.module';
import { IdentityTokenService } from '../identity/identity.token.service';
import { NotifyDispatcherService } from './notify-dispatcher.service';
import { NotifyModule } from './notify.module';
import { NotifyPrefsService } from './notify-prefs.service';

/**
 * I1 REST 契约（§5）：GET /notifications/mine、GET/PUT /notification-prefs。
 * 身份接线（W2 交接 4-B，A1 落地）：user_id 由 JWT claims 注入——请求带 Bearer access_token
 * （IdentityAuthGuard 校验+提取），R-03 角色校验拒 lawyer 激活角色（403，越权全量用例见
 * identity-api.spec）。token 经 IdentityTokenService 直签（A1 认证流用例在 identity-api.spec，
 * 此处聚焦 I1 契约面）；测试密钥随机派生（零字面量）。
 */
describe('I1 REST 契约（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let dispatcher: NotifyDispatcherService;
  let prefs: NotifyPrefsService;
  let tokens: IdentityTokenService;

  /** 直签 access（claims 口径与 A1 签发一致） */
  async function accessToken(userId: number, role: UserRole = 'user'): Promise<string> {
    const roles: UserRole[] = role === 'lawyer' ? ['user', 'lawyer'] : ['user'];
    return tokens.signAccessToken({ userId, role, roles });
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [IdentityModule, NotifyModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue({
        phoneDataKey: randomBytes(32),
        phoneBlindPepper: randomBytes(32).toString('hex'),
        jwtSecret: randomBytes(32).toString('hex'),
      } satisfies IdentityConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dispatcher = app.get(NotifyDispatcherService);
    prefs = app.get(NotifyPrefsService);
    tokens = app.get(IdentityTokenService);
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
    await pool.query(`DELETE FROM notify.notification_templates WHERE code LIKE 'TEST_%'`);
  });

  it('PUT /notification-prefs → GET 回读一致（Bearer claims 注入 user_id）', async () => {
    const token = await accessToken(301);
    const put = await request(app.getHttpServer())
      .put('/notification-prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ prefs: [{ template_code: 'PRICE_UP_LOCKED', enabled: false }] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual([
      { templateCode: 'PRICE_UP_LOCKED', enabled: false, updatedAt: expect.any(String) },
    ]);

    const get = await request(app.getHttpServer())
      .get('/notification-prefs')
      .set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0]).toMatchObject({ templateCode: 'PRICE_UP_LOCKED', enabled: false });
  });

  it('PUT 未知模板：404 E_NOT_FOUND', async () => {
    const token = await accessToken(302);
    const res = await request(app.getHttpServer())
      .put('/notification-prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ prefs: [{ template_code: 'NO_SUCH_TEMPLATE', enabled: false }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('E_NOT_FOUND');
  });

  it('PUT 关闭关键类：400 E_INVALID_ARGUMENT', async () => {
    await pool.query(
      `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
       VALUES ('TEST_CRITICAL_INBOX', 'INBOX', '关键通知', 1, true)`,
    );
    const token = await accessToken(303);
    const res = await request(app.getHttpServer())
      .put('/notification-prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ prefs: [{ template_code: 'TEST_CRITICAL_INBOX', enabled: false }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('E_INVALID_ARGUMENT');
  });

  it('GET /notifications/mine：只回 INBOX+SENT，SKIPPED 不出现', async () => {
    const token = await accessToken(304);
    await prefs.putPrefs(304, [{ templateCode: 'PRICE_DOWN_COMP', enabled: false }]);
    await dispatcher.dispatch({
      userId: 304,
      templateCode: 'PRICE_UP_LOCKED',
      idempotencyKey: 'notify/user-304/inbox-1',
    });
    await dispatcher.dispatch({
      userId: 304,
      templateCode: 'PRICE_DOWN_COMP',
      idempotencyKey: 'notify/user-304/inbox-2',
    });
    await dispatcher.processPending();

    const res = await request(app.getHttpServer())
      .get('/notifications/mine')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      templateCode: 'PRICE_UP_LOCKED',
      channel: 'INBOX',
      status: 'SENT',
    });
  });

  it('未认证（无/坏 Bearer）：401 E_UNAUTHORIZED', async () => {
    const anon = await request(app.getHttpServer()).get('/notifications/mine');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const garbage = await request(app.getHttpServer())
      .get('/notification-prefs')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(garbage.body.code).toBe(ErrorCode.Unauthorized);
  });

  it('R-03 越权：lawyer 激活角色访问用户面 → 403 E_ROLE_FORBIDDEN', async () => {
    const token = await accessToken(306, 'lawyer');
    const res = await request(app.getHttpServer())
      .get('/notifications/mine')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCode.RoleForbidden);
  });

  it('PUT 请求体缺 prefs 数组：400 E_INVALID_ARGUMENT', async () => {
    const token = await accessToken(305);
    const res = await request(app.getHttpServer())
      .put('/notification-prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ foo: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('E_INVALID_ARGUMENT');
  });
});
