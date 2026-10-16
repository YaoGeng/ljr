import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { PAYMENT_CALLBACK_INBOXED_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PAYMENT_CHANNEL_ADAPTERS } from './payment.channels';
import { PAYMENT_CONFIG, PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { PaymentModule } from './payment.module';

interface MockChannelLike {
  readonly channel: string;
  fault: { readonly kind: 'CHANNEL_ERROR' | 'INSUFFICIENT' } | null;
}

/**
 * F1 HTTP 契约（§5 表逐字 + Task 1 简报）：
 *   POST /pay/orders|refund|split|deduct（对 Core 指令面）+ POST /callbacks/{channel}（验签 200/403）
 *   + POST /admin/payment/reconcile（⚠W3-10 手动触发面）。
 * 回调驱动器（测试侧）：同款 env 密钥签发报文打 HTTP 入口（真实可打路径——rawBody 字节级验签）。
 * 错误体形态：infrastructure AppHttpExceptionFilter {code, message}。
 */

const DAY = Date.UTC(2026, 9, 16, 8, 0, 0);

function testConfig(): PaymentConfig {
  return {
    primary: { channel: 'wechat_ecom', merchantId: 'mock-wechat-mch', secret: randomBytes(32).toString('hex') },
    backup: { channel: 'alipay', merchantId: 'mock-alipay-mch', secret: randomBytes(32).toString('hex') },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

describe('F1 HTTP 契约（§5，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let cfg: PaymentConfig;
  let seq = 0;

  /** 回调驱动器：签发合法报文打 HTTP 入口（签名覆盖发送字节的原文） */
  const postCallback = (channel: string, body: Record<string, unknown>, secret?: string) => {
    const raw = JSON.stringify(body);
    return request(app.getHttpServer())
      .post(`/callbacks/${channel}`)
      .set('x-payment-signature', createHmac('sha256', secret ?? cfg.primary.secret).update(raw).digest('hex'))
      .set('Content-Type', 'application/json')
      .send(raw);
  };

  const createOrderBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    biz_type: 'enroll',
    biz_id: 401,
    cash_amount: '199.50',
    points_amount: 250,
    idempotency_key: `payment/http-${++seq}/pay`,
    ...over,
  });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    cfg = testConfig();
    const moduleRef = await Test.createTestingModule({ imports: [PaymentModule] })
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(cfg)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
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

  it('POST /pay/orders：{payment_order, pay_params}；幂等重放同单；同键异载荷 409 E_DUP_KEY；非法金额 422', async () => {
    const body = createOrderBody();
    const ok = await request(app.getHttpServer()).post('/pay/orders').send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.payment_order.status).toBe('CREATED');
    expect(ok.body.payment_order.total).toBe('202.00');
    expect(ok.body.pay_params.order_id).toBe(ok.body.payment_order.id);
    expect(ok.body.pay_params.channel).toBe('wechat_ecom');

    const replay = await request(app.getHttpServer()).post('/pay/orders').send(createOrderBody({ idempotency_key: body['idempotency_key'] }));
    expect(replay.status).toBe(201);
    expect(replay.body.payment_order.id).toBe(ok.body.payment_order.id);

    const conflict = await request(app.getHttpServer())
      .post('/pay/orders')
      .send(createOrderBody({ idempotency_key: body['idempotency_key'], cash_amount: '299.50' }));
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('E_DUP_KEY');

    const bad = await request(app.getHttpServer()).post('/pay/orders').send(createOrderBody({ cash_amount: '199.5' }));
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('E_MONEY_INVALID');
  });

  it('POST /pay/refund：指令下发 REFUNDING；404 未知名单；409 DUP 同口径', async () => {
    const created = await request(app.getHttpServer()).post('/pay/orders').send(createOrderBody());
    const orderId = created.body.payment_order.id as number;

    const missing = await request(app.getHttpServer()).post('/pay/refund').send({
      order_id: 999999,
      cash_refund: '1.00',
      points_refund: 0,
      reason: 'x',
      idempotency_key: 'payment/http-r-missing/refund',
    });
    expect(missing.status).toBe(404);
    // 未冻结支付（CREATED）退款被守卫拒 → 409 StateIllegalTransition
    const early = await request(app.getHttpServer()).post('/pay/refund').send({
      order_id: orderId,
      cash_refund: '1.00',
      points_refund: 0,
      reason: '早退',
      idempotency_key: 'payment/http-r-early/refund',
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('E_STATE_ILLEGAL_TRANSITION');
  });

  it('POST /pay/deduct：INSUFFICIENT → 400 E_INSUFFICIENT；from 越域 400（§5 契约）', async () => {
    // 主通道注入 INSUFFICIENT（适配器测试钩子；测试侧经 injector 取内部件——可剥离纪律约束的是
    // 「其他模块禁 import 内部件」，测试可白盒）
    const adapters = app.get<MockChannelLike[]>(PAYMENT_CHANNEL_ADAPTERS);
    (adapters[0] as MockChannelLike).fault = { kind: 'INSUFFICIENT' };
    const insufficient = await request(app.getHttpServer()).post('/pay/deduct').send({
      lawyer_id: 9101,
      amount: '30.00',
      from: 'settlement',
      idempotency_key: 'payment/http-d-ins/deduct',
    });
    expect(insufficient.status).toBe(400);
    expect(insufficient.body.code).toBe('E_INSUFFICIENT');

    (adapters[0] as MockChannelLike).fault = null; // 清除注入后走主通道
    const ok = await request(app.getHttpServer()).post('/pay/deduct').send({
      lawyer_id: 9102,
      amount: '5.00',
      from: 'deposit',
      idempotency_key: 'payment/http-d-ok/deduct',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.direction).toBe('DEDUCT');
    expect(ok.body.channel).toBe('wechat_ecom');

    const bad = await request(app.getHttpServer()).post('/pay/deduct').send({
      lawyer_id: 9101,
      amount: '30.00',
      from: 'wallet',
      idempotency_key: 'payment/http-d-bad/deduct',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('E_INVALID_ARGUMENT');
  });

  it('POST /callbacks/{channel}：合法签名 200 入箱；验签失败 403 E_SIGN_FAIL；重复 200 deduped；未知通道 404', async () => {
    const created = await request(app.getHttpServer()).post('/pay/orders').send(createOrderBody());
    const order = created.body.payment_order;

    const ok = await postCallback('wechat_ecom', {
      order_id: order.id,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'HTTP-TXN-1',
      amount: '202.00',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.inboxed).toBe(true);

    const replay = await postCallback('wechat_ecom', {
      order_id: order.id,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'HTTP-TXN-1',
      amount: '202.00',
    });
    expect(replay.status).toBe(200);
    expect(replay.body.inboxed).toBe(false);

    const badSig = await request(app.getHttpServer())
      .post('/callbacks/wechat_ecom')
      .set('x-payment-signature', '0'.repeat(64))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ order_id: order.id, event_type: 'PAY_SUCCESS', channel_txn_no: 'HTTP-TXN-2' }));
    expect(badSig.status).toBe(403);
    expect(badSig.body.code).toBe('E_SIGN_FAIL');

    const unknown = await postCallback('union_pay', { order_id: order.id }, 'x');
    expect(unknown.status).toBe(404);

    const events = await pool.query(`SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`, [
      PAYMENT_CALLBACK_INBOXED_TOPIC,
    ]);
    expect(events.rows[0]!.n).toBe(1); // 恰一次出箱
  });

  it('POST /admin/payment/reconcile {period}：200 对账摘要；非法 period 400（⚠W3-10 手动触发面）', async () => {
    const ok = await request(app.getHttpServer()).post('/admin/payment/reconcile').send({ period: '2026-10-16' });
    expect(ok.status).toBe(200);
    expect(ok.body.period).toBe('2026-10-16');
    expect(ok.body.per_channel.length).toBe(2);

    const bad = await request(app.getHttpServer()).post('/admin/payment/reconcile').send({ period: 'yesterday' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('E_INVALID_ARGUMENT');
  });
});
