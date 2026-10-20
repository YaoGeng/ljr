import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  LAWYER_REJECTED_TOPIC,
  PAYMENT_CALLBACK_INBOXED_TOPIC,
  REFUND_SOURCE_REF_TYPE_GROUPBUY,
  SESSION_CANCELLED_TOPIC,
  SESSION_FAILED_TOPIC,
  type LawyerRejectedPayload,
  type SessionCancelledPayload,
  type SessionFailedPayload,
} from '@ljr/shared';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { BenefitsConfig, POINTS_TTL_DAYS_DEFAULT } from '../benefits/benefits.config';
import { PointsService } from '../benefits/points.service';
import { ReserveService } from '../benefits/reserve.service';
import { listRefundRestoreTxns, seedPointsBalance } from '../benefits/points-fixture';
import { ChannelRouter, MockChannelAdapter } from './payment.channels';
import { PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from './payment.alerts';
import { PaymentGatewayService } from './payment.gateway.service';
import {
  RefundConsumer,
  createLawyerRejectedRefundHandler,
  createRefundCallbackHandler,
  createSessionCancelledRefundHandler,
  createSessionFailedHandler,
} from './refund.consumer';
import { RefundService } from './refund.service';
import { RefundSourceRegistry } from './refund.source';
import type { RefundSource, RefundSourceOrder } from '@ljr/shared';
import type { PaymentOrderView } from './payment.types';

/**
 * F2 批量退款消费端（§2 批量/R-W3-M 裁决/§10 验收）：
 *   SessionFailed 消费器（付款人清单经 RefundSource 注册表——T6 假源跑全流程、无源注册 warn
 *   跳过不炸、部分失败可重入续跑）+ REFUND_SUCCESS 回调消费器（F1 Inbox 既有出口，PAY_SUCCESS
 *   noop 待 C3=T7）+ SessionCancelled 取消全额退款（M2-W2 T3）+ LawyerRejected 拼团拒绝/超时
 *   全员退款（I-1=M2-W3 T1：'groupbuy' 源、reason 按 via_timeout 映射、G1 同 topic 双消费并存）。
 *   §10 全链用例经假源+真 F1/F4：SessionFailed → 全员全额退款 → 真回调 → DONE+积分单还原。
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

describe('RefundSourceRegistry（R-W3-M 注册表形态）', () => {
  it('register/resolve 按注册键存取；未注册键 resolve=null（消费端 warn 跳过的依据）', () => {
    const registry = new RefundSourceRegistry();
    expect(registry.resolve('session')).toBeNull();
    const fake: RefundSource = { listPaidPaymentOrders: async () => [] };
    registry.register('session', fake);
    expect(registry.resolve('session')).toBe(fake);
    expect(registry.resolve('groupbuy')).toBeNull();
  });
});

describe('F2 批量退款消费端（需 PG）', () => {
  let pool: Pool;
  let poolSvc: PgPoolService;
  let cfg: PaymentConfig;
  let gateway: PaymentGatewayService;
  let refunds: RefundService;
  let registry: RefundSourceRegistry;
  let relay: OutboxRelayService;
  let outbox: OutboxService;
  let seq = 0;

  const createPaidOrder = async (opts?: {
    cash?: string;
    points?: number;
  }): Promise<PaymentOrderView> => {
    seq += 1;
    const res = await gateway.createOrder({
      biz_type: 'enroll',
      biz_id: 500 + seq,
      cash_amount: opts?.cash ?? '100.00',
      points_amount: opts?.points ?? 0,
      idempotency_key: `payment/f2c-order-${seq}/pay`,
    });
    await gateway.markFrozen(res.payment_order.id, `MOCK-WECHAT-F2C-${seq}`);
    return res.payment_order;
  };

  /** 夹具：SessionFailed 事件真实出箱（C1 ENROLL_DEADLINE 执行器等价物） */
  const recordSessionFailed = async (sessionId: number): Promise<void> => {
    const payload: SessionFailedPayload = {
      id: sessionId,
      lawyer_id: 9101,
      slot_start: '2026-10-20T02:00:00.000Z',
      price_mode: 'per_head',
      unit_price: '100.00',
      session_total: '100.00',
      reason: 'ENROLL_DEADLINE_PASSED',
    };
    await poolSvc.withTransaction((uow) =>
      outbox.recordOutbox(uow, { type: SESSION_FAILED_TOPIC, payload }),
    );
  };

  /** 真回调驱动器：签发 REFUND_SUCCESS 报文走 F1 ingestCallback（验签→Inbox→事件出箱） */
  const ingestRefundSuccess = async (order: PaymentOrderView) => {
    const raw = Buffer.from(
      JSON.stringify({
        order_id: order.id,
        event_type: 'REFUND_SUCCESS',
        channel_txn_no: `MOCK-WECHAT-RF-${order.id}`,
        amount: '0',
      }),
      'utf8',
    );
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', cfg.primary.secret).update(raw).digest('hex');
    return gateway.ingestCallback('wechat_ecom', raw, signature);
  };

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
    poolSvc = new PgPoolService(pool);
    outbox = new OutboxService();
    const guard = new StateTransitionGuardService(new StateTransitionLogService(), poolSvc);
    gateway = new PaymentGatewayService(
      poolSvc,
      outbox,
      guard,
      router,
      new PaymentAlertService(new MockPaymentAlertSink()),
      cfg,
    );
    const points = new PointsService(poolSvc, outbox, new ReserveService(outbox), {
      pointsTtlDays: POINTS_TTL_DAYS_DEFAULT,
    } satisfies BenefitsConfig);
    refunds = new RefundService(poolSvc, outbox, guard, gateway, points);
    registry = new RefundSourceRegistry();
    relay = new OutboxRelayService(poolSvc, { batch: 50, maxRetry: 2 });
    new RefundConsumer(relay, refunds, registry, gateway).onModuleInit();
  });

  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('§10 流标批量全员退款（经假源+真 F1/F4 全链）：全员全额（含积分单还原）、回调推进 DONE、inbox CONSUMED', async () => {
    const payerA = await createPaidOrder({ cash: '100.00', points: 0 });
    const payerB = await createPaidOrder({ cash: '60.00', points: 4000 });
    const source: RefundSource = {
      listPaidPaymentOrders: async () => [
        {
          payment_order_id: payerA.id,
          user_id: 601,
          cash_amount: payerA.cash_amount,
          points_amount: payerA.points_amount,
        },
        {
          payment_order_id: payerB.id,
          user_id: 602,
          cash_amount: payerB.cash_amount,
          points_amount: payerB.points_amount,
        },
      ],
    };
    registry.register('session', source);
    await seedPointsBalance(pool, 602, 0);

    await recordSessionFailed(501);
    const tick = await relay.tick();
    expect(tick.dispatched).toBe(1);

    // 全员全额受理：退款额=原支付拆分（现金+积分逐字段），F1 单在途 REFUNDING
    const rows = await pool.query<{
      payment_order_id: number;
      user_id: number;
      cash_amount: string;
      points_amount: number;
      status: string;
      reason: string;
    }>(`SELECT payment_order_id::int AS payment_order_id, user_id::int AS user_id,
                cash_amount::text AS cash_amount, points_amount,
                status, reason FROM payment.refunds ORDER BY id`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      payment_order_id: payerA.id,
      user_id: 601,
      cash_amount: '100.00',
      points_amount: 0,
      status: 'PROCESSING',
      reason: 'GROUP_FAIL',
    });
    expect(rows.rows[1]).toMatchObject({
      payment_order_id: payerB.id,
      user_id: 602,
      cash_amount: '60.00',
      points_amount: 4000,
      status: 'PROCESSING',
    });
    const funding = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.payment_orders WHERE status = 'REFUNDING'`,
    );
    expect(funding.rows[0]!.n).toBe(2);

    // 通道真回调 → relay 二次 tick → 消费收敛：DONE + F1 单 REFUNDED + RefundCompleted×2 + 还原
    await ingestRefundSuccess(payerA);
    await ingestRefundSuccess(payerB);
    const tick2 = await relay.tick();
    expect(tick2.dispatched).toBe(2);

    const done = await pool.query<{ status: string }>(
      `SELECT status FROM payment.refunds ORDER BY id`,
    );
    expect(done.rows.map((r) => r.status)).toEqual(['DONE', 'DONE']);
    const refunded = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.payment_orders WHERE status = 'REFUNDED'`,
    );
    expect(refunded.rows[0]!.n).toBe(2);
    const completed = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = 'payment.refund.completed'`,
    );
    expect(completed.rows[0]!.n).toBe(2);
    const restore = await listRefundRestoreTxns(pool);
    expect(restore).toHaveLength(1);
    expect(restore[0]!.delta).toBe(4000); // 积分单还原恰一次；现金绝不折积分
    const inbox = await pool.query<{ status: string }>(`SELECT status FROM payment.inbox`);
    expect(inbox.rows.every((r) => r.status === 'CONSUMED')).toBe(true);
  });

  it('R-W3-M 无源注册：warn 跳过不炸（handler 正常返回，零退款行，事件可 SENT）', async () => {
    await recordSessionFailed(502);
    const tick = await relay.tick();
    expect(tick.dispatched).toBe(1); // handler 正常返回 → SENT（不进重试轨道）
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`);
    expect(n.rows[0]!.n).toBe(0);
  });

  /** handler 直调的第二参（relay 认领事务 client 桩）：SessionFailed/回调 noop 路径不触 uow */
  const stubUow = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

  it('载荷防御：SessionFailed 缺 id 抛错进重试轨道（不静默丢弃）', async () => {
    const handler = createSessionFailedHandler(refunds, registry);
    await expect(
      handler(
        { id: 1, eventId: 'e', topic: SESSION_FAILED_TOPIC, payload: {}, retryCount: 0 },
        stubUow,
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
  });

  it('§10 部分失败批次可重入续跑：逐单独立事务，重入只补未 DONE 单（幂等键防重不重复）', async () => {
    const payerA = await createPaidOrder();
    const ghostId = payerA.id + 100000; // 首轮失败源：第二单不存在（受理面 404 注入）
    const payerC = await createPaidOrder();
    const source: RefundSource = {
      listPaidPaymentOrders: async () => [
        {
          payment_order_id: payerA.id,
          user_id: 601,
          cash_amount: payerA.cash_amount,
          points_amount: payerA.points_amount,
        },
        { payment_order_id: ghostId, user_id: 602, cash_amount: '50.00', points_amount: 0 },
        {
          payment_order_id: payerC.id,
          user_id: 603,
          cash_amount: payerC.cash_amount,
          points_amount: payerC.points_amount,
        },
      ],
    };
    registry.register('session', source);
    const handler = createSessionFailedHandler(refunds, registry);

    // 首轮：ghost 单失败 → handler 抛错（relay 语义=进重试轨道），A/C 已逐单落单
    await expect(
      handler(
        {
          id: 2,
          eventId: 'e',
          topic: SESSION_FAILED_TOPIC,
          payload: { id: 503 } as unknown as SessionFailedPayload,
          retryCount: 0,
        },
        stubUow,
      ),
    ).rejects.toMatchObject({ code: 'E_OUTBOX_HANDLER_FAILED' });
    let rows = await pool.query<{ payment_order_id: number }>(
      `SELECT payment_order_id::int AS payment_order_id FROM payment.refunds ORDER BY payment_order_id`,
    );
    expect(rows.rows.map((r) => r.payment_order_id)).toEqual([payerA.id, payerC.id]);

    // 重入：ghost 单落库补齐（新单换 id 到 ghost 槽位，已 FROZEN 可退）→ 续跑只补未受理单；
    // 已落单的幂等重放不重复
    const payerB = await createPaidOrder();
    await pool.query(`UPDATE payment.payment_orders SET id = $1 WHERE id = $2`, [
      ghostId,
      payerB.id,
    ]);
    await handler(
      {
        id: 3,
        eventId: 'e',
        topic: SESSION_FAILED_TOPIC,
        payload: { id: 503 } as unknown as SessionFailedPayload,
        retryCount: 1,
      },
      stubUow,
    );

    rows = await pool.query<{ payment_order_id: number }>(
      `SELECT payment_order_id::int AS payment_order_id FROM payment.refunds ORDER BY payment_order_id`,
    );
    expect(rows.rows.map((r) => r.payment_order_id)).toEqual([payerA.id, payerC.id, ghostId]);
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`);
    expect(n.rows[0]!.n).toBe(3); // 每单恰一笔（幂等键防重）
  });

  it('回调消费面过滤：PAY_SUCCESS 事件 noop（C3=T7 消费位），不动 refunds/inbox', async () => {
    const order = await createPaidOrder();
    const handler = createRefundCallbackHandler(refunds, gateway);
    const raw = Buffer.from(
      JSON.stringify({
        order_id: order.id,
        event_type: 'PAY_SUCCESS',
        channel_txn_no: 'MOCK-WECHAT-PAY-NOOP',
      }),
      'utf8',
    );
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', cfg.primary.secret).update(raw).digest('hex');
    await gateway.ingestCallback('wechat_ecom', raw, signature);
    const before = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.inbox WHERE status = 'RECEIVED'`,
    );

    await handler(
      {
        id: 4,
        eventId: 'e',
        topic: PAYMENT_CALLBACK_INBOXED_TOPIC,
        payload: {
          biz_idempotency_key: `${order.idempotency_key}:PAY_SUCCESS`,
          event: 'PAY_SUCCESS',
        },
        retryCount: 0,
      },
      stubUow,
    );

    const after = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.inbox WHERE status = 'RECEIVED'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n); // RECEIVED 原样（消费权归 C3）
    const refundsN = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.refunds`,
    );
    expect(refundsN.rows[0]!.n).toBe(0);
  });

  it('Minor-4：回调未知事件（允许清单外）→ warn 显性化不抛（防毒丸），REFUND_SUCCESS 路径不受影响', async () => {
    const handler = createRefundCallbackHandler(refunds, gateway);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      // 允许清单外事件：warn + 正常返回（不抛→relay 不会重投毒消息）
      await expect(
        handler(
          {
            id: 5,
            eventId: 'e5',
            topic: PAYMENT_CALLBACK_INBOXED_TOPIC,
            payload: {
              biz_idempotency_key: 'payment/unknown-1/pay:WEIRD_HOOK',
              event: 'WEIRD_HOOK',
            },
            retryCount: 0,
          },
          stubUow,
        ),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('未知回调事件');

      // 已知允许集（PAY_SUCCESS）保持 log 级 noop，不走 warn
      warnSpy.mockClear();
      await handler(
        {
          id: 6,
          eventId: 'e6',
          topic: PAYMENT_CALLBACK_INBOXED_TOPIC,
          payload: {
            biz_idempotency_key: 'payment/unknown-2/pay:PAY_SUCCESS',
            event: 'PAY_SUCCESS',
          },
          retryCount: 0,
        },
        stubUow,
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
    const refundsN = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.refunds`,
    );
    expect(refundsN.rows[0]!.n).toBe(0);
  });

  // --------------------------------------------------------------------------
  // SessionCancelled 全额退款 handler（M2-W2 T3，D4 取消真链；双路径之全额路径）
  // --------------------------------------------------------------------------

  it('SessionCancelled 消费：全员全额受理（CANCEL_RULE / refund/po-{id}/session-cancel 键）+幂等键防重', async () => {
    const payerA = await createPaidOrder({ cash: '100.00', points: 0 });
    const payerB = await createPaidOrder({ cash: '60.00', points: 4000 });
    const source: RefundSource = {
      listPaidPaymentOrders: async () => [
        {
          payment_order_id: payerA.id,
          user_id: 611,
          cash_amount: payerA.cash_amount,
          points_amount: payerA.points_amount,
        },
        {
          payment_order_id: payerB.id,
          user_id: 612,
          cash_amount: payerB.cash_amount,
          points_amount: payerB.points_amount,
        },
      ],
    };
    registry.register('session', source);
    await seedPointsBalance(pool, 612, 0);

    const handler = createSessionCancelledRefundHandler(refunds, registry);
    await handler(
      {
        id: 7,
        eventId: 'e7',
        topic: SESSION_CANCELLED_TOPIC,
        payload: {
          session_id: 601,
          cancelled_by: 'platform',
          cancelled_by_user_id: null,
          cancelled_at: new Date().toISOString(),
          session_start_at: new Date().toISOString(),
        } as unknown as SessionCancelledPayload,
        retryCount: 0,
      },
      stubUow,
    );
    const rows = await pool.query<{
      payment_order_id: number;
      cash_amount: string;
      points_amount: number;
      reason: string;
      idempotency_key: string;
    }>(
      `SELECT payment_order_id::int AS payment_order_id, cash_amount::text AS cash_amount,
              points_amount, reason, idempotency_key FROM payment.refunds ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      payment_order_id: payerA.id,
      cash_amount: '100.00',
      points_amount: 0,
      reason: 'CANCEL_RULE',
      idempotency_key: `refund/po-${payerA.id}/session-cancel`,
    });
    expect(rows.rows[1]).toMatchObject({
      payment_order_id: payerB.id,
      cash_amount: '60.00',
      points_amount: 4000, // 积分部分原额还原（R-03 口径同 GROUP_FAIL 链）
    });

    // 幂等键防重：重放（relay at-least-once 重投）→ 受理面同键重放不重复
    await handler(
      {
        id: 8,
        eventId: 'e8',
        topic: SESSION_CANCELLED_TOPIC,
        payload: {
          session_id: 601,
          cancelled_by: 'platform',
          cancelled_by_user_id: null,
          cancelled_at: new Date().toISOString(),
          session_start_at: new Date().toISOString(),
        } as unknown as SessionCancelledPayload,
        retryCount: 0,
      },
      stubUow,
    );
    expect(
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`)).rows[0]!
        .n,
    ).toBe(2);
  });

  it('SessionCancelled 载荷防御：缺 session_id / cancelled_by 越域 → 抛错进重试轨道（不静默丢弃）', async () => {
    const handler = createSessionCancelledRefundHandler(refunds, registry);
    await expect(
      handler(
        { id: 9, eventId: 'e9', topic: SESSION_CANCELLED_TOPIC, payload: {}, retryCount: 0 },
        stubUow,
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
    await expect(
      handler(
        {
          id: 10,
          eventId: 'e10',
          topic: SESSION_CANCELLED_TOPIC,
          payload: { session_id: 602, cancelled_by: 'agent' },
          retryCount: 0,
        },
        stubUow,
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
  });

  // --------------------------------------------------------------------------
  // LawyerRejected 拼团拒绝/超时全员退款 handler（I-1=M2-W3 T1）：C4 显式拒 via_timeout=false
  // + C2 12h 确认超时自动拒 via_timeout=true 同 topic 一次覆盖；G1 信用消费同 topic 扇出并存
  // --------------------------------------------------------------------------

  /** 固定清单假源（'groupbuy' 键；形态同既有 session 假源，只是注册键换源） */
  const fakeGroupBuySource = (orders: readonly RefundSourceOrder[]): RefundSource => ({
    listPaidPaymentOrders: async () => orders,
  });

  it('I-1 律师显式拒：全部 PAID 参与者各恰 1 张全额退款单（LAWYER_REJECT / refund/po-{id}/lawyer-rejected 键）+同事件重放幂等短路', async () => {
    const payerA = await createPaidOrder({ cash: '33.33', points: 0 });
    const payerB = await createPaidOrder({ cash: '20.00', points: 1333 });
    registry.register(
      REFUND_SOURCE_REF_TYPE_GROUPBUY,
      fakeGroupBuySource([
        {
          payment_order_id: payerA.id,
          user_id: 621,
          cash_amount: payerA.cash_amount,
          points_amount: payerA.points_amount,
        },
        {
          payment_order_id: payerB.id,
          user_id: 622,
          cash_amount: payerB.cash_amount,
          points_amount: payerB.points_amount,
        },
      ]),
    );
    const handler = createLawyerRejectedRefundHandler(refunds, registry);
    const event = {
      id: 20,
      eventId: 'e20',
      topic: LAWYER_REJECTED_TOPIC,
      payload: { group_id: 701, lawyer_id: 9101, via_timeout: false } as LawyerRejectedPayload,
      retryCount: 0,
    };
    await handler(event, stubUow);

    // 全员全额：退款额=原支付拆分逐字段（现金+积分），reason=显式拒档
    const rows = await pool.query<{
      payment_order_id: number;
      user_id: number;
      cash_amount: string;
      points_amount: number;
      reason: string;
      idempotency_key: string;
    }>(
      `SELECT payment_order_id::int AS payment_order_id, user_id::int AS user_id,
              cash_amount::text AS cash_amount, points_amount, reason, idempotency_key
         FROM payment.refunds ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      payment_order_id: payerA.id,
      user_id: 621,
      cash_amount: '33.33',
      points_amount: 0,
      reason: 'LAWYER_REJECT',
      idempotency_key: `refund/po-${payerA.id}/lawyer-rejected`,
    });
    expect(rows.rows[1]).toMatchObject({
      payment_order_id: payerB.id,
      user_id: 622,
      cash_amount: '20.00',
      points_amount: 1333,
      reason: 'LAWYER_REJECT',
      idempotency_key: `refund/po-${payerB.id}/lawyer-rejected`,
    });

    // 同事件重放（relay at-least-once 重投）→ 受理面同键同载荷重放原单，不双受理
    await handler({ ...event, id: 21, eventId: 'e21' }, stubUow);
    expect(
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`)).rows[0]!
        .n,
    ).toBe(2);
  });

  it('I-1 确认超时自动拒：via_timeout=true → reason=TIMEOUT（12h 确认窗超时路同 topic 承载）', async () => {
    const payer = await createPaidOrder();
    registry.register(
      REFUND_SOURCE_REF_TYPE_GROUPBUY,
      fakeGroupBuySource([
        {
          payment_order_id: payer.id,
          user_id: 623,
          cash_amount: payer.cash_amount,
          points_amount: payer.points_amount,
        },
      ]),
    );
    const handler = createLawyerRejectedRefundHandler(refunds, registry);
    await handler(
      {
        id: 22,
        eventId: 'e22',
        topic: LAWYER_REJECTED_TOPIC,
        payload: { group_id: 702, lawyer_id: 9101, via_timeout: true } as LawyerRejectedPayload,
        retryCount: 0,
      },
      stubUow,
    );
    const rows = await pool.query<{ reason: string; idempotency_key: string }>(
      `SELECT reason, idempotency_key FROM payment.refunds`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      reason: 'TIMEOUT',
      idempotency_key: `refund/po-${payer.id}/lawyer-rejected`,
    });
  });

  it('I-1 部分受理失败：收集上抛 OutboxHandlerFailed，重入只补未受理单（逐单独立事务断点续跑）', async () => {
    const payerA = await createPaidOrder();
    const ghostId = payerA.id + 100000; // 首轮失败源：第二单不存在（受理面 404 注入）
    const payerC = await createPaidOrder();
    registry.register(
      REFUND_SOURCE_REF_TYPE_GROUPBUY,
      fakeGroupBuySource([
        {
          payment_order_id: payerA.id,
          user_id: 621,
          cash_amount: payerA.cash_amount,
          points_amount: payerA.points_amount,
        },
        { payment_order_id: ghostId, user_id: 622, cash_amount: '50.00', points_amount: 0 },
        {
          payment_order_id: payerC.id,
          user_id: 623,
          cash_amount: payerC.cash_amount,
          points_amount: payerC.points_amount,
        },
      ]),
    );
    const handler = createLawyerRejectedRefundHandler(refunds, registry);
    const event = {
      id: 23,
      eventId: 'e23',
      topic: LAWYER_REJECTED_TOPIC,
      payload: { group_id: 703, lawyer_id: 9101, via_timeout: false } as LawyerRejectedPayload,
      retryCount: 0,
    };

    // 首轮：ghost 单失败 → handler 抛错（relay 语义=进重试轨道），A/C 已逐单落单
    await expect(handler(event, stubUow)).rejects.toMatchObject({
      code: 'E_OUTBOX_HANDLER_FAILED',
    });
    let rows = await pool.query<{ payment_order_id: number }>(
      `SELECT payment_order_id::int AS payment_order_id FROM payment.refunds ORDER BY payment_order_id`,
    );
    expect(rows.rows.map((r) => r.payment_order_id)).toEqual([payerA.id, payerC.id]);

    // 重入：ghost 单落库补齐（新单换 id 到 ghost 槽位）→ 续跑只补未受理单；已落单幂等重放不重复
    const payerB = await createPaidOrder();
    await pool.query(`UPDATE payment.payment_orders SET id = $1 WHERE id = $2`, [
      ghostId,
      payerB.id,
    ]);
    await handler({ ...event, id: 24, eventId: 'e24', retryCount: 1 }, stubUow);
    rows = await pool.query<{ payment_order_id: number }>(
      `SELECT payment_order_id::int AS payment_order_id FROM payment.refunds ORDER BY payment_order_id`,
    );
    expect(rows.rows.map((r) => r.payment_order_id)).toEqual([payerA.id, payerC.id, ghostId]);
    expect(
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`)).rows[0]!
        .n,
    ).toBe(3); // 每单恰一笔（幂等键防重）
  });

  it('I-1 groupbuy 源未注册：warn 跳过不炸（零退款行，事件可 SENT）', async () => {
    const handler = createLawyerRejectedRefundHandler(refunds, registry); // registry 无 groupbuy 源
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        handler(
          {
            id: 25,
            eventId: 'e25',
            topic: LAWYER_REJECTED_TOPIC,
            payload: { group_id: 704, lawyer_id: 9101, via_timeout: true } as LawyerRejectedPayload,
            retryCount: 0,
          },
          stubUow,
        ),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('groupbuy');
    } finally {
      warnSpy.mockRestore();
    }
    const refundsN = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.refunds`,
    );
    expect(refundsN.rows[0]!.n).toBe(0);
  });

  it('I-1 载荷漂移：缺 group_id/lawyer_id、via_timeout 非布尔 → 抛错进重试轨道（不静默丢弃）', async () => {
    const handler = createLawyerRejectedRefundHandler(refunds, registry);
    await expect(
      handler(
        { id: 26, eventId: 'e26', topic: LAWYER_REJECTED_TOPIC, payload: {}, retryCount: 0 },
        stubUow,
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
    await expect(
      handler(
        {
          id: 27,
          eventId: 'e27',
          topic: LAWYER_REJECTED_TOPIC,
          payload: { group_id: 705, lawyer_id: 0, via_timeout: false },
          retryCount: 0,
        },
        stubUow,
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
    await expect(
      handler(
        {
          id: 28,
          eventId: 'e28',
          topic: LAWYER_REJECTED_TOPIC,
          // W1 旧载荷形状兼容位：缺 via_timeout（非布尔）——漂移显性化进重试轨道
          payload: { group_id: 705, lawyer_id: 9101, via_timeout: 'true' },
          retryCount: 0,
        },
        stubUow,
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
    const refundsN = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.refunds`,
    );
    expect(refundsN.rows[0]!.n).toBe(0);
  });

  it('I-1 relay 接线+G1 双消费并存：同 topic 扇出两 handler 互不扰（G1 桩计数 + F2 落退款单）', async () => {
    const payer = await createPaidOrder();
    registry.register(
      REFUND_SOURCE_REF_TYPE_GROUPBUY,
      fakeGroupBuySource([
        {
          payment_order_id: payer.id,
          user_id: 624,
          cash_amount: payer.cash_amount,
          points_amount: payer.points_amount,
        },
      ]),
    );
    // G1 信用消费桩（credit.consumer 同 topic 注册先例）：扇出追加不覆盖，注册序依次执行
    let g1Calls = 0;
    relay.registerHandler(LAWYER_REJECTED_TOPIC, async () => {
      g1Calls += 1;
    });

    const payload: LawyerRejectedPayload = { group_id: 706, lawyer_id: 9101, via_timeout: false };
    await poolSvc.withTransaction((uow) =>
      outbox.recordOutbox(uow, { type: LAWYER_REJECTED_TOPIC, payload }),
    );
    const tick = await relay.tick();
    expect(tick.dispatched).toBe(1);
    expect(g1Calls).toBe(1); // G1 面照常入账（-5 档语义在 credit.spec 回归）

    const rows = await pool.query<{ reason: string; user_id: number }>(
      `SELECT reason, user_id::int AS user_id FROM payment.refunds`,
    );
    expect(rows.rows).toHaveLength(1); // F2 面落单不受 G1 并存影响
    expect(rows.rows[0]).toMatchObject({ reason: 'LAWYER_REJECT', user_id: 624 });
  });
});
