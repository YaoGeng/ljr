import 'reflect-metadata';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AppError, ErrorCode, PAYMENT_CALLBACK_INBOXED_TOPIC } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { ChannelRouter, MockChannelAdapter } from './payment.channels';
import { PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from './payment.alerts';
import { PaymentGatewayService } from './payment.gateway.service';

/**
 * F1 回调验签 → Inbox 投递（§4/§5/R-02/§9 TDD 清单）：
 *   HMAC-SHA256 验签失败 403；双唯一去重（channel_txn_no + biz_idempotency_key 两方向）；
 *   同单多事件互不误杀（PAY_SUCCESS/REFUND_SUCCESS 均入箱）；重复回调恰一次生效（出箱恰一条）；
 *   乱序容忍（REFUND_SUCCESS 先到：入箱成功、业务推进被守卫拒 → 消费侧 DEAD + 告警位）。
 * 测试驱动器：本 spec 以同款密钥签发合法报文直调服务面（HTTP 形态见 payment.http.spec）。
 */

const DAY = Date.UTC(2026, 9, 16, 8, 0, 0);

function testConfig(): PaymentConfig {
  return {
    primary: {
      channel: 'wechat_ecom',
      merchantId: 'mock-wechat-mch',
      secret: randomBytes(32).toString('hex'),
    },
    backup: {
      channel: 'alipay',
      merchantId: 'mock-alipay-mch',
      secret: randomBytes(32).toString('hex'),
    },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

describe('F1 回调验签与 Inbox（需 PG）', () => {
  let pool: Pool;
  let svc: PaymentGatewayService;
  let cfg: PaymentConfig;
  let sink: MockPaymentAlertSink;
  let seq = 0;

  /** 回调驱动器（测试侧）：用同款 env 密钥签发合法报文 */
  const signedBody = (
    body: Record<string, unknown>,
    secret: string = cfg.primary.secret,
  ): { raw: Buffer; signature: string } => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  };

  const createOrder = async (): Promise<{ id: number; key: string }> => {
    seq += 1;
    const res = await svc.createOrder({
      biz_type: 'enroll',
      biz_id: 200 + seq,
      cash_amount: '100.00',
      points_amount: 0,
      idempotency_key: `payment/cb-order-${seq}/pay`,
    });
    return { id: res.payment_order.id, key: res.payment_order.idempotency_key };
  };

  const payCallbackBody = (order: { id: number }, txn: string): Record<string, unknown> => ({
    order_id: order.id,
    event_type: 'PAY_SUCCESS',
    channel_txn_no: txn,
    amount: '100.00',
  });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    cfg = testConfig();
    const router = new ChannelRouter({
      adapters: [
        new MockChannelAdapter(
          'wechat_ecom',
          cfg.primary.merchantId,
          cfg.primary.secret,
          () => new Date(DAY),
        ),
        new MockChannelAdapter(
          'alipay',
          cfg.backup.merchantId,
          cfg.backup.secret,
          () => new Date(DAY),
        ),
      ],
      switchWindowMs: cfg.switchWindowMs,
      now: () => DAY,
    });
    const poolSvc = new PgPoolService(pool);
    sink = new MockPaymentAlertSink();
    svc = new PaymentGatewayService(
      poolSvc,
      new OutboxService(),
      new StateTransitionGuardService(new StateTransitionLogService(), poolSvc),
      router,
      new PaymentAlertService(sink),
      cfg,
    );
  });

  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('合法签名回调：入箱 RECEIVED + PaymentCallbackInboxed 同事务出箱（biz_idempotency_key={订单幂等键}:{事件}）', async () => {
    const order = await createOrder();
    const { raw, signature } = signedBody(payCallbackBody(order, 'MOCK-WECHAT-900001'));
    const res = await svc.ingestCallback('wechat_ecom', raw, signature);
    expect(res.inboxed).toBe(true);

    const inbox = await pool.query<{
      channel_txn_no: string;
      biz_idempotency_key: string;
      status: string;
      payload: Record<string, unknown>;
    }>(`SELECT channel_txn_no, biz_idempotency_key, status, payload FROM payment.inbox`);
    expect(inbox.rows.length).toBe(1);
    expect(inbox.rows[0]!.status).toBe('RECEIVED');
    expect(inbox.rows[0]!.channel_txn_no).toBe('MOCK-WECHAT-900001');
    expect(inbox.rows[0]!.biz_idempotency_key).toBe(`${order.key}:PAY_SUCCESS`);
    expect(inbox.rows[0]!.payload['channel']).toBe('wechat_ecom');

    const events = await pool.query<{
      topic: string;
      payload: { biz_idempotency_key: string; event: string };
    }>(`SELECT topic, payload FROM platform.outbox WHERE topic = $1`, [
      PAYMENT_CALLBACK_INBOXED_TOPIC,
    ]);
    expect(events.rows.length).toBe(1);
    expect(events.rows[0]!.payload).toEqual({
      biz_idempotency_key: `${order.key}:PAY_SUCCESS`,
      event: 'PAY_SUCCESS',
    });
  });

  it('验签失败 403 E_SIGN_FAIL：错签/缺签/报文被改均拒绝，不入箱不出箱', async () => {
    const order = await createOrder();
    const good = signedBody(payCallbackBody(order, 'MOCK-WECHAT-900002'));

    await expect(svc.ingestCallback('wechat_ecom', good.raw, '0'.repeat(64))).rejects.toMatchObject(
      { code: ErrorCode.SignVerificationFailed, httpStatus: 403 },
    );
    await expect(svc.ingestCallback('wechat_ecom', good.raw, null)).rejects.toMatchObject({
      code: ErrorCode.SignVerificationFailed,
    });
    // 报文被改：用原签名验篡改体
    const tampered = Buffer.from(
      JSON.stringify({ ...payCallbackBody(order, 'X'), amount: '9999.00' }),
      'utf8',
    );
    await expect(svc.ingestCallback('wechat_ecom', tampered, good.signature)).rejects.toMatchObject(
      {
        code: ErrorCode.SignVerificationFailed,
      },
    );

    const n = await pool.query(`SELECT count(*)::int AS n FROM payment.inbox`);
    expect(n.rows[0]!.n).toBe(0);
    const e = await pool.query(`SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`, [
      PAYMENT_CALLBACK_INBOXED_TOPIC,
    ]);
    expect(e.rows[0]!.n).toBe(0);
  });

  it('R-02 重复回调恰一次：同报文重放第二笔 deduped（仍 200 语义），inbox/outbox 均恰一条', async () => {
    const order = await createOrder();
    const { raw, signature } = signedBody(payCallbackBody(order, 'MOCK-WECHAT-900003'));
    const first = await svc.ingestCallback('wechat_ecom', raw, signature);
    const replay = await svc.ingestCallback('wechat_ecom', raw, signature);
    expect(first.inboxed).toBe(true);
    expect(replay.inboxed).toBe(false); // 去重短路（HTTP 面仍 200）

    const n = await pool.query(`SELECT count(*)::int AS n FROM payment.inbox`);
    expect(n.rows[0]!.n).toBe(1);
    const e = await pool.query(`SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`, [
      PAYMENT_CALLBACK_INBOXED_TOPIC,
    ]);
    expect(e.rows[0]!.n).toBe(1);
  });

  it('§3 双唯一两方向：同 channel_txn_no 异 biz 键 / 同 biz 键异 channel_txn_no 均去重', async () => {
    const orderA = await createOrder();
    const orderB = await createOrder();
    // 同 txn、异单（biz 键不同）→ channel_txn_no 唯一约束去重
    const r1 = await svc.ingestCallback(
      'wechat_ecom',
      signedBody(payCallbackBody(orderA, 'MOCK-WECHAT-900004')).raw,
      signedBody(payCallbackBody(orderA, 'MOCK-WECHAT-900004')).signature,
    );
    const r2 = await svc.ingestCallback(
      'wechat_ecom',
      signedBody(payCallbackBody(orderB, 'MOCK-WECHAT-900004')).raw,
      signedBody(payCallbackBody(orderB, 'MOCK-WECHAT-900004')).signature,
    );
    expect(r1.inboxed).toBe(true);
    expect(r2.inboxed).toBe(false);

    // 同单同事件、异 txn → biz_idempotency_key 唯一约束去重
    const r3 = await svc.ingestCallback(
      'wechat_ecom',
      signedBody(payCallbackBody(orderA, 'MOCK-WECHAT-900005')).raw,
      signedBody(payCallbackBody(orderA, 'MOCK-WECHAT-900005')).signature,
    );
    expect(r3.inboxed).toBe(false); // {orderA.key}:PAY_SUCCESS 已在箱
  });

  it('§9 同单多事件互不误杀：PAY_SUCCESS 与 REFUND_SUCCESS 均入箱、各出箱一条', async () => {
    const order = await createOrder();
    const pay = signedBody(payCallbackBody(order, 'MOCK-WECHAT-900006'));
    await svc.ingestCallback('wechat_ecom', pay.raw, pay.signature);

    const refundBody = {
      order_id: order.id,
      event_type: 'REFUND_SUCCESS',
      channel_txn_no: 'MOCK-WECHAT-900007',
      amount: '100.00',
    };
    const refund = signedBody(refundBody);
    await svc.ingestCallback('wechat_ecom', refund.raw, refund.signature);

    const keys = await pool.query<{ arr: string[] | null }>(
      `SELECT array_agg(biz_idempotency_key ORDER BY biz_idempotency_key) AS arr FROM payment.inbox`,
    );
    const arr = keys.rows[0]!.arr!;
    expect(arr.length).toBe(2);
    expect(arr[0]).toBe(`${order.key}:PAY_SUCCESS`);
    expect(arr[1]).toBe(`${order.key}:REFUND_SUCCESS`);

    const e = await pool.query(`SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`, [
      PAYMENT_CALLBACK_INBOXED_TOPIC,
    ]);
    expect(e.rows[0]!.n).toBe(2);
  });

  it('§9 乱序容忍：REFUND_SUCCESS 先到→入箱成功、markRefunded 被守卫拒→DEAD+告警位；PAY_SUCCESS 后到照常消费', async () => {
    const order = await createOrder();
    const refund = signedBody({
      order_id: order.id,
      event_type: 'REFUND_SUCCESS',
      channel_txn_no: 'MOCK-WECHAT-900008',
      amount: '100.00',
    });
    const inboxed = await svc.ingestCallback('wechat_ecom', refund.raw, refund.signature);
    expect(inboxed.inboxed).toBe(true);
    const inboxId = inboxed.inbox_id!;

    // 业务推进被守卫拒（CREATED→REFUNDED 非法，STL 拒绝留痕）
    await expect(svc.markRefunded(order.id, null)).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
    });

    // 消费侧标记 DEAD + 告警位
    await svc.markInboxDead(inboxId, 'illegal_transition:CREATED→REFUNDED');
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM payment.inbox WHERE id = $1`,
      [inboxId],
    );
    expect(row.rows[0]!.status).toBe('DEAD');
    expect(sink.alerts.length).toBe(1);
    expect(sink.alerts[0]!.kind).toBe('CALLBACK_DEAD');
    expect(sink.alerts[0]!.inboxId).toBe(inboxId);

    // PAY_SUCCESS 后到：照常入箱+消费
    const pay = signedBody(payCallbackBody(order, 'MOCK-WECHAT-900009'));
    const payIn = await svc.ingestCallback('wechat_ecom', pay.raw, pay.signature);
    expect(payIn.inboxed).toBe(true);
    await svc.markFrozen(order.id, 'MOCK-WECHAT-900009');
    await svc.markInboxConsumed(payIn.inbox_id!);
    const consumed = await pool.query<{ status: string; consumed_at: Date | null }>(
      `SELECT status, consumed_at FROM payment.inbox WHERE id = $1`,
      [payIn.inbox_id],
    );
    expect(consumed.rows[0]!.status).toBe('CONSUMED');
    expect(consumed.rows[0]!.consumed_at).not.toBeNull();

    // STL：order 侧一拒（CREATED→REFUNDED 非法）；inbox 侧两笔均合法（RECEIVED→DEAD / RECEIVED→CONSUMED）
    const orderStl = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log WHERE entity_type = 'payment_order' AND entity_id = $1`,
      [order.id],
    );
    expect(orderStl.rows[0]!.allowed).toBe(false);
    const stl = await pool.query<{ allowed: boolean; entity_type: string }>(
      `SELECT allowed, entity_type FROM platform.state_transition_log WHERE entity_type = 'payment_inbox' ORDER BY id`,
    );
    expect(stl.rows.map((r) => r.allowed)).toEqual([true, true]);
  });

  it('形态防御：未知通道 404 / 签名对但体非 JSON、缺字段 → 400 / 未知支付单 → 404 / CONSUMED 再 DEAD 被拒', async () => {
    const order = await createOrder();
    await expect(svc.ingestCallback('union_pay', Buffer.from('{}'), null)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });

    const badJson = Buffer.from('not-json', 'utf8');
    const badSig = createHmac('sha256', cfg.primary.secret).update(badJson).digest('hex');
    await expect(svc.ingestCallback('wechat_ecom', badJson, badSig)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });

    const missing = signedBody({ order_id: order.id });
    await expect(
      svc.ingestCallback('wechat_ecom', missing.raw, missing.signature),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });

    const ghost = signedBody({
      order_id: 999999,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'T-1',
    });
    await expect(
      svc.ingestCallback('wechat_ecom', ghost.raw, ghost.signature),
    ).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });

    // 备通道密钥验签：alipay 通道用 backup secret
    const aliBody = {
      order_id: order.id,
      event_type: 'PAY_SUCCESS',
      channel_txn_no: 'MOCK-ALIPAY-900010',
    };
    const aliSigned = signedBody(aliBody, cfg.backup.secret);
    const ali = await svc.ingestCallback('alipay', aliSigned.raw, aliSigned.signature);
    expect(ali.inboxed).toBe(true);
    await svc.markInboxConsumed(ali.inbox_id!);
    await expect(svc.markInboxDead(ali.inbox_id!, 'late')).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
    });

    // timingSafeEqual 形态自检（本 spec 驱动器与实现同构）
    expect(
      timingSafeEqual(
        Buffer.from(signedBody(payCallbackBody(order, 'T')).signature),
        Buffer.from(signedBody(payCallbackBody(order, 'T')).signature),
      ),
    ).toBe(true);
    expect(AppError).toBeDefined();
  });
});
