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
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from './payment.channels';
import {
  PAYMENT_CONFIG,
  PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  type PaymentConfig,
} from './payment.config';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from './firm-merchant.config';
import { PaymentModule } from './payment.module';
import { SchedulerService } from '../schedule/scheduler.service';

/**
 * A3b REST 契约（A3b §5 表逐字 + Task 3 简报）：
 *   POST /firms/{id}/merchant/submit   {channel, materials} → {status}；409 DUPLICATE
 *   POST /firms/{id}/merchant/change   {materials} → {status: CHANGING}（R-W3-C2 Suspended 同事务出箱）
 *   POST /firms/{id}/merchant/reverify （R-03 复验完成路径——§5 未列的最小补面，报告偏差节记录）
 *   POST /firms/{id}/deposit/freeze    {lawyer_id, batch, amount?} → {escrow_status}；400 INSUFFICIENT
 * 出参包键名照 §5 出参列（{status}/{escrow_status}）。
 * W3 T10 G-A 同批接线（TODO(H1-W3-T10) 收尾）：四端点挂 @RequireRole('admin')——
 * 未认证 401 / 未持 admin 旗标 403（本文件新 Aug3b 鉴权用例）；admin 形态 token=
 * claims-only 签发（guard 只验 JWT 不查库，A1 口径；DB 预置夹具=lawyer-admin.http.spec 同款）。
 */

