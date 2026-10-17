import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from '../payment/payment.channels';
import {
  PAYMENT_CONFIG,
  PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  type PaymentConfig,
} from '../payment/payment.config';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from '../payment/firm-merchant.config';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { seedFirmMerchant } from '../payment/firm-merchant.fixture';
import { SettlementModule } from './settlement.module';
import { SettlementService } from './settlement.service';

/**
 * F3 REST 面 e2e（§5 契约表逐字 + Task 8 简报；需 PG）：
 *   GET /lawyer/settlements        → 本人结算列表（@RequireRole('lawyer') + @CurrentIdentity）
 *   GET /admin/settlements?status= → 后台视图（TODO(H1-W3-T10) 鉴权占位照 A3b 先例；status 越域 400）
 * 种子经应用服务真链（F1 支付单→enterSettlement），不出 SQL 直插（契约形状即断言对象）。
 */

const LAWYER = 9101;
const LAWYER2 = 9102;
const FIRM = 31;

function testPaymentConfig(): PaymentConfig {
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

describe('F3 HTTP 契约（§5，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let jwt: JwtService;
  /** G-A 同批接线（TODO(H1-W3-T10) 收尾）：DB 预置 admin 形态 token（roles 持 admin 旗标） */
  let adminToken: string;
  let settlements: SettlementService;
  let payment: PaymentGatewayService;
  let orderSeq = 0;

  const createPaidOrder = async (cash = '100.00'): Promise<number> => {
    orderSeq += 1;
    const res = await payment.createOrder({
      biz_type: 'enroll',
      biz_id: 800 + orderSeq,
      cash_amount: cash,
      points_amount: 0,
      idempotency_key: `payment/f3h-order-${orderSeq}/pay`,
    });
    await payment.markFrozen(res.payment_order.id, `MOCK-WECHAT-F3H-${orderSeq}`);
    await payment.markPaid(res.payment_order.id);
    return res.payment_order.id;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const wechat = new MockChannelAdapter('wechat_ecom', 'mock-wechat-mch', 'test-secret-w');
    const alipay = new MockChannelAdapter('alipay', 'mock-alipay-mch', 'test-secret-a');
    const moduleRef = await Test.createTestingModule({ imports: [SettlementModule] })
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(testPaymentConfig())
      .overrideProvider(PAYMENT_CHANNEL_ADAPTERS)
      .useValue([wechat, alipay] as readonly PaymentChannelAdapter[])
      .overrideProvider(FIRM_MERCHANT_CONFIG)
      .useValue(MERCHANT_CONFIG)
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
    adminToken = await jwt.signAsync({ sub: '990004', role: 'user', roles: ['user', 'admin'] });
    settlements = app.get(SettlementService);
    payment = app.get(PaymentGatewayService);
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

  it('GET /lawyer/settlements：未认证 401；user 激活角色 403；lawyer 本人过滤（他人行不出现）', async () => {
    const anon = await request(app.getHttpServer()).get('/lawyer/settlements');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const userToken = await jwt.signAsync({ sub: '601', role: 'user', roles: ['user'] });
    const asUser = await request(app.getHttpServer())
      .get('/lawyer/settlements')
      .set('Authorization', `Bearer ${userToken}`);
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe(ErrorCode.RoleForbidden);

    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: 901,
      lawyer_id: LAWYER,
      firm_id: FIRM,
      gross: '100.00',
      payment_order_id: await createPaidOrder('100.00'),
    });
    await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: 902,
      lawyer_id: LAWYER2,
      firm_id: FIRM,
      gross: '40.00',
      payment_order_id: await createPaidOrder('40.00'),
    });

    const lawyerToken = await jwt.signAsync({
      sub: String(LAWYER),
      role: 'lawyer',
      roles: ['user', 'lawyer'],
    });
    const mine = await request(app.getHttpServer())
      .get('/lawyer/settlements')
      .set('Authorization', `Bearer ${lawyerToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({
      ref_type: 'session',
      ref_id: 901,
      lawyer_id: LAWYER,
      status: 'HOLD',
      hold_reason: 'HOLD_24H',
      gross: '100.00',
      platform_fee: '0.00', // R-06 种子 0%（D20 ⚠W3 默认）
      net: '100.00',
    });
  });

  it('GET /admin/settlements?status=HOLD：后台过滤视图（W3 T10 G-A 接线：admin 夹具）；status 越域 400；缺省全量', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: 903,
      lawyer_id: LAWYER,
      firm_id: FIRM,
      gross: '100.00',
      payment_order_id: await createPaidOrder('100.00'),
    });
    await settlements.enterSettlement({
      ref_type: 'one_on_one',
      ref_id: 904,
      lawyer_id: LAWYER,
      firm_id: FIRM,
      gross: '60.00',
      payment_order_id: await createPaidOrder('60.00'),
    });

    const holding = await request(app.getHttpServer())
      .get('/admin/settlements?status=HOLD')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(holding.status).toBe(200);
    expect(holding.body).toHaveLength(2);

    const all = await request(app.getHttpServer())
      .get('/admin/settlements')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);

    const bad = await request(app.getHttpServer())
      .get('/admin/settlements?status=WEIRD')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(ErrorCode.InvalidArgument);
  });

  it('G-A 同批接线收尾（TODO(H1-W3-T10)）：/admin/settlements 未认证 401 / 律师 token（未持 admin 旗标）403 / admin 200', async () => {
    const anon = await request(app.getHttpServer()).get('/admin/settlements');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const lawyerToken = await jwt.signAsync({
      sub: String(LAWYER),
      role: 'lawyer',
      roles: ['user', 'lawyer'],
    });
    const asLawyer = await request(app.getHttpServer())
      .get('/admin/settlements')
      .set('Authorization', `Bearer ${lawyerToken}`);
    expect(asLawyer.status).toBe(403);
    expect(asLawyer.body.code).toBe(ErrorCode.RoleForbidden);

    const ok = await request(app.getHttpServer())
      .get('/admin/settlements')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([]);
  });
});
