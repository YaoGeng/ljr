import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppError } from '@ljr/shared';
import { truncateAll, ensureTestDatabase } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { PAYMENT_CONFIG, type PaymentConfig } from '../payment/payment.config';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from '../payment/payment.channels';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from '../payment/firm-merchant.config';
import { PricingConfigService } from '../pricing/pricing.service';
import { PriceChangeService } from '../pricing/price-change.service';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { RuleCenterService } from './rule-center.service';
import { seedSessionRaw } from '../trade/trade-fixture';
import { METRIC_CATALOG, PRICE_STABILITY_INDEX_KEY, type MetricsResponse } from './metrics.types';
import { MetricsModule } from './metrics.module';
import { MetricsService } from './metrics.service';
import { counterIncrementsFor } from './metrics.consumer';

/**
 * H4 指标管道（§9 口径锁定：每指标≥1 已知输入→期望值；R-03 重放不双计；查询面分组/窗口）。
 *
 * owner 纪律：本 spec 直查面=ops 域两新表（owner）+ platform.outbox（白名单）；C6 真链夹具
 * 经 trade fixture / pricing 服务面（跨域只 import 不内联他域表名——lawyer-admin.http.spec 同款）。
 * 消费链=真 relay（recordEvent→outbox→tick→MetricsConsumer），非直调 handler——消费注册/
 * 载荷校验/去重全链覆盖。
 */

const LAWYER = 9701; // 律师（identity 侧用户 id 直用——事件载荷数值锚，无身份回查）
const USER_A = 9801;
const USER_B = 9802;

const VALID_1V1 = {
  text: { per_round: '250.00' },
  voice: { per_15min: '200.00' },
  video: { per_15min: '300.00' },
};

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

/** credit.rules 种子（credit.spec 同款承载值；G1 扇出面解锁用——分值语义归 credit.spec 锁定） */
const RULES_SEED: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    user_participated: { delta: 2 },
    user_cancel_early: { delta: -5, violation: true },
    user_cancel_late: { delta: -15, violation: true },
    user_absent: { delta: -30, violation: true },
    lawyer_participated: { delta: 2 },
    lawyer_cancel_24h_plus: { delta: -10, violation: true },
    lawyer_cancel_under_24h: { delta: -30, violation: true },
    lawyer_absent: { delta: -50, violation: true },
    lawyer_price_up: { delta: -5 },
    lawyer_price_down_le10: { delta: -15 },
    lawyer_price_down_gt10: { delta: -30 },
    review_received: { delta: 2 },
  },
};

/** 上海日 YYYY-MM-DD（与聚合 SQL 同口径：now() AT TIME ZONE 'Asia/Shanghai'） */
function shanghaiToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function shanghaiDayOffset(days: number): string {
  return new Date(Date.now() + 8 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10);
}