function testConfig(): PaymentConfig {
  return {
    primary: { channel: 'wechat_ecom', merchantId: 'mock-wechat-mch', secret: 'test-secret-w' },
    backup: { channel: 'alipay', merchantId: 'mock-alipay-mch', secret: 'test-secret-a' },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

const MERCHANT_CONFIG: FirmMerchantConfig = { depositAmount: '500.00', reverifyDays: 365 };

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('A3b HTTP 契约（§5，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let wechat: MockChannelAdapter;
  let adminToken: string;
  let userToken: string;

  const adminPost = (url: string) =>
    request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    wechat = new MockChannelAdapter('wechat_ecom', 'mock-wechat-mch', 'test-secret-w');
    const alipay = new MockChannelAdapter('alipay', 'mock-alipay-mch', 'test-secret-a');
    const moduleRef = await Test.createTestingModule({ imports: [PaymentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(testConfig())
      .overrideProvider(PAYMENT_CHANNEL_ADAPTERS)
      .useValue([wechat, alipay] as readonly PaymentChannelAdapter[])
      .overrideProvider(FIRM_MERCHANT_CONFIG)
      .useValue(MERCHANT_CONFIG)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const jwt = app.get(JwtService);
    adminToken = await jwt.signAsync({ sub: '990002', role: 'user', roles: ['user', 'admin'] });
    userToken = await jwt.signAsync({ sub: '990003', role: 'user', roles: ['user'] });
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
    wechat.fault = null;
  });

  it('POST /firms/{id}/merchant/submit：{channel, materials} → {status}；重复 409 E_DUPLICATE；channel 越域/materials 形状 400', async () => {
    const ok = await adminPost('/firms/50/merchant/submit').send({
      channel: 'wechat_ecom',
      materials: { bank_account_no: 'x' },
    });
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body)).toEqual(['status']); // §5 出参列逐字
    expect(ok.body.status).toBe('ACTIVE');

    const dup = await adminPost('/firms/50/merchant/submit').send({
      channel: 'wechat_ecom',
      materials: {},
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('E_DUPLICATE');

    const badChannel = await adminPost('/firms/51/merchant/submit').send({
      channel: 'union_pay',
      materials: {},
    });
    expect(badChannel.status).toBe(400);
    expect(badChannel.body.code).toBe('E_INVALID_ARGUMENT');

    const badMaterials = await adminPost('/firms/51/merchant/submit').send({
      channel: 'wechat_ecom',
      materials: 'not-an-object',
    });
    expect(badMaterials.status).toBe(400);

    const oversize = await adminPost('/firms/51/merchant/submit').send({
      channel: 'wechat_ecom',
      materials: { blob: 'x'.repeat(17_000) },
    });
    expect(oversize.status).toBe(400);

    const badFirm = await adminPost('/firms/abc/merchant/submit').send({
      channel: 'wechat_ecom',
      materials: {},
    });
    expect(badFirm.status).toBe(400);
  });

  it('POST /firms/{id}/merchant/change：{materials} → {status: CHANGING}（Suspended 事件同事务出箱）；未进件 404', async () => {
    await adminPost('/firms/52/merchant/submit').send({ channel: 'wechat_ecom', materials: {} });
    const changed = await adminPost('/firms/52/merchant/change').send({
      materials: { bank_account_no: 'new' },
    });
    expect(changed.status).toBe(201);
    expect(Object.keys(changed.body)).toEqual(['status']);
    expect(changed.body.status).toBe('CHANGING');

    const missing = await adminPost('/firms/999999/merchant/change').send({ materials: {} });
    expect(missing.status).toBe(404);
  });

  it('POST /firms/{id}/merchant/reverify（R-03 最小补面）：SUSPENDED → {status: ACTIVE}；ACTIVE 复验 409', async () => {
    await adminPost('/firms/53/merchant/submit').send({ channel: 'wechat_ecom', materials: {} });
    // 时间旅行（I2 API 面，schedule_jobs 禁直改——schema-refs 红线）：job 按过去时刻重注册 +
    // payment 侧复验锚提前，经 I2 tick 触发停用
    const scheduler = app.get(SchedulerService);
    const merchantId = (
      await pool.query<{ id: string }>(`SELECT id FROM payment.firm_merchants WHERE firm_id = 53`)
    ).rows[0]!.id;
    const cancelled = await scheduler.cancelJob(pool, {
      jobType: 'FIRM_REVERIFY',
      refType: 'firm_merchant',
      refId: Number(merchantId),
    });
    expect(cancelled.cancelled).toBe(true);
    await scheduler.registerJob(pool, {
      jobType: 'FIRM_REVERIFY',
      refType: 'firm_merchant',
      refId: Number(merchantId),
      dueAt: new Date(Date.now() - 1000),
    });
    await pool.query(
      `UPDATE payment.firm_merchants SET reverify_due = now() - interval '1s' WHERE firm_id = 53`,
    );
    const tick = await scheduler.tick('normal');
    expect(tick.done).toBe(1);

    const ok = await adminPost('/firms/53/merchant/reverify').send({});
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body)).toEqual(['status']);
    expect(ok.body.status).toBe('ACTIVE');

    const early = await adminPost('/firms/53/merchant/reverify').send({});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('E_STATE_ILLEGAL_TRANSITION');

    const missing = await adminPost('/firms/999999/merchant/reverify').send({});
    expect(missing.status).toBe(404);
  });

  it('POST /firms/{id}/deposit/freeze：{lawyer_id, batch, amount} → {escrow_status}；幂等重放同单；INSUFFICIENT 400；金额形态 422；缺 batch 400', async () => {
    const ok = await adminPost('/firms/54/deposit/freeze').send({
      lawyer_id: 9101,
      batch: 'HTTP-B-1',
      amount: '120.00',
    });
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body)).toEqual(['escrow_status']); // §5 出参列逐字
    expect(ok.body.escrow_status).toBe('FROZEN');

    const replay = await adminPost('/firms/54/deposit/freeze').send({
      lawyer_id: 9101,
      batch: 'HTTP-B-1',
      amount: '120.00',
    });
    expect(replay.status).toBe(201);
    expect(replay.body.escrow_status).toBe('FROZEN');

    // amount 缺省=配置 LJR_PAYMENT_DEPOSIT_AMOUNT（⚠W3-D4 台账先行）
    const defaults = await adminPost('/firms/55/deposit/freeze').send({
      lawyer_id: 9102,
      batch: 'HTTP-B-2',
    });
    expect(defaults.status).toBe(201);
    const row = await pool.query<{ escrow_amount: string }>(
      `SELECT escrow_amount::text AS escrow_amount FROM payment.lawyer_deposits
        WHERE detail ->> 'firm_id' = '55'`,
    );
    expect(row.rows[0]!.escrow_amount).toBe('500.00');

    const conflict = await adminPost('/firms/54/deposit/freeze').send({
      lawyer_id: 9101,
      batch: 'HTTP-B-1',
      amount: '130.00',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('E_DUP_KEY');

    // INSUFFICIENT（通道业务应答）→ 400 E_INSUFFICIENT（§5 逐字）
    wechat.fault = { kind: 'INSUFFICIENT' };
    const insufficient = await adminPost('/firms/56/deposit/freeze').send({
      lawyer_id: 9103,
      batch: 'HTTP-B-3',
      amount: '10.00',
    });
    expect(insufficient.status).toBe(400);
    expect(insufficient.body.code).toBe('E_INSUFFICIENT');
    wechat.fault = null;

    const badAmount = await adminPost('/firms/57/deposit/freeze').send({
      lawyer_id: 9104,
      batch: 'HTTP-B-4',
      amount: '10.5',
    });
    expect(badAmount.status).toBe(422);
    expect(badAmount.body.code).toBe('E_MONEY_INVALID');

    const noBatch = await adminPost('/firms/57/deposit/freeze').send({
      lawyer_id: 9104,
      amount: '10.00',
    });
    expect(noBatch.status).toBe(400);
  });

  it('G-A 同批接线收尾（TODO(H1-W3-T10)）：四端点未认证 401 / 律师 token（未持 admin 旗标）403 / admin 可达', async () => {
    const paths = [
      '/firms/60/merchant/submit',
      '/firms/60/merchant/change',
      '/firms/60/merchant/reverify',
      '/firms/60/deposit/freeze',
    ];
    const bodies = [
      { channel: 'wechat_ecom', materials: {} },
      { materials: {} },
      {},
      { lawyer_id: 9201, batch: 'HTTP-AUTH-1' },
    ];
    for (const [i, path] of paths.entries()) {
      const anon = await request(app.getHttpServer()).post(path).send(bodies[i]);
      expect(anon.status).toBe(401);
      expect(anon.body.code).toBe('E_UNAUTHORIZED');
      const asUser = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${userToken}`)
        .send(bodies[i]);
      expect(asUser.status).toBe(403);
      expect(asUser.body.code).toBe('E_ROLE_FORBIDDEN');
    }

    // admin 持旗标可达（submit 真链一例；其余三面同守卫类装配）
    const ok = await adminPost('/firms/61/merchant/submit').send({
      channel: 'wechat_ecom',
      materials: {},
    });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('ACTIVE');
  });
});
