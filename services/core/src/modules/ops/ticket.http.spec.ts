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
import { IdentityTokenService } from '../identity/identity.token.service';
import { grantUserRoles, seedUserShell } from '../identity/lawyer-fixture';
import { PAYMENT_CONFIG, type PaymentConfig } from '../payment/payment.config';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from '../payment/payment.channels';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from '../payment/firm-merchant.config';
import { TicketModule } from './ticket.module';

/**
 * H3 工单 REST 契约（§5 + 任务简报扩展位，需 PG）：
 *   GET/POST /admin/tickets、GET /admin/tickets/sla-stats、GET /admin/tickets/{id}、
 *   POST /admin/tickets/{id}/resolve（终态 409 CLOSED；d4 回调接线位 400）。
 * 鉴权三态（lawyer-admin.http.spec 同款）：未认证 401 / 未持 admin 旗标 403 / admin 200；
 * 账号夹具经 identity 域 fixture（跨域只 import、不内联他域表名）。
 */

function testIdentityConfig(): IdentityConfig {
  return {
    phoneDataKey: randomBytes(32),
    phoneBlindPepper: randomBytes(32).toString('hex'),
    jwtSecret: randomBytes(32).toString('hex'),
  };
}

function testPaymentConfig(): PaymentConfig {
  return {
    primary: { channel: 'wechat_ecom', merchantId: 'mock-wechat-mch', secret: 'test-secret-w' },
    backup: { channel: 'alipay', merchantId: 'mock-alipay-mch', secret: 'test-secret-a' },
    switchWindowMs: 300_000,
  };
}

const MERCHANT_CONFIG: FirmMerchantConfig = { depositAmount: '500.00', reverifyDays: 365 };

describe('H3 工单 REST 契约（/admin/tickets，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TicketModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(testPaymentConfig())
      .overrideProvider(PAYMENT_CHANNEL_ADAPTERS)
      .useValue([
        new MockChannelAdapter('wechat_ecom', 'mock-wechat-mch', 'test-secret-w'),
        new MockChannelAdapter('alipay', 'mock-alipay-mch', 'test-secret-a'),
      ] as readonly PaymentChannelAdapter[])
      .overrideProvider(FIRM_MERCHANT_CONFIG)
      .useValue(MERCHANT_CONFIG)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const tokens = app.get(IdentityTokenService);

    const adminId = await seedUserShell(pool, 'h3-http-admin');
    await grantUserRoles(pool, adminId, ['user', 'admin']);
    adminToken = await tokens.signAccessToken({
      userId: adminId,
      role: 'user',
      roles: ['user', 'admin'],
    });
    const userId = await seedUserShell(pool, 'h3-http-user');
    await grantUserRoles(pool, userId, ['user']);
    userToken = await tokens.signAccessToken({ userId, role: 'user', roles: ['user'] });
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

  it('GET /admin/tickets：401 未认证/403 未持 admin；admin 空列表 + 建单后可见（sla_overdue 数据位）', async () => {
    const anon = await request(app.getHttpServer()).get('/admin/tickets');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const forbidden = await request(app.getHttpServer())
      .get('/admin/tickets')
      .set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe(ErrorCode.RoleForbidden);

    const empty = await request(app.getHttpServer())
      .get('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);

    const created = await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'dispute', ref_type: 'session', ref_id: 9001, title: '申诉', detail: 'd' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ created: true, status: 'OPEN' });
    const ticketId = created.body.ticket_id as number;

    const list = await request(app.getHttpServer())
      .get('/admin/tickets?category=dispute&status=OPEN')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      id: ticketId,
      category: 'dispute',
      ref_type: 'session',
      ref_id: 9001,
      status: 'OPEN',
      sla_overdue: false,
    });
  });

  it('POST /admin/tickets：非法 category/ref 残半 400；幂等键重放 created:false', async () => {
    const badCategory = await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'unknown', title: 't', detail: 'd' });
    expect(badCategory.status).toBe(400);
    expect(badCategory.body.code).toBe(ErrorCode.InvalidArgument);

    const halfRef = await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'dispute', ref_type: 'session', title: 't', detail: 'd' });
    expect(halfRef.status).toBe(400);

    const first = await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'dispute', ref_type: 'session', ref_id: 42, title: 't', detail: 'd' });
    expect(first.status).toBe(201);
    const dup = await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'dispute', ref_type: 'session', ref_id: 42, title: 't2', detail: 'd2' });
    expect(dup.status).toBe(201);
    expect(dup.body).toMatchObject({ created: false, ticket_id: first.body.ticket_id });
  });

  it('GET /admin/tickets/{id}：详情 + actions 审计行（处置后两行）；未知 404', async () => {
    const created = await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'dispute', ref_type: 'session', ref_id: 43, title: 't', detail: 'd' });
    const ticketId = created.body.ticket_id as number;

    const before = await request(app.getHttpServer())
      .get(`/admin/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(before.status).toBe(200);
    expect(before.body.ticket.id).toBe(ticketId);
    expect(before.body.actions).toEqual([]);

    const notFound = await request(app.getHttpServer())
      .get('/admin/tickets/999999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(notFound.status).toBe(404);
  });

  it('POST /admin/tickets/{id}/resolve：200 {status} + 终态重放 409 CLOSED + d4 接线位 400 + approved 缺失 400', async () => {
    const created = await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'cancel_lt24h', ref_type: 'session', ref_id: 44, title: 't', detail: 'd' });
    const ticketId = created.body.ticket_id as number;

    // d4 回调接线位：显式 400（W2 T3 落 cancellations 后注册即通）
    const d4 = await request(app.getHttpServer())
      .post(`/admin/tickets/${ticketId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true, action_payload: { target: 'd4', cancellation_id: 1 } });
    expect(d4.status).toBe(400);
    expect(d4.body.code).toBe(ErrorCode.InvalidArgument);

    const badBody = await request(app.getHttpServer())
      .post(`/admin/tickets/${ticketId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action_payload: {} });
    expect(badBody.status).toBe(400);

    const ok = await request(app.getHttpServer())
      .post(`/admin/tickets/${ticketId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true, action_payload: { note: '同意退款' } });
    expect(ok.status).toBe(200); // 动作端点 @HttpCode(200)（rule-admin 先例）
    expect(ok.body).toEqual({ status: 'RESOLVED' });

    const replay = await request(app.getHttpServer())
      .post(`/admin/tickets/${ticketId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe(ErrorCode.Conflict);

    // 详情审计行（认领+处置两行，operator=admin claims userId）
    const detail = await request(app.getHttpServer())
      .get(`/admin/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detail.body.actions.map((a: { action: string }) => a.action)).toEqual([
      'start_processing',
      'resolve',
    ]);
  });

  it('GET /admin/tickets/sla-stats：统计面形状（open/overdue/by_category）', async () => {
    const stats = await request(app.getHttpServer())
      .get('/admin/tickets/sla-stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(stats.status).toBe(200);
    expect(stats.body).toEqual({ open_total: 0, overdue_total: 0, by_category: {} });

    await request(app.getHttpServer())
      .post('/admin/tickets')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ category: 'dead_letter', ref_type: 'refund', ref_id: 9, title: 't', detail: 'd' });
    const after = await request(app.getHttpServer())
      .get('/admin/tickets/sla-stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.body).toEqual({
      open_total: 1,
      overdue_total: 0,
      by_category: { dead_letter: { open: 1, overdue: 0 } },
    });
  });
});
