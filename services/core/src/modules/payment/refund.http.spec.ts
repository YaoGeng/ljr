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
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { PaymentModule } from './payment.module';
import { RefundService } from './refund.service';

/**
 * F2 REST 面 e2e（需 PG）：GET /refunds/mine（§5 契约：本人退款状态列表，含 1-3 工作日文案
 * 字段 R-01）——JWT 本人语义面（claims 注入 user_id，points/mine 同款）+ @RequireRole('user')
 * + AppHttpExceptionFilter 统一错误体。受理数据以服务面 ISSUE_REFUND 直接夹具（经真 F1 通道）。
 */
const USER = 601;
const LAWYER = 9101;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('F2 REST 面：GET /refunds/mine（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let jwt: JwtService;
  let userToken: string;
  let lawyerToken: string;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [PaymentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
    userToken = await jwt.signAsync({ sub: String(USER), role: 'user', roles: ['user'] });
    lawyerToken = await jwt.signAsync({
      sub: String(LAWYER),
      role: 'lawyer',
      roles: ['user', 'lawyer'],
    });
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

  it('未认证 401；非 user 激活角色 403 E_ROLE_FORBIDDEN（@RequireRole user）', async () => {
    const anon = await request(app.getHttpServer()).get('/refunds/mine');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const asLawyer = await request(app.getHttpServer())
      .get('/refunds/mine')
      .set('Authorization', `Bearer ${lawyerToken}`);
    expect(asLawyer.status).toBe(403);
    expect(asLawyer.body.code).toBe(ErrorCode.RoleForbidden);
  });

  it('user 本人状态列表：在途含 1-3 工作日文案；DONE/FAILED 终态文案；他人单不可见', async () => {
    const refunds = app.get(RefundService);
    // 夹具：本人两单（在途 PROCESSING + 已 DONE——经真 F1 受理+回调收敛），他人一单
    await refunds.accept({
      order_id: await seedOrder(app, 1),
      user_id: USER,
      cash: '30.00',
      points: 0,
      reason: 'GROUP_FAIL',
      idempotency_key: 'refund/http-1/group-fail',
    });
    const order2 = await seedOrder(app, 2);
    const done = await refunds.accept({
      order_id: order2,
      user_id: USER,
      cash: '50.00',
      points: 1000,
      reason: 'TIMEOUT',
      idempotency_key: 'refund/http-2/timeout',
    });
    await refunds.convergeRefundSuccess('payment/http-order-2/pay');
    await pool.query(
      `INSERT INTO payment.refunds
         (payment_order_id, user_id, cash_amount, points_amount, reason, status, idempotency_key)
       VALUES (999, 999, '10.00', 0, 'GROUP_FAIL', 'REQUESTED', 'refund/http-other/group-fail')`,
    );

    const res = await request(app.getHttpServer())
      .get('/refunds/mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2); // 仅本人（他人单 999 不可见；ORDER BY id DESC）
    expect(res.body[0]).toMatchObject({
      refund_id: done.refund.refund_id,
      order_id: order2,
      cash_amount: '50.00',
      points_amount: 1000,
      reason: 'TIMEOUT',
      status: 'DONE',
      eta_text: '已原路退回',
    });
    expect(res.body[1]).toMatchObject({
      reason: 'GROUP_FAIL',
      status: 'PROCESSING',
      eta_text: '退款已受理，将在 1-3 个工作日内原路退回',
      done_at: null,
    });
  });
});

/** 夹具：经真 F1 创建并 markFrozen 的已支付单（幂等键固定，供服务面受理） */
async function seedOrder(app: INestApplication, seq: number): Promise<number> {
  const { PaymentGatewayService } = await import('./payment.gateway.service');
  const gateway = app.get(PaymentGatewayService);
  const res = await gateway.createOrder({
    biz_type: 'enroll',
    biz_id: 700 + seq,
    cash_amount: seq === 1 ? '30.00' : '50.00',
    points_amount: seq === 1 ? 0 : 1000,
    idempotency_key: `payment/http-order-${seq}/pay`,
  });
  await gateway.markFrozen(res.payment_order.id, `MOCK-WECHAT-HTTP-${seq}`);
  return res.payment_order.id;
}
