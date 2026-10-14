import 'reflect-metadata';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { NotifyDispatcherService } from './notify-dispatcher.service';
import { NotifyModule } from './notify.module';
import { NotifyPrefsService } from './notify-prefs.service';

/**
 * I1 REST 契约（§5）：GET /notifications/mine、GET/PUT /notification-prefs。
 * 身份接线 ⚠决策位：A1（W2）未落位，user_id 暂经 query 注入；claims/token 校验随 A1 接入后替换。
 */
describe('I1 REST 契约（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let dispatcher: NotifyDispatcherService;
  let prefs: NotifyPrefsService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [NotifyModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dispatcher = app.get(NotifyDispatcherService);
    prefs = app.get(NotifyPrefsService);
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

  it('PUT /notification-prefs → GET 回读一致', async () => {
    const put = await request(app.getHttpServer())
      .put('/notification-prefs?user_id=301')
      .send({ prefs: [{ template_code: 'PRICE_UP_LOCKED', enabled: false }] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual([
      { templateCode: 'PRICE_UP_LOCKED', enabled: false, updatedAt: expect.any(String) },
    ]);

    const get = await request(app.getHttpServer()).get('/notification-prefs?user_id=301');
    expect(get.status).toBe(200);
    expect(get.body).toHaveLength(1);
    expect(get.body[0]).toMatchObject({ templateCode: 'PRICE_UP_LOCKED', enabled: false });
  });

  it('PUT 未知模板：404 E_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .put('/notification-prefs?user_id=302')
      .send({ prefs: [{ template_code: 'NO_SUCH_TEMPLATE', enabled: false }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('E_NOT_FOUND');
  });

  it('PUT 关闭关键类：400 E_INVALID_ARGUMENT', async () => {
    await pool.query(
      `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
       VALUES ('TEST_CRITICAL_INBOX', 'INBOX', '关键通知', 1, true)`,
    );
    const res = await request(app.getHttpServer())
      .put('/notification-prefs?user_id=303')
      .send({ prefs: [{ template_code: 'TEST_CRITICAL_INBOX', enabled: false }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('E_INVALID_ARGUMENT');
  });

  it('GET /notifications/mine：只回 INBOX+SENT，SKIPPED 不出现', async () => {
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

    const res = await request(app.getHttpServer()).get('/notifications/mine?user_id=304');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      templateCode: 'PRICE_UP_LOCKED',
      channel: 'INBOX',
      status: 'SENT',
    });
  });

  it('非法 user_id：400 E_INVALID_ARGUMENT', async () => {
    const res = await request(app.getHttpServer()).get('/notifications/mine?user_id=abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('E_INVALID_ARGUMENT');
  });

  it('PUT 请求体缺 prefs 数组：400 E_INVALID_ARGUMENT', async () => {
    const res = await request(app.getHttpServer())
      .put('/notification-prefs?user_id=305')
      .send({ foo: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('E_INVALID_ARGUMENT');
  });
});
