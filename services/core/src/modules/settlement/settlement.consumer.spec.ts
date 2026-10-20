import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  ATTENDANCE_ADJUDICATED_TOPIC,
  FIRM_MERCHANT_ACTIVATED_TOPIC,
  FIRM_MERCHANT_SUSPENDED_TOPIC,
  ONE_ON_ONE_SETTLED_TOPIC,
  ROOM_CLOSED_TOPIC,
  SPLIT_SETTLED_TOPIC,
  TICKET_RESOLVED_TOPIC,
  type AttendanceAdjudicatedPayload,
  type FirmMerchantActivatedPayload,
  type FirmMerchantSuspendedPayload,
  type OneOnOneSettledPayload,
  type RoomClosedPayload,
  type TicketResolvedPayload,
} from '@ljr/shared';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { MockPhoneAlertSink, SchedulerAlertService } from '../schedule/scheduler-alerts';
import { SchedulerService } from '../schedule/scheduler.service';
import { ChannelRouter, MockChannelAdapter } from '../payment/payment.channels';
import { PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from '../payment/payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from '../payment/payment.alerts';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import type { FirmMerchantConfig } from '../payment/firm-merchant.config';
import { FirmMerchantService } from '../payment/firm-merchant.service';
import type { PaymentOrderView } from '../payment/payment.types';
import { countLedgersByDirection, getPaymentOrderById } from '../payment/order-fixture';
import { seedFirmMerchant, setFirmMerchantStatus } from '../payment/firm-merchant.fixture';
import { countJobLogsByResult } from '../schedule/job-fixture';
import { OpenTicketGate } from './settlement.gate';
import { SettlementConsumer, createRoomClosedHandler } from './settlement.consumer';
import { SettlementJobExecutors } from './settlement.executors';
import { SettlementService } from './settlement.service';

/**
 * F3 事件消费端端到端（§6；W3 可达面=合成事件桩+A3b/I2 真通路；测试直投 outbox 沿 T2/T6 先例）：
 *   - RoomClosed/OneOnOneSettled（D1/D6=M2 合成桩）→ 进结算 PENDING→HOLD；
 *   - AttendanceAdjudicated（D3=M2 合成桩）→ R-03 缺席 70/30 触发位；
 *   - FirmMerchantSuspended/Activated（A3b 真事件）→ R-07 挂起/恢复重驱动；
 *   - TicketResolved（H3=M2 合成桩）→ HOLD 释放；
 *   - SETTLE_HOLD_RELEASE（I2 真通路：scheduler tick 时间注入）→ 24h 到期自动放行（§10-1）。
 */

const DAY = Date.UTC(2026, 9, 16, 8, 0, 0);
const LAWYER = 9101;
const FIRM = 31;

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

const MERCHANT_CONFIG: FirmMerchantConfig = { depositAmount: '500.00', reverifyDays: 365 };

describe('F3 事件消费端（需 PG）', () => {
  let pool: Pool;
  let poolSvc: PgPoolService;
  let outbox: OutboxService;
  let payment: PaymentGatewayService;
  let merchants: FirmMerchantService;
  let scheduler: SchedulerService;
  let executors: ScheduleExecutorRegistry;
  let settlements: SettlementService;
  let relay: OutboxRelayService;
  let wechat: MockChannelAdapter;
  let alipay: MockChannelAdapter;
  let routerNow = DAY;
  let orderSeq = 0;

  const createPaidOrder = async (cash = '100.00'): Promise<PaymentOrderView> => {
    orderSeq += 1;
    const res = await payment.createOrder({
      biz_type: 'enroll',
      biz_id: 700 + orderSeq,
      cash_amount: cash,
      points_amount: 0,
      idempotency_key: `payment/f3c-order-${orderSeq}/pay`,
    });
    await payment.markFrozen(res.payment_order.id, `MOCK-WECHAT-F3C-${orderSeq}`);
    await payment.markPaid(res.payment_order.id);
    return res.payment_order;
  };

  /** 合成事件直投（D1/D6/D3/H3=M2 生产方桩等价物；事件真出箱走 relay） */
  const recordEvent = async (topic: string, payload: unknown): Promise<void> => {
    await poolSvc.withTransaction((uow) => outbox.recordOutbox(uow, { type: topic, payload }));
  };

  const roomClosed = (over?: Partial<RoomClosedPayload>): RoomClosedPayload => ({
    session_id: 801,
    lawyer_id: LAWYER,
    firm_id: FIRM,
    gross: '100.00',
    payment_order_id: 1,
    ...over,
  });

  const getRow = async (refType: string, refId: number) =>
    (
      await pool.query<Record<string, unknown>>(
        `SELECT id::int AS id, status, hold_reason, share_mode, net::text AS net
           FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
        [refType, refId],
      )
    ).rows[0];

  const travelCreated = async (refId: number): Promise<void> => {
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_id = $1`,
      [refId],
    );
  };

  /** I2 job 时间注入（schedule_jobs 禁直改——经 I2 API cancel+按过去时刻重注册） */
  const travelJob = async (settlementRowId: number): Promise<void> => {
    await scheduler.cancelJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: settlementRowId,
    });
    await scheduler.registerJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: settlementRowId,
      dueAt: new Date(Date.now() - 1_000),
    });
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    wechat = new MockChannelAdapter(
      'wechat_ecom',
      'mock-wechat-mch',
      'test-secret-w',
      () => new Date(DAY),
    );
    alipay = new MockChannelAdapter(
      'alipay',
      'mock-alipay-mch',
      'test-secret-a',
      () => new Date(DAY),
    );
    poolSvc = new PgPoolService(pool);
    outbox = new OutboxService();
    const guard = new StateTransitionGuardService(new StateTransitionLogService(), poolSvc);
    // 路由钟可变（⑨ F-2 用例推过降级窗口：300s 内存窗 + 固定钟会让故障消除后的重试仍拒）
    routerNow = DAY;
    const router = new ChannelRouter({
      adapters: [wechat, alipay],
      switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
      now: () => routerNow,
    });
    payment = new PaymentGatewayService(
      poolSvc,
      outbox,
      guard,
      router,
      new PaymentAlertService(new MockPaymentAlertSink()),
      testConfig(),
    );
    executors = new ScheduleExecutorRegistry();
    scheduler = new SchedulerService(
      poolSvc,
      outbox,
      guard,
      executors,
      new SchedulerAlertService(new MockPhoneAlertSink()),
      { batch: 10, backoffMs: () => 0 }, // 退避零化：job 重试路径（⑩ F-2 round2 执行器链）在测试内即时可达
    );
    merchants = new FirmMerchantService(
      poolSvc,
      outbox,
      guard,
      scheduler,
      [wechat, alipay],
      MERCHANT_CONFIG,
    );
    const gate = new OpenTicketGate();
    settlements = new SettlementService(
      poolSvc,
      outbox,
      guard,
      scheduler,
      gate,
      merchants,
      payment,
    );
    // 退避零化：重试路径（F-2 READY 滞留重驱动）在测试内即时可达
    relay = new OutboxRelayService(poolSvc, { batch: 50, maxRetry: 2, backoffMs: () => 0 });
    new SettlementJobExecutors(executors, settlements).onModuleInit();
    new SettlementConsumer(relay, settlements).onModuleInit();
  });

  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    routerNow = DAY;
  });
  afterEach(async () => {
    await truncateAll(pool);
    wechat.fault = null;
    alipay.fault = null;
  });

  it('① §10-1 时间注入全链：RoomClosed 直投 → HOLD+job；24h 内 tick 不放行；到期 tick → READY→SETTLED（F1 SPLIT+SplitSettled）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await recordEvent(ROOM_CLOSED_TOPIC, roomClosed({ payment_order_id: order.id }));
    await relay.tick();

    const held = await getRow('session', 801);
    expect(held).toMatchObject({ status: 'HOLD', hold_reason: 'HOLD_24H' });

    // 24h 内：job 未到期不拾取（§10-1 前半：HOLD 24h 内不分账）
    const early = await scheduler.tick();
    expect(early.done).toBe(0);
    expect((await getRow('session', 801))!.status).toBe('HOLD');

    // 时间注入：冻结期锚回拨 + job 按过去时刻重注册 → I2 tick 真通路放行
    await travelCreated(801);
    await travelJob(held!.id as number);
    const fired = await scheduler.tick();
    expect(fired.done).toBe(1);

    const settled = await getRow('session', 801);
    expect(settled!.status).toBe('SETTLED'); // READY→SETTLED 由执行器链内完成（R-01 唯一解冻节点）
    expect((await getPaymentOrderById(pool, order.id))['status']).toBe('SPLIT');
    const splitEvents = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [SPLIT_SETTLED_TOPIC],
    );
    expect(splitEvents.rows).toHaveLength(1);
    expect(splitEvents.rows[0]!.payload).toMatchObject({ ref_id: 801, net: '100.00', fee: '0.00' });
  });

  it('② RoomClosed 重复投递幂等：UNIQUE(ref) 短路不重建（at-least-once 语义）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await recordEvent(
      ROOM_CLOSED_TOPIC,
      roomClosed({ session_id: 802, payment_order_id: order.id }),
    );
    await relay.tick();
    await recordEvent(
      ROOM_CLOSED_TOPIC,
      roomClosed({ session_id: 802, payment_order_id: order.id }),
    );
    await relay.tick();
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM settlement.settlements`,
    );
    expect(n.rows[0]!.n).toBe(1);
    const events = await pool.query<{ status: string }>(
      `SELECT status FROM platform.outbox WHERE topic = $1`,
      [ROOM_CLOSED_TOPIC],
    );
    expect(events.rows.every((r) => r.status === 'SENT')).toBe(true);
  });

  it('③ 载荷防御：RoomClosed 缺字段 → 抛错进重试轨道（不静默丢弃）', async () => {
    await recordEvent(ROOM_CLOSED_TOPIC, { session_id: 803 } as unknown as RoomClosedPayload);
    const tick = await relay.tick();
    expect(tick.retried).toBe(1);
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM settlement.settlements`,
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('④ OneOnOneSettled 直投（D6=M2 桩；真链转正=M2-W3 T3 集成用例锚——one-on-one.spec「真链两端到端」以服务真生产事件驱动本消费面，本单点桩保留验证消费器幂等，不删不改断言）：ref_type=one_on_one 落表（§10-6 前半）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('80.00');
    const payload: OneOnOneSettledPayload = {
      order_id: 501,
      lawyer_id: LAWYER,
      firm_id: FIRM,
      gross: '80.00',
      net: '80.00',
      payment_order_id: order.id,
    };
    await recordEvent(ONE_ON_ONE_SETTLED_TOPIC, payload);
    await relay.tick();
    expect(await getRow('one_on_one', 501)).toMatchObject({ status: 'HOLD' });
  });

  it('⑤ AttendanceAdjudicated 直投（D3=M2 桩）：user+absent 切 70/30；normal/late 与律师缺席 no-op', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await recordEvent(
      ROOM_CLOSED_TOPIC,
      roomClosed({ session_id: 804, payment_order_id: order.id }),
    );
    await relay.tick();
    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, {
      adjudication_id: 1,
      session_id: 804,
      owner_type: 'lawyer',
      owner_id: LAWYER,
      result: 'absent',
    } satisfies AttendanceAdjudicatedPayload);
    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, {
      adjudication_id: 2,
      session_id: 804,
      owner_type: 'user',
      owner_id: 601,
      result: 'normal',
    } satisfies AttendanceAdjudicatedPayload);
    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, {
      adjudication_id: 3,
      session_id: 804,
      owner_type: 'user',
      owner_id: 602,
      result: 'absent',
    } satisfies AttendanceAdjudicatedPayload);
    await relay.tick();
    expect(await getRow('session', 804)).toMatchObject({ share_mode: 'ABSENCE_7030' });
  });

  it('⑥ FirmMerchantSuspended/Activated（A3b 真事件）：挂起全量 SUSPENDED；恢复重驱动 READY→SETTLED', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await recordEvent(
      ROOM_CLOSED_TOPIC,
      roomClosed({ session_id: 805, payment_order_id: order.id }),
    );
    await relay.tick();
    await travelCreated(805);

    await recordEvent(FIRM_MERCHANT_SUSPENDED_TOPIC, {
      firm_id: FIRM,
      channel: 'wechat_ecom',
      reason: 'ACCOUNT_CHANGING',
    } satisfies FirmMerchantSuspendedPayload);
    await relay.tick();
    expect(await getRow('session', 805)).toMatchObject({
      status: 'SUSPENDED',
      hold_reason: 'MERCHANT_NOT_ACTIVE',
    });

    // 恢复（R-W3-C2：变更完成 →ACTIVE）：READY 化 + 消费链重驱动分账
    await setFirmMerchantStatus(pool, FIRM, 'ACTIVE');
    await recordEvent(FIRM_MERCHANT_ACTIVATED_TOPIC, {
      firm_id: FIRM,
      channel: 'wechat_ecom',
    } satisfies FirmMerchantActivatedPayload);
    await relay.tick();
    expect((await getRow('session', 805))!.status).toBe('SETTLED');
    expect(await countLedgersByDirection(pool, 'SPLIT')).toBe(1); // CONFIRMED 恒等（唯一一笔分账）
  });

  it('⑦ TicketResolved 直投（H3=M2 桩）：24h 内不释放；冻结期满后释放并结算', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await recordEvent(
      ROOM_CLOSED_TOPIC,
      roomClosed({ session_id: 806, payment_order_id: order.id }),
    );
    await relay.tick();
    const held = await getRow('session', 806);

    await recordEvent(TICKET_RESOLVED_TOPIC, {
      ticket_id: 3001,
      ref_type: 'session',
      ref_id: 806,
    } satisfies TicketResolvedPayload);
    await relay.tick();
    expect((await getRow('session', 806))!.status).toBe('HOLD'); // 冻结期未满仅闭工单不放行

    await travelCreated(806);
    await recordEvent(TICKET_RESOLVED_TOPIC, {
      ticket_id: 3002,
      ref_type: 'session',
      ref_id: 806,
    } satisfies TicketResolvedPayload);
    await relay.tick();
    expect((await getRow('session', 806))!.status).toBe('SETTLED'); // 释放+重驱动链
    expect(held).toBeDefined();
  });

  it('⑧ handler 工厂直调：非注册 topic 显性拒绝（防错接）', async () => {
    const handler = createRoomClosedHandler(settlements);
    await expect(
      handler({ id: 1, eventId: 'e', topic: 'trade.session.failed', payload: {}, retryCount: 0 }, {
        query: async () => ({ rows: [], rowCount: 0 }),
      } as never),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' });
  });

  it('⑨ F-2 READY 滞留重驱动：释放后结算首跳失败（双通道故障）→ relay 重试经 READY 直驱补结算', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await recordEvent(
      ROOM_CLOSED_TOPIC,
      roomClosed({ session_id: 807, payment_order_id: order.id }),
    );
    await relay.tick();
    await travelCreated(807);

    // 首跳：工单释放成功（READY 已提交），分账指令双通道故障 → handler 抛错进重试轨道
    wechat.fault = { kind: 'CHANNEL_ERROR' };
    alipay.fault = { kind: 'CHANNEL_ERROR' };
    await recordEvent(TICKET_RESOLVED_TOPIC, {
      ticket_id: 3003,
      ref_type: 'session',
      ref_id: 807,
    } satisfies TicketResolvedPayload);
    const first = await relay.tick();
    // 3=retried：TicketResolved 结算首跳失败 + SettlementHeld/Released 暂无消费方（H4=M2 位）入重试轨道
    expect(first.retried).toBe(3);
    expect(await getRow('session', 807)).toMatchObject({ status: 'READY' }); // READY 滞留面

    // 故障消除 → 重试路径：对已 READY 行直驱补结算（F-2 修复位；未修=恒滞留 READY）
    wechat.fault = null;
    alipay.fault = null;
    routerNow = DAY + PAYMENT_SWITCH_WINDOW_MS_DEFAULT + 1_000; // 推过降级窗口（路由内存态）
    const second = await relay.tick();
    expect(second.dispatched).toBe(1); // TicketResolved 重试直驱补结算（SENT）
    expect((await getRow('session', 807))!.status).toBe('SETTLED');
    expect((await getPaymentOrderById(pool, order.id))['status']).toBe('SPLIT');
  });

  it('⑩ F-2 round2 执行器链：24h 到期释放后结算首跳失败→整体回滚自 HOLD，job 重试补结算（无 READY 滞留）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await recordEvent(
      ROOM_CLOSED_TOPIC,
      roomClosed({ session_id: 808, payment_order_id: order.id }),
    );
    await relay.tick();
    await travelCreated(808);
    const held = await getRow('session', 808);
    await travelJob(held!.id as number);

    // 首跳：抢占事务内释放+结算——结算抛 E_CHANNEL_UNAVAILABLE 须整体回滚到 HOLD（FIRM_REVERIFY 范式）
    wechat.fault = { kind: 'CHANNEL_ERROR' };
    alipay.fault = { kind: 'CHANNEL_ERROR' };
    const first = await scheduler.tick();
    expect(first.retried).toBe(1); // job 退避重试（未 DONE 未 CANCELLED）
    expect(await getRow('session', 808)).toMatchObject({ status: 'HOLD' }); // 未滞留 READY（回滚复位）

    // 故障消除 → 重试：释放+结算同占抢事务补齐 → DONE
    wechat.fault = null;
    alipay.fault = null;
    routerNow = DAY + PAYMENT_SWITCH_WINDOW_MS_DEFAULT + 1_000;
    const second = await scheduler.tick();
    expect(second.done).toBe(1);
    expect((await getRow('session', 808))!.status).toBe('SETTLED');
    expect((await getPaymentOrderById(pool, order.id))['status']).toBe('SPLIT');
    expect(await countJobLogsByResult(pool, 'SETTLE_HOLD_RELEASE', 'DONE')).toBe(1); // 重试补齐 DONE（log 只记真实发生的重试）
  });
});