describe('H4 指标管道（§9 口径锁定 + R-03 + 查询面，需 PG）', () => {
  let pool: Pool;
  let poolSvc: PgPoolService;
  let app: INestApplication;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let metrics: MetricsService;
  let priceChange: PriceChangeService;
  let b3: PricingConfigService;
  let rules: RuleCenterService;

  const recordEvent = async (
    topic: string,
    payload: unknown,
    eventId?: string,
  ): Promise<string> => {
    return poolSvc.withTransaction(async (uow) => {
      const r = await outbox.recordOutbox(uow, { type: topic, payload, eventId });
      return r.eventId;
    });
  };

  /**
   * 直达消费路径（counterIncrementsFor+applyEvent）：用于**同 topic 扇出的他域消费面在本
   * 夹具下必失败**的事件（SESSION_CANCELLED→F2 退款需真支付单；REFUND_COMPLETED→C3 需真
   * 报名行）——relay 单事务扇出会整体回滚进重试轨道（诊断实证），口径锁定走等价直达路径
   * （与 handler 同两步：校验+映射 → 去重+聚合；relay 投递形态由可净跑 topic 的真链用例覆盖）。
   */
  const consumeDirect = async (topic: string, payload: unknown): Promise<void> => {
    const increments = counterIncrementsFor(topic, payload);
    await poolSvc.withTransaction((uow) =>
      metrics.applyEvent(uow, { eventId: randomUUID(), topic }, increments),
    );
  };

  const consumedCount = async (): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ops.events_consumed`,
    );
    return Number(r.rows[0]!.n);
  };

  const counterValue = async (key: string, dim = ''): Promise<number> => {
    const r = await pool.query<{ v: string }>(
      `SELECT value::text AS v FROM ops.metrics_daily WHERE metric_key = $1 AND dim = $2`,
      [key, dim],
    );
    return r.rows[0] ? Number(r.rows[0]!.v) : 0;
  };

  /** 指标键→值速查 */
  const valueOf = (res: MetricsResponse, key: string): number | null | undefined =>
    res.metrics.find((m) => m.key === key)?.value;

  // —— 已知输入事件载荷（真实契约形状，最小字段） ——
  const sessionCreated = (id: number) => ({
    id,
    lawyer_id: LAWYER,
    slot_start: '2026-10-20T12:00:00Z',
    enroll_deadline: '2026-10-19T12:00:00Z',
  });
  const sessionFull = (id: number) => ({
    id,
    lawyer_id: LAWYER,
    slot_start: '2026-10-20T12:00:00Z',
    price_mode: 'per_head',
    unit_price: '100.00',
    session_total: '500.00',
  });
  const gbPublished = (id: number) => ({
    id,
    lawyer_id: LAWYER,
    slot_start: '2026-10-21T12:00:00Z',
    sub_min: 3,
    share_price: '100.00',
  });
  const adjudicated = (userId: number, result: 'normal' | 'late' | 'absent') => ({
    adjudication_id: userId * 100 + 7,
    session_id: 500,
    owner_type: 'user' as const,
    owner_id: userId,
    result,
  });
  const roomClosed = (sessionId: number, lawyerId: number) => ({
    session_id: sessionId,
    lawyer_id: lawyerId,
    firm_id: 41,
    gross: '400.00',
    payment_order_id: 6001,
  });
  const review = (overall: number, professional: number) => ({
    session_id: 500,
    direction: 'user_to_lawyer' as const,
    dims: { professional, response: 5, attitude: 5, overall },
    reviewee_user_id: LAWYER,
  });
  const enrollmentPaid = (userId: number, refId: number) => ({
    ref_type: 'session' as const,
    ref_id: refId,
    user_id: userId,
    amounts: { paid: '100.00', cash: '100.00', points: 0 },
  });
  const ticketCreated = (id: number, category: string) => ({
    ticket_id: id,
    category,
    sla_due: '2026-10-21T12:00:00Z',
    priority: 3,
  });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [MetricsModule] })
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
    poolSvc = app.get(PgPoolService);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxRelayService);
    metrics = app.get(MetricsService);
    priceChange = app.get(PriceChangeService);
    b3 = app.get(PricingConfigService);
    rules = app.get(RuleCenterService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    // credit.rules 生效版种子（H7 免公示通道，credit.spec 同款）：G1 消费面与本管道同 topic
    // 扇出（ATTENDANCE_ADJUDICATED/REVIEW_SUBMITTED/SESSION_CANCELLED/PRICE_CHANGE_APPROVED），
    // 无生效版本时 G1 handler 显性化报错→整事务回滚→本管道计数连带失败（诊断实证）。
    await poolSvc.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: RULES_SEED,
        effectiveAt: new Date(Date.now() - 10 * 86_400_000),
      }),
    );
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ===========================================================================
  // 核心 7（§2/§7.2 映射表口径锁定：每指标已知输入→期望值）
  // ===========================================================================

  it('核心组：拼单成团率 B2C/C2B 分列 + 用户发起拼团成团率（成团÷创建）', async () => {
    // B2C：2 创建 1 满员成团 → 0.5；C2B/用户发起：2 发布 1 达 sub_min → 0.5（同源事件同值）
    await recordEvent('trade.session.created', sessionCreated(101));
    await recordEvent('trade.session.created', sessionCreated(102));
    await recordEvent('trade.session.full', sessionFull(101));
    await recordEvent('trade.group_buy.published', gbPublished(201));
    await recordEvent('trade.group_buy.published', gbPublished(202));
    await recordEvent('trade.group_buy.reached', { id: 201 });
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'group_buy_rate_b2c')).toBe(0.5);
    expect(valueOf(res, 'group_buy_rate_c2b')).toBe(0.5);
    expect(valueOf(res, 'user_group_buy_rate')).toBe(0.5); // 02 §7.2 两行同源（group_buys 状态分布）
  });

  it('修复环 C-1：B2C 成团率不受 C4 事件束污染（载荷无 mode——算术推导分列）+取消率分母去双计', async () => {
    // 真实 C4 事件束（group-buy-response.service 实证）：confirm=SessionCreated+SessionFull+
    // LawyerConfirmed 三件同事务（createC2BFulfillment+markFull）；convert=SessionCreated+
    // GroupBuyConverted 两件（无 markFull）。B2C 开团 3 场 1 满员 + confirm×2 + convert×1：
    //   Σ(session_created)=3+2+1=6 → b2cCreated=6−2−1=3；Σ(session_full)=1+2=3 → b2cFull=3−2=1
    //   ⇒ B2C 成团率=1/3（未修正的污染口径 Σfull/Σcreated=3/6=0.5 必须被推开）
    for (const id of [111, 112, 113]) {
      await recordEvent('trade.session.created', sessionCreated(id));
    }
    await recordEvent('trade.session.full', sessionFull(111));
    for (const [gb, sid] of [
      [301, 211],
      [302, 212],
    ] as const) {
      await recordEvent('trade.session.created', sessionCreated(sid)); // confirm 生成场次
      await recordEvent('trade.session.full', sessionFull(sid)); // 「满员即成团」同事务出箱
      await recordEvent('trade.group_buy.lawyer_confirmed', {
        gb_id: gb,
        session_id: sid,
        lawyer_id: LAWYER,
      });
    }
    await recordEvent('trade.session.created', sessionCreated(213)); // convert 生成场次
    await recordEvent('trade.group_buy.converted', {
      gb_id: 303,
      session_id: 213,
      capacity: 5,
      migrated_users: [USER_A],
    });
    await relay.tick();
    await relay.tick(); // 本用例 11 事件>单轮 batch 10——两轮清空（relay 单轮上限语义）

    const core = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(core, 'group_buy_rate_b2c')).toBeCloseTo(1 / 3, 4); // 算术推导分列（非 0.5）
    expect(await counterValue('session_created')).toBe(6); // 全域计数=C4 束入账的证据

    // 取消率分母=Σ(session_created)=6（去双计：禁再叠加 confirm/converted 计数成 9）
    await consumeDirect('fulfillment.session.cancelled', {
      session_id: 111,
      cancelled_by: 'user',
      cancelled_by_user_id: USER_A,
      cancelled_at: '2026-10-18T10:00:00Z',
      session_start_at: '2026-10-20T12:00:00Z',
    });
    const health = await metrics.getMetrics({ group: 'health' });
    expect(valueOf(health, 'cancel_rate')).toBeCloseTo(1 / 6, 4);
  });

  it('核心组：到场率/准时到场率/缺席率（attendances.status 三态；律师行不计入用户分母）', async () => {
    // 4 用户判定：2 normal + 1 late + 1 absent → 到场(normal+late)=0.75 准时=0.5 缺席=0.25；
    // 律师判定行=已消费不计数（用户口径分母不含律师）
    for (const [uid, result] of [
      [9801, 'normal'],
      [9802, 'normal'],
      [9803, 'late'],
      [9804, 'absent'],
    ] as const) {
      await recordEvent('fulfillment.attendance.adjudicated', adjudicated(uid, result));
    }
    await recordEvent('fulfillment.attendance.adjudicated', {
      adjudication_id: 9,
      session_id: 500,
      owner_type: 'lawyer',
      owner_id: LAWYER,
      result: 'normal',
    });
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'attendance_rate')).toBe(0.75);
    expect(valueOf(res, 'punctual_attendance_rate')).toBe(0.5);
    expect(valueOf(res, 'absence_rate')).toBe(0.25);
    expect(await counterValue('attendance_judged', 'role:user')).toBe(4);
  });

  it('核心组：1对1转化率（分子=OneOnOnePaid 真事件流 D6=M2-W3 转真；分母=到场用户行可算面近似，桩注记）', async () => {
    await recordEvent('fulfillment.attendance.adjudicated', adjudicated(USER_A, 'normal'));
    await recordEvent('fulfillment.attendance.adjudicated', adjudicated(USER_B, 'normal'));
    await recordEvent('fulfillment.attendance.adjudicated', adjudicated(9809, 'absent')); // 未参与不计分母
    await recordEvent('fulfillment.one_on_one.paid', {
      order_id: 501,
      user_id: USER_A,
      lawyer_id: LAWYER,
    });
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'one_on_one_conversion_rate')).toBe(0.5); // 1÷(normal+late=2)
    const m = res.metrics.find((x) => x.key === 'one_on_one_conversion_rate')!;
    expect(m.stub).toContain('可算面'); // 近似口径显式（不静默）
  });

  it('核心组：律师人效·房间数（ROOM_CLOSED 按 lawyer dim 计数）；房间时长=桩位（载荷无时刻）', async () => {
    await recordEvent('fulfillment.room.closed', roomClosed(501, LAWYER));
    await recordEvent('fulfillment.room.closed', roomClosed(502, LAWYER));
    await recordEvent('fulfillment.room.closed', roomClosed(503, 9702));
    await relay.tick();

    expect(await counterValue('room_closed', `lawyer:${LAWYER}`)).toBe(2);
    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'lawyer_room_count')).toBe(3);
    expect(valueOf(res, 'lawyer_room_avg_duration_min')).toBeNull(); // W1 契约无 opened_at/closed_at
  });

  it('核心组：草稿采用率（M2-W3 T4 桩转真：采用（send|edit_send）÷生成——02 §7.2 action 分布口径）', async () => {
    // 已知输入：3 生成 + send/edit_send/discard 各 1 → 采用率 2/3；action 分布 dim 各 1
    for (const id of [71, 72, 73]) {
      await recordEvent('agent_assist.draft.generated', {
        draft_id: id,
        room_id: 3001,
        conversation_id: 88,
        target_user_id: USER_A,
        latency_ms: 412,
        segment_ms: { sanitize: 5, intent: 3, rag: 120, llm: 280 },
      });
    }
    await recordEvent('agent_assist.draft.actioned', {
      draft_id: 71,
      room_id: 3001,
      action: 'send',
      review_ms: 8_400,
    });
    await recordEvent('agent_assist.draft.actioned', {
      draft_id: 72,
      room_id: 3001,
      action: 'edit_send',
      review_ms: 15_000,
    });
    await recordEvent('agent_assist.draft.actioned', {
      draft_id: 73,
      room_id: 3001,
      action: 'discard',
      review_ms: 900,
    });
    await relay.tick();

    expect(await counterValue('draft_generated')).toBe(3);
    expect(await counterValue('draft_adopted')).toBe(2); // discard 不计分子
    for (const action of ['send', 'edit_send', 'discard']) {
      expect(await counterValue('draft_actioned', `action:${action}`)).toBe(1);
    }
    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'draft_adoption_rate')).toBe(0.6667); // 2÷3 四位舍入
    const m = res.metrics.find((x) => x.key === 'draft_adoption_rate')!;
    expect(m.stub).toBeNull(); // 桩注记清除（真口径）
  });

  it('核心组：满意度四维均值（§7.2「用户满意度」=user_to_lawyer 方向；lawyer_to_user 留 dim 不入均值）', async () => {
    // 修复环 I-1：2 笔用户评律师（overall 5/3）+1 笔律师评用户（overall 1，各维=1）——
    // 满意度均值只取 user_to_lawyer 半边（律师侧计数留 dim 供后续口径，不污染均值）
    await recordEvent('review.review.submitted', review(5, 4));
    await recordEvent('review.review.submitted', review(3, 4));
    await recordEvent('review.review.submitted', {
      session_id: 500,
      direction: 'lawyer_to_user',
      dims: { professional: 1, response: 1, attitude: 1, overall: 1 },
      reviewee_user_id: USER_A,
    });
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'satisfaction_avg_overall')).toBe(4); // (5+3)/2——非 (5+3+1)/3=3
    expect(valueOf(res, 'satisfaction_avg_professional')).toBe(4);
    expect(valueOf(res, 'satisfaction_avg_response')).toBe(5);
    expect(valueOf(res, 'satisfaction_avg_attitude')).toBe(5);
    // 双方向计数均留痕（direction dim 切分）
    expect(await counterValue('review_submitted', 'direction:user_to_lawyer')).toBe(2);
    expect(await counterValue('review_submitted', 'direction:lawyer_to_user')).toBe(1);
  });

  it('核心组：复购率（enrollments 按 user 去重：同 user 二次 EnrollmentPaid 为复购）', async () => {
    await recordEvent('trade.enrollment.paid', enrollmentPaid(USER_A, 301));
    await recordEvent('trade.enrollment.paid', enrollmentPaid(USER_A, 302)); // A 复购
    await recordEvent('trade.enrollment.paid', enrollmentPaid(USER_B, 303));
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'repurchase_rate')).toBe(0.5); // 1 复购用户 / 2 付费用户
    expect(await counterValue('enrollment_paid', `user:${USER_A}`)).toBe(2);
  });

  // ===========================================================================
  // 健康 11
  // ===========================================================================

  it('健康组：纠纷率（tickets dispute÷订单）与退款率（refunds÷订单；订单口径=EnrollmentPaid）', async () => {
    for (const refId of [301, 302, 303, 304]) {
      await recordEvent('trade.enrollment.paid', enrollmentPaid(USER_A, refId));
    }
    await recordEvent('ops.ticket.created', ticketCreated(1, 'dispute'));
    await recordEvent('ops.ticket.created', ticketCreated(2, 'dead_letter')); // 非 dispute 不入分子
    // REFUND_COMPLETED 同 topic 扇出面（C3 状态推进）在本夹具下需真报名行——直达消费（见 helper 注）
    await consumeDirect('payment.refund.completed', {
      refund_id: 11,
      order_id: 301,
      amounts: { cash: '100.00', points: 0 },
    });
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'health' });
    expect(valueOf(res, 'dispute_rate')).toBe(0.25);
    expect(valueOf(res, 'refund_rate')).toBe(0.25);
    expect(await counterValue('ticket_created', 'category:dispute')).toBe(1);
  });

  it('健康组：取消率（SessionCancelled÷Σsession_created——每次场次创建恰发一次，去双计）与缺席半边', async () => {
    // 真实事件束形态：B2C 开团 ×2（SessionCreated×2）+ C4 confirm 束（SessionCreated+
    // SessionFull+LawyerConfirmed）+ C4 convert 束（SessionCreated+GroupBuyConverted）
    await recordEvent('trade.session.created', sessionCreated(101));
    await recordEvent('trade.session.created', sessionCreated(102));
    await recordEvent('trade.session.created', sessionCreated(103)); // confirm 生成场次
    await recordEvent('trade.session.full', sessionFull(103));
    await recordEvent('trade.group_buy.lawyer_confirmed', {
      gb_id: 201,
      session_id: 103,
      lawyer_id: LAWYER,
    });
    await recordEvent('trade.session.created', sessionCreated(104)); // convert 生成场次
    await recordEvent('trade.group_buy.converted', {
      gb_id: 202,
      session_id: 104,
      capacity: 5,
      migrated_users: [USER_A],
    });
    // SESSION_CANCELLED 同 topic 扇出面（F2 退款指令）在本夹具下需真支付单——直达消费（见 helper 注）
    await consumeDirect('fulfillment.session.cancelled', {
      session_id: 101,
      cancelled_by: 'user',
      cancelled_by_user_id: USER_A,
      cancelled_at: '2026-10-18T10:00:00Z',
      session_start_at: '2026-10-20T12:00:00Z',
    });
    await recordEvent('fulfillment.attendance.adjudicated', adjudicated(USER_A, 'absent'));
    await recordEvent('fulfillment.attendance.adjudicated', adjudicated(USER_B, 'normal'));
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'health' });
    // Σ(session_created)=4（双计形态 4+1+1=6 禁用——修复环 C-1 去双计断言）
    expect(valueOf(res, 'cancel_rate')).toBe(0.25); // 1 取消 / 4 次场次创建
    expect(valueOf(res, 'absence_rate')).toBe(0.5); // 取消/缺席率的缺席半边（同 core 口径）
  });

  it('健康组：改价频率（PRICE_CHANGE_APPROVED 计数）', async () => {
    for (const pc of [11, 12, 13]) {
      await recordEvent('pricing.price_change.approved', {
        price_change_id: pc,
        lawyer_id: LAWYER,
        kind: 'PRICE_DOWN_LE10',
      });
    }
    await relay.tick();
    const res = await metrics.getMetrics({ group: 'health' });
    expect(valueOf(res, 'price_change_frequency')).toBe(3);
  });

  it('健康组：补偿发放率（分子=POINTS_GRANTED kind=COMPENSATION 事件；分母=comp_snapshots 真源）', async () => {
    // C6 真链：在团降价恰 10%（100→90）× 两名已支付用户 → approve 生效 → 2 快照 + 2 授予事件
    await b3.putPricing(LAWYER, {
      base_version: 0,
      per_head: '100.00',
      session_total: null,
      group_size: 5,
      accept_min: 3,
      accept_max: 8,
      room_modes: ['text'],
      one_on_one_prices: VALID_1V1,
    });
    await seedSessionRaw(pool, LAWYER, 'CREATED', 40, {
      userId: USER_A,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedSessionRaw(pool, LAWYER, 'CREATED', 41, {
      userId: USER_B,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const req = await priceChange.requestChange(LAWYER, {
      base_version: 1,
      per_head: '90.00',
      session_total: null,
      group_size: 5,
      accept_min: 3,
      accept_max: 8,
      room_modes: ['text'],
      one_on_one_prices: VALID_1V1,
    });
    expect(req.result).toBe('PENDING_APPROVAL');
    await priceChange.approve(req.history_id, { approved: true, approval_id: 1 });
    await relay.tick(); // 消费生效链出箱事件（POINTS_GRANTED×2 + PRICE_CHANGE_APPROVED）

    expect(await counterValue('comp_points_granted')).toBe(2);
    const res = await metrics.getMetrics({ group: 'health' });
    expect(valueOf(res, 'compensation_grant_rate')).toBe(1); // 2 授予 / 2 快照

    // 分子=纯事件计数（口径锁定）：再投 1 笔合成 COMPENSATION 授予 → 3/2
    await recordEvent('benefits.points.granted', {
      user_id: 9999,
      delta: 50,
      kind: 'COMPENSATION',
      ref: 'synthetic:metrics-spec',
      balance_after: 50,
    });
    await recordEvent('benefits.points.granted', {
      user_id: 9998,
      delta: 30,
      kind: 'ABSENCE_SHARE', // 非 COMPENSATION 不入分子
      ref: 'absence:500',
      balance_after: 30,
    });
    await relay.tick();
    const res2 = await metrics.getMetrics({ group: 'health' });
    expect(valueOf(res2, 'compensation_grant_rate')).toBe(1.5);
  });

  it('健康组：改价后投诉率（price_change 类工单 7 天日窗内关联改价——近似口径注记）', async () => {
    for (const [pc, lawyer] of [
      [11, LAWYER],
      [12, LAWYER],
      [13, 9702],
    ] as const) {
      await recordEvent('pricing.price_change.approved', {
        price_change_id: pc,
        lawyer_id: lawyer,
        kind: 'PRICE_UP',
      });
    }
    // 同日 1 笔 price_change 类工单（与今日改价日重叠 → 关联）；1 笔 dispute 不入分子
    await recordEvent('ops.ticket.created', ticketCreated(1, 'price_change'));
    await recordEvent('ops.ticket.created', ticketCreated(2, 'dispute'));
    await relay.tick();

    const res = await metrics.getMetrics({ group: 'health' });
    expect(valueOf(res, 'post_price_change_complaint_rate')).toBeCloseTo(1 / 3, 4);
    const m = res.metrics.find((x) => x.key === 'post_price_change_complaint_rate')!;
    expect(m.stub).toContain('近似');
  });

  it('健康组：桩位四项（留存/房间时长/1对1满意度/1对1纠纷）与价格稳定性指数显式排除', async () => {
    const res = await metrics.getMetrics({ group: 'health' });
    expect(valueOf(res, 'lawyer_retention_rate')).toBeNull();
    expect(valueOf(res, 'room_avg_duration_min')).toBeNull();
    expect(valueOf(res, 'one_on_one_satisfaction_rate')).toBeNull();
    expect(valueOf(res, 'one_on_one_dispute_rate')).toBeNull();
    // 价格稳定性指数（04 §8 #8）：目录注册（hidden 位）但查询面不展示
    expect(res.metrics.map((m) => m.key)).not.toContain(PRICE_STABILITY_INDEX_KEY);
    const catalog = METRIC_CATALOG.find((m) => m.key === PRICE_STABILITY_INDEX_KEY);
    expect(catalog).toMatchObject({ group: 'health', hidden: true });
    // 核心组同样不含隐藏键
    const core = await metrics.getMetrics({ group: 'core' });
    expect(core.metrics.map((m) => m.key)).not.toContain(PRICE_STABILITY_INDEX_KEY);
  });

  // ===========================================================================
  // R-03 重放不双计（event_id 去重表唯一承载，§6/§7）
  // ===========================================================================

  it('R-03 事件重放 N=3 次指标不变（outbox 重投 + handler 级重放均短路）', async () => {
    const eventId = await recordEvent(
      'trade.session.created',
      sessionCreated(101),
      '11111111-2222-3333-4444-555555555555',
    );
    const t1 = await relay.tick();
    expect(t1.dispatched).toBe(1);
    expect(await counterValue('session_created')).toBe(1);

    // 重放 1：outbox 行重置 PENDING → relay 再投（at-least-once 崩溃窗语义）
    await pool.query(`UPDATE platform.outbox SET status = 'PENDING' WHERE event_id = $1`, [
      eventId,
    ]);
    const t2 = await relay.tick();
    expect(t2.dispatched).toBe(1); // 投递成功（SENT 标记照走）
    expect(await counterValue('session_created')).toBe(1); // 指标不变
    expect(await consumedCount()).toBe(1);

    // 重放 2/3：handler 级直调（等价任意次数重投）
    const increments = counterIncrementsFor('trade.session.created', sessionCreated(101));
    for (let i = 0; i < 2; i += 1) {
      await poolSvc.withTransaction((uow) =>
        metrics.applyEvent(uow, { eventId, topic: 'trade.session.created' }, increments),
      );
    }
    expect(await counterValue('session_created')).toBe(1);
    expect(await consumedCount()).toBe(1);
  });

  it('载荷非法进 relay 重试轨道：零去重行零计数（先插后聚合同事务，失败不半计）', async () => {
    await recordEvent('trade.enrollment.paid', { ref_type: 'session', ref_id: 'x' }); // 形状非法
    const t = await relay.tick();
    expect(t.retried).toBeGreaterThanOrEqual(1);
    expect(await consumedCount()).toBe(0);
    expect(await counterValue('enrollment_paid')).toBe(0);
    const n = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ops.metrics_daily`);
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  // ===========================================================================
  // 查询面：分组过滤 / 窗口 from-to / 无样本分母
  // ===========================================================================

  it('分组过滤：core 不含健康键、health 不含核心键（absence_rate 双列注记）', async () => {
    const core = await metrics.getMetrics({ group: 'core' });
    const health = await metrics.getMetrics({ group: 'health' });
    const coreKeys = new Set(core.metrics.map((m) => m.key));
    const healthKeys = new Set(health.metrics.map((m) => m.key));
    expect(coreKeys.has('dispute_rate')).toBe(false);
    expect(coreKeys.has('group_buy_rate_b2c')).toBe(true);
    expect(healthKeys.has('group_buy_rate_b2c')).toBe(false);
    expect(healthKeys.has('dispute_rate')).toBe(true);
    expect(coreKeys.has('absence_rate')).toBe(true); // 到场率/缺席率=核心
    expect(healthKeys.has('absence_rate')).toBe(true); // 取消/缺席率的缺席半边=健康
    // M-4：双列必须同值（同一计数器对 absent÷judged——目录双条目注记钉住，禁单侧改口径）
    expect(valueOf(health, 'absence_rate')).toBe(valueOf(core, 'absence_rate'));
  });

  it('窗口 from/to：按 day 过滤（右闭含 to；缺省=全量）', async () => {
    const today = shanghaiToday();
    const dayMinus2 = shanghaiDayOffset(2);
    const dayMinus1 = shanghaiDayOffset(1);
    // 直插日表（窗口语义单测：消费路径 day=上海今日，另由消费用例覆盖）
    const rows: Array<[string, number, number]> = [
      // [day, created, full]
      [dayMinus2, 1, 0],
      [dayMinus1, 2, 1],
      [today, 4, 1],
    ];
    for (const [day, created, full] of rows) {
      if (created > 0) {
        await pool.query(
          `INSERT INTO ops.metrics_daily (metric_key, dim, day, value) VALUES ('session_created', '', $1::date, $2)`,
          [day, created],
        );
      }
      if (full > 0) {
        await pool.query(
          `INSERT INTO ops.metrics_daily (metric_key, dim, day, value) VALUES ('session_full', '', $1::date, $2)`,
          [day, full],
        );
      }
    }
    // 窗口 [day-1, today]：created=2+4=6，full=1+1=2 → 1/3
    const win = await metrics.getMetrics({ group: 'core', from: dayMinus1, to: today });
    expect(valueOf(win, 'group_buy_rate_b2c')).toBeCloseTo(2 / 6, 4);
    // 缺省全量：created=7，full=2 → 2/7
    const all = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(all, 'group_buy_rate_b2c')).toBeCloseTo(2 / 7, 4);
    // 只含今日：4 与 1 → 0.25
    const todayOnly = await metrics.getMetrics({ group: 'core', from: today, to: today });
    expect(valueOf(todayOnly, 'group_buy_rate_b2c')).toBe(0.25);
  });

  it('无样本：分母 0 的比率=null（不除零），计数=0', async () => {
    const res = await metrics.getMetrics({ group: 'core' });
    expect(valueOf(res, 'group_buy_rate_b2c')).toBeNull();
    expect(valueOf(res, 'attendance_rate')).toBeNull();
    expect(valueOf(res, 'repurchase_rate')).toBeNull();
    expect(valueOf(res, 'lawyer_room_count')).toBe(0);
    expect(valueOf(res, 'satisfaction_avg_overall')).toBeNull();
  });

  it('窗口校验：from>to 或单边给出=400（InvalidArgument）', async () => {
    await expect(
      metrics.getMetrics({ group: 'core', from: '2026-10-10', to: '2026-10-01' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(metrics.getMetrics({ group: 'core', from: '2026-10-01' })).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(metrics.getMetrics({ group: 'core', to: '2026-10-01' })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  // ===========================================================================
  // 登记位消费（A.1/H4 消费面：记 events_consumed，无 W2 指标不发明口径）
  // ===========================================================================

  it('登记位 topic：RESCHEDULE_CONFIRMED/COUPON_GRANTED/ROOM_IN_SERVICE/REMINDER_DISPATCHED 消费留痕零计数', async () => {
    await recordEvent('trade.reschedule.confirmed', {
      old_enrollment_id: 1,
      new_enrollment_id: 2,
      session_id: 3,
      user_id: USER_A,
    });
    await recordEvent('benefits.coupon.granted', {
      grant_id: 1,
      user_id: USER_A,
      coupon_id: 1,
      face_value: '20.00',
      expires_at: '2026-11-01T00:00:00Z',
    });
    await recordEvent('fulfillment.room.in_service', { room_id: 1, session_id: 500 });
    await recordEvent('notify.reminder.dispatched', {
      ref_type: 'enrollment',
      ref_id: 1,
      user_id: USER_A,
      kind: 'REMIND_24H',
    });
    await relay.tick();

    expect(await consumedCount()).toBe(4);
    const n = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ops.metrics_daily`);
    expect(Number(n.rows[0]!.n)).toBe(0);
  });
});
