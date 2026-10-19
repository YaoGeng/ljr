import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  RECONCILIATION_DIFF_FOUND_TOPIC,
  ABSENCE_SHARE_DANGLING_TOPIC,
  RESERVE_DIFF_FOUND_TOPIC,
  REFUND_FAILED_TOPIC,
  TICKET_CREATED_TOPIC,
  TICKET_RESOLVED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { PAYMENT_CONFIG, type PaymentConfig } from '../payment/payment.config';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from '../payment/payment.channels';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from '../payment/firm-merchant.config';
import { seedFirmMerchant } from '../payment/firm-merchant.fixture';
import { PriceChangeService } from '../pricing/price-change.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { seedSessionRaw } from '../trade/trade-fixture';
import { travelHoldCreated } from '../settlement/settlement-fixture';
import { OpenTicketGate } from '../settlement/settlement.gate';
import { SettlementModule } from '../settlement/settlement.module';
import { SettlementService } from '../settlement/settlement.service';
import {
  createAbsenceShareDanglingHandler,
  createReconciliationDiffFoundHandler,
  createReserveDiffFoundHandler,
} from './ticket.consumer';
import { TicketService } from './ticket.service';
import { TicketModule } from './ticket.module';
import { TICKET_MACHINE } from './ticket.machine';
import type { RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';

/**
 * H3 纠纷工单 e2e（需 PG）：R-01~R-04 + §9 附加（SLA 计算/审批回调幂等/状态流转）+ §10
 * 验收清单三条。消费面=合成事件直投 outbox 走 relay 真链（settlement.consumer.spec 先例）；
 * R-04 联调=TicketModule+SettlementModule 同装（共享 relay/gate），F3 既有面
 * （enterSettlement/releaseDueHold/TICKET_RESOLVED 消费）承接；工单源生产装配=TicketGate
 * Registration onModuleInit（修复环 I-1：SettlementModule 导出闸，spec 断言生产装配生效）。
 *
 * owner 纪律：本 spec 直查面=ops 域表（owner）+ platform.outbox（白名单）；settlement/pricing
 * 断言走各域导出面与 fixture 函数（跨域只 import、不内联他域表名）。
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** SLA 差值容差（DB now() 同快照推导，读回路径无漂移面；留 2s 吸收驱动抖动） */
const SLA_TOLERANCE_MS = 2_000;

const LAWYER_CB = 9601; // 回调真链律师（在团降价 10% → PENDING_APPROVAL）
const LAWYER_CB2 = 9602; // 回调驳回路径律师
const SESSION_REF = 9001; // R-04 结算实体锚（session ref_id）
const FIRM = 41;
const ADMIN = 8801; // 处置人（identity 侧用户 id 直用——服务层不回查身份，claims 绑定在 HTTP 面）

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

describe('H3 纠纷工单与退款审核（R-01~R-04 + §9/§10，需 PG）', () => {
  let pool: Pool;
  let poolSvc: PgPoolService;
  let app: INestApplication;
  let tickets: TicketService;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let settlements: SettlementService;
  let payment: PaymentGatewayService;
  let priceChange: PriceChangeService;
  let b3: PricingConfigService;

  const recordEvent = async (topic: string, payload: unknown): Promise<void> => {
    await poolSvc.withTransaction((uow) => outbox.recordOutbox(uow, { type: topic, payload }));
  };

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  /** ops.tickets 直读（owner 域）：SLA 差值断言用（毫秒差，避免读回字符串漂移） */
  const slaGapMs = async (ticketId: number): Promise<number> => {
    const res = await pool.query<{ gap: string }>(
      `SELECT (EXTRACT(EPOCH FROM (sla_due - created_at)) * 1000)::bigint::text AS gap
         FROM ops.tickets WHERE id = $1`,
      [ticketId],
    );
    return Number(res.rows[0]!.gap);
  };

  const backdateSla = async (ticketId: number): Promise<void> => {
    await pool.query(`UPDATE ops.tickets SET sla_due = now() - interval '1 hour' WHERE id = $1`, [
      ticketId,
    ]);
  };

  /** 状态机留痕（entity_type='ticket'） */
  const stlOf = async (ticketId: number) => {
    const res = await pool.query<{
      from_status: string | null;
      to_status: string;
      reason: string | null;
    }>(
      `SELECT from_status, to_status, reason FROM platform.state_transition_log
        WHERE entity_type = 'ticket' AND entity_id = $1 ORDER BY id`,
      [ticketId],
    );
    return res.rows;
  };

  /** 在团降价恰 10% → PENDING_APPROVAL 改价历史（C6 真链夹具） */
  const seedPendingPriceChange = async (lawyerId: number, slotSeq: number): Promise<number> => {
    await b3.putPricing(lawyerId, {
      base_version: 0,
      per_head: '100.00',
      session_total: null,
      group_size: 5,
      accept_min: 3,
      accept_max: 8,
      room_modes: ['text'],
      one_on_one_prices: VALID_1V1,
    });
    await seedSessionRaw(pool, lawyerId, 'CREATED', slotSeq); // 在团（CREATED 场次）
    const res = await priceChange.requestChange(lawyerId, {
      base_version: 1,
      per_head: '90.00', // 恰 10.0% 降幅 → PENDING_APPROVAL
      session_total: null,
      group_size: 5,
      accept_min: 3,
      accept_max: 8,
      room_modes: ['text'],
      one_on_one_prices: VALID_1V1,
    });
    expect(res.result).toBe('PENDING_APPROVAL');
    return res.history_id;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TicketModule, SettlementModule] })
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
    tickets = app.get(TicketService);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxRelayService);
    settlements = app.get(SettlementService);
    payment = app.get(PaymentGatewayService);
    priceChange = app.get(PriceChangeService);
    b3 = app.get(PricingConfigService);
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

  // ===========================================================================
  // 状态机词汇（§9：状态流转——禁裸写的机器面锚）
  // ===========================================================================

  it('§9 状态机：OPEN→PROCESSING→RESOLVED/REJECTED 三边；OPEN 无直连终态边（处置必经认领）；非法迁移被守卫拒绝', () => {
    expect(TICKET_MACHINE.def.entityType).toBe('ticket');
    expect(TICKET_MACHINE.canTransition('OPEN', 'PROCESSING')).toBe(true);
    expect(TICKET_MACHINE.canTransition('PROCESSING', 'RESOLVED')).toBe(true);
    expect(TICKET_MACHINE.canTransition('PROCESSING', 'REJECTED')).toBe(true);
    expect(TICKET_MACHINE.canTransition('OPEN', 'RESOLVED')).toBe(false);
    expect(TICKET_MACHINE.canTransition('RESOLVED', 'PROCESSING')).toBe(false);
    expect(() => TICKET_MACHINE.assertTransition('RESOLVED', 'OPEN')).toThrowError(
      expect.objectContaining({ code: ErrorCode.StateIllegalTransition }),
    );
  });

  // ===========================================================================
  // 建单面：人工创建 + 幂等键=category+ref（⚠W2-9）+ ops.ticket.created 出箱
  // ===========================================================================

  it('人工建单：OPEN 落行 + sla_due=created_at+48h（软 SLA）+ ops.ticket.created 出箱（人工 ref 空不携带）', async () => {
    const res = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: SESSION_REF,
      title: '用户申诉：服务未按约定履行',
      detail: '用户主张律师未到场',
    });
    expect(res.created).toBe(true);
    expect(res.ticket).toMatchObject({
      category: 'dispute',
      ref_type: 'session',
      ref_id: SESSION_REF,
      status: 'OPEN',
      priority: 3,
      sla_overdue: false,
    });
    // §2：dispute=其余类 → 48h 软 SLA（锚=created_at DB 钟，同语句推导）
    expect(await slaGapMs(res.ticket.id)).toBeGreaterThan(48 * HOUR_MS - SLA_TOLERANCE_MS);
    expect(await slaGapMs(res.ticket.id)).toBeLessThan(48 * HOUR_MS + SLA_TOLERANCE_MS);
    // §6 建单事件同事务出箱（载荷附录 A.1 冻结形状）
    const events = await outboxOf(TICKET_CREATED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ticket_id: res.ticket.id,
      category: 'dispute',
      ref_type: 'session',
      ref_id: SESSION_REF,
      priority: 3,
    });
    expect(typeof (events[0] as { sla_due: string }).sla_due).toBe('string');
  });

  it('幂等键=category+ref：同键重投短路返回首访工单（created:false 同 id）；人工 ref 空不设幂等（两单并存）', async () => {
    const first = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: SESSION_REF,
      title: '首次',
      detail: 'd',
    });
    const dup = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: SESSION_REF,
      title: '重复事件重放',
      detail: 'd2',
    });
    expect(dup.created).toBe(false);
    expect(dup.ticket.id).toBe(first.ticket.id);
    expect(dup.ticket.title).toBe('首次'); // 首访行不翻案
    // 不同 category 同 ref 不互斥（幂等键含 category）
    const other = await tickets.createTicket({
      category: 'refund_review',
      refType: 'session',
      refId: SESSION_REF,
      title: 'x',
      detail: 'd',
    });
    expect(other.created).toBe(true);
    // ref 空人工工单：无幂等锚
    const a = await tickets.createTicket({ category: 'export_recording', title: 't', detail: 'd' });
    const b = await tickets.createTicket({
      category: 'export_recording',
      title: 't2',
      detail: 'd2',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.ticket.id).not.toBe(b.ticket.id);
  });

  it('建单校验：category 越域/ref 残半/priority 越界均 400', async () => {
    await expect(
      tickets.createTicket({ category: 'unknown' as never, title: 't', detail: 'd' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      tickets.createTicket({ category: 'dispute', refType: 'session', title: 't', detail: 'd' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      tickets.createTicket({ category: 'dispute', title: 't', detail: 'd', priority: 9 }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });

  // ===========================================================================
  // R-01 纠纷处理工单（PRD §7.3）：创建→处置→RESOLVED + 审计行 + F3 释放事件
  // ===========================================================================

  it('R-01 纠纷工单处置：OPEN 认领→RESOLVED（守卫留痕双跳）+ ticket_actions 审计行 + TICKET_RESOLVED 出箱（session ref）', async () => {
    const created = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: SESSION_REF,
      title: '纠纷申诉',
      detail: 'd',
    });
    const ticketId = created.ticket.id;
    const res = await tickets.resolveTicket({
      ticketId,
      operatorId: ADMIN,
      approved: true,
    });
    expect(res.status).toBe('RESOLVED');

    // 详情：终态 + resolved_at + actions 审计行（认领与处置两行）
    const detail = await tickets.getTicketDetail(ticketId);
    expect(detail.ticket.status).toBe('RESOLVED');
    expect(detail.ticket.resolved_at).not.toBeNull();
    expect(detail.actions.map((a) => a.action)).toEqual(['start_processing', 'resolve']);
    expect(detail.actions[0]).toMatchObject({ operator_id: ADMIN, ticket_id: ticketId });
    expect(detail.actions[1]!.payload).toMatchObject({ approved: true });

    // 守卫留痕（STL entity_type='ticket'）：OPEN→PROCESSING→RESOLVED 双跳
    expect(await stlOf(ticketId)).toEqual([
      { from_status: 'OPEN', to_status: 'PROCESSING', reason: 'start_processing' },
      { from_status: 'PROCESSING', to_status: 'RESOLVED', reason: 'resolve' },
    ]);

    // §6：TICKET_RESOLVED 既有 topic 出箱（载荷 shared 逐字——F3 HOLD 释放消费在位）
    const events = await outboxOf(TICKET_RESOLVED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ ticket_id: ticketId, ref_type: 'session', ref_id: SESSION_REF });
  });

  it('R-01 驳回分支：approved=false → REJECTED（决策透传不内嵌资损规则）', async () => {
    const created = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: 9002,
      title: '纠纷申诉（驳回）',
      detail: 'd',
    });
    const res = await tickets.resolveTicket({
      ticketId: created.ticket.id,
      operatorId: ADMIN,
      approved: false,
    });
    expect(res.status).toBe('REJECTED');
    expect(await stlOf(created.ticket.id)).toEqual([
      { from_status: 'OPEN', to_status: 'PROCESSING', reason: 'start_processing' },
      { from_status: 'PROCESSING', to_status: 'REJECTED', reason: 'reject' },
    ]);
    // 非结算实体 ref 也出箱（session 同为结算实体词汇）；REJECTED 同样走 TICKET_RESOLVED
    // （F3 侧释放语义=工单关闭，非审批结果）
    expect(await outboxOf(TICKET_RESOLVED_TOPIC)).toHaveLength(1);
  });

  it('处置幂等键=ticket：终态再处置 409 CLOSED（不翻案）；工单不存在 404', async () => {
    const created = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: 9003,
      title: 't',
      detail: 'd',
    });
    await tickets.resolveTicket({ ticketId: created.ticket.id, operatorId: ADMIN, approved: true });
    await expect(
      tickets.resolveTicket({ ticketId: created.ticket.id, operatorId: ADMIN, approved: true }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict, httpStatus: 409 });
    // 修复环 M-1：终态判定先于 target 校验——已决工单重放携带未注册 target 仍 409 CLOSED（非 400）
    await expect(
      tickets.resolveTicket({
        ticketId: created.ticket.id,
        operatorId: ADMIN,
        approved: true,
        actionPayload: { target: 'd4', cancellation_id: 1 },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict, httpStatus: 409 });
    // 审计行不因重放翻倍（恰一次处置）
    const detail = await tickets.getTicketDetail(created.ticket.id);
    expect(detail.actions).toHaveLength(2);
    await expect(
      tickets.resolveTicket({ ticketId: 999_999, operatorId: ADMIN, approved: true }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  // ===========================================================================
  // R-02 退款审核（律师<24h 取消，PRD §8.6）：d4 回调接线位 + 决策透传面
  // ===========================================================================

  it('R-02 退款审核工单：cancel_lt24h=回调承载类——缺 target 400（I-3：防「审批通过而取消流未生效」）；d4 未注册 400；工单不落终态', async () => {
    const created = await tickets.createTicket({
      category: 'cancel_lt24h',
      refType: 'session',
      refId: 9004,
      title: '律师 <24h 取消审批',
      detail: '全退-30+20% 违约金占比补偿（D4 矩阵）',
    });
    // I-3（修复环）：缺 action_payload.target → 400（cancel_lt24h 的 RESOLVED 必须经回调
    // 承载——纯记录处置面关闭，防工单已决而取消流未生效的静默漂移）
    await expect(
      tickets.resolveTicket({
        ticketId: created.ticket.id,
        operatorId: ADMIN,
        approved: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    // d4 目标未注册回调器：显式拒绝（resolve 意味着回调已生效——不静默跳过）
    await expect(
      tickets.resolveTicket({
        ticketId: created.ticket.id,
        operatorId: ADMIN,
        approved: true,
        actionPayload: { target: 'd4', cancellation_id: 1 },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    // 两类 400 均不落终态（处置效果与迁移同事务回滚——工单仍 OPEN）
    expect((await tickets.getTicketDetail(created.ticket.id)).ticket.status).toBe('OPEN');
  });

  // ===========================================================================
  // R-03 对账差异 SLA 24h（架构 §4.4）：事件消费真链 + SLA 计算 + 统计面
  // ===========================================================================

  it('R-03 ReconciliationDiffFound 消费：reconciliation 工单（SLA 24h 硬）+ 重复事件幂等短路', async () => {
    const diffPayload = {
      period: '2026-10-16',
      detail: [
        {
          channel: 'wechat_ecom',
          channel_txn_no: 'MOCK-H3-0001',
          kind: 'CHANNEL_ONLY',
          amount: '10.00',
          reason: '通道独有行',
        },
      ],
    };
    await recordEvent(RECONCILIATION_DIFF_FOUND_TOPIC, diffPayload);
    await relay.tick();
    const list = await tickets.listTickets({ category: 'reconciliation' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      category: 'reconciliation',
      ref_type: 'recon_period',
      ref_id: 20261016, // period 数值化幂等锚
      status: 'OPEN',
    });
    // SLA 计算：reconciliation=24h 硬（§2 逐字；其余 48h 对照见 dead_letter 用例）
    expect(await slaGapMs(list[0]!.id)).toBeGreaterThan(DAY_MS - SLA_TOLERANCE_MS);
    expect(await slaGapMs(list[0]!.id)).toBeLessThan(DAY_MS + SLA_TOLERANCE_MS);
    // 建单事件出箱
    expect(await outboxOf(TICKET_CREATED_TOPIC)).toHaveLength(1);

    // at-least-once 重投（同 period 新事件）：UNIQUE 部分索引兜底短路，零新行零新事件
    await recordEvent(RECONCILIATION_DIFF_FOUND_TOPIC, {
      ...diffPayload,
      detail: [
        { channel: 'alipay', channel_txn_no: 'X', kind: 'LOCAL_ONLY', amount: '5.00', reason: 'r' },
      ],
    });
    await relay.tick();
    expect(await tickets.listTickets({ category: 'reconciliation' })).toHaveLength(1);
    expect(await outboxOf(TICKET_CREATED_TOPIC)).toHaveLength(1);
  });

  it('RefundFailed 消费：dead_letter 工单（SLA 48h 软）+ refund ref 幂等锚；载荷非法进重试轨道不建单', async () => {
    await recordEvent(REFUND_FAILED_TOPIC, {
      refund_id: 55,
      order_id: 9,
      reason: 'SESSION_CANCELLED',
      attempts: 3,
      last_error: 'MOCK_CHANNEL_REJECT',
    });
    await relay.tick();
    const list = await tickets.listTickets({ category: 'dead_letter' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      category: 'dead_letter',
      ref_type: 'refund',
      ref_id: 55,
      status: 'OPEN',
    });
    expect(await slaGapMs(list[0]!.id)).toBeGreaterThan(48 * HOUR_MS - SLA_TOLERANCE_MS);
    expect(await slaGapMs(list[0]!.id)).toBeLessThan(48 * HOUR_MS + SLA_TOLERANCE_MS);
    // 非法载荷：抛错进 relay 重试轨道（事件未 SENT），不建单不静默
    await recordEvent(REFUND_FAILED_TOPIC, { refund_id: 'x' });
    const tick = await relay.tick();
    expect(tick.retried).toBeGreaterThanOrEqual(1);
    expect(await tickets.listTickets({ category: 'dead_letter' })).toHaveLength(1);
  });

  it('C-1 事件建单 detail 超 4000：截断留档恰 TICKET_DETAIL_MAX + 回查锚标记（不毒化消费链，R-03 场景工单必建）', async () => {
    // 12 行 × ~480 字符差异说明 ≈ 7K+ 字符：人工面硬校验口径下将 400 → relay 重试 → DEAD
    const longReason = '差异行说明-通道侧账单与本地台账不一致需人工核对-'.repeat(20);
    const detail = Array.from({ length: 12 }, (_, i) => ({
      channel: 'wechat_ecom',
      channel_txn_no: `MOCK-H3-LONG-${i}`,
      kind: 'CHANNEL_ONLY' as const,
      amount: '10.00',
      reason: longReason,
    }));
    expect(JSON.stringify({ period: '2026-10-17', detail }).length).toBeGreaterThan(4000);
    await recordEvent(RECONCILIATION_DIFF_FOUND_TOPIC, { period: '2026-10-17', detail });
    await relay.tick();

    const list = await tickets.listTickets({ category: 'reconciliation' });
    expect(list).toHaveLength(1); // 截断而非拒单——工单必建（SLA 时钟起算）
    expect(list[0]!.detail.length).toBe(4000); // 恰 TICKET_DETAIL_MAX（建单校验可过）
    expect(list[0]!.detail.startsWith('{"period":"2026-10-17"')).toBe(true); // 原文头部保留
    // 截断标记：dropped 计数 + 全量回查锚（明细按需回查，约定口径）
    expect(list[0]!.detail).toMatch(
      /…\[truncated \d+ chars，全量回查 split_ledgers period=2026-10-17\]$/,
    );
    // SLA 照常 24h 硬（R-03 不因超长降级）
    expect(await slaGapMs(list[0]!.id)).toBeGreaterThan(DAY_MS - SLA_TOLERANCE_MS);
  });

  it('M-4 periodToRefId 非法对账期（分隔符/月越界/日越界）：抛 E_INVALID_ARGUMENT，不建单', async () => {
    const handler = createReconciliationDiffFoundHandler(tickets);
    const evt = (period: string): RelayEvent => ({
      id: 1,
      eventId: 'evt-h3-m4',
      topic: RECONCILIATION_DIFF_FOUND_TOPIC,
      payload: {
        period,
        detail: [
          {
            channel: 'wechat_ecom',
            channel_txn_no: null,
            kind: 'CHANNEL_ONLY',
            amount: '1.00',
            reason: 'r',
          },
        ],
      },
      retryCount: 0,
    });
    await expect(handler(evt('2026/10/16'), {} as never)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(handler(evt('2026-13-01'), {} as never)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(handler(evt('2026-02-30'), {} as never)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    expect(await tickets.listTickets({ category: 'reconciliation' })).toHaveLength(0);
  });

  it('M2-W2 T6 ReserveDiffFound：备付对平差异 → reconciliation 工单（title 区分「备付对平差异」+priority=1+24h 硬 SLA）；同期重放幂等（一期一工单）；diff=0 载荷拒绝', async () => {
    const handler = createReserveDiffFoundHandler(tickets);
    const evt: RelayEvent = {
      id: 2,
      eventId: 'evt-f4-reserve',
      topic: RESERVE_DIFF_FOUND_TOPIC,
      payload: {
        period: '2026-10-19',
        points_outstanding_cents: 1200,
        reserve_net_cents: 1150,
        diff_cents: 50,
      },
      retryCount: 0,
    };
    await handler(evt, {} as never);
    const list = await tickets.listTickets({ category: 'reconciliation' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      ref_type: 'reserve_period',
      ref_id: 20261019,
      title: '备付对平差异：2026-10-19',
      status: 'OPEN',
      priority: 1,
    });
    expect(list[0]!.detail).toContain('"diff_cents":50');
    // SLA=24h 硬（reconciliation 类目配置同①）
    expect(await slaGapMs(list[0]!.id)).toBeGreaterThan(DAY_MS - SLA_TOLERANCE_MS);
    // 同期重放：幂等键=category+(reserve_period, yyyymmdd) 短路
    await handler(evt, {} as never);
    expect(await tickets.listTickets({ category: 'reconciliation' })).toHaveLength(1);
    // diff=0（平衡误报载荷）→ 拒绝不建单
    await expect(
      handler(
        {
          id: 3,
          eventId: 'evt-f4-reserve-0',
          topic: RESERVE_DIFF_FOUND_TOPIC,
          payload: {
            period: '2026-10-20',
            points_outstanding_cents: 100,
            reserve_net_cents: 100,
            diff_cents: 0,
          },
          retryCount: 0,
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    expect(await tickets.listTickets({ category: 'reconciliation' })).toHaveLength(1);
  });

  it('M2-W2 T6 修复环 I-3 AbsenceShareDangling：分成悬空 → reconciliation 工单（title 区分「分成悬空」+24h 硬 SLA）；同场重放幂等（一场一工单）；载荷非法拒绝', async () => {
    const handler = createAbsenceShareDanglingHandler(tickets);
    const evt: RelayEvent = {
      id: 4,
      eventId: 'evt-f4-dangling',
      topic: ABSENCE_SHARE_DANGLING_TOPIC,
      payload: { session_id: 501, absent_users: 2, attending_users: 1 },
      retryCount: 0,
    };
    await handler(evt, {} as never);
    const list = await tickets.listTickets({ category: 'reconciliation' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      ref_type: 'absence_session',
      ref_id: 501,
      title: '分成悬空：session=501',
      status: 'OPEN',
      priority: 1,
    });
    expect(list[0]!.detail).toContain('"absent_users":2');
    expect(await slaGapMs(list[0]!.id)).toBeGreaterThan(DAY_MS - SLA_TOLERANCE_MS);
    // 同场重放：幂等键=category+(absence_session, session_id) 短路
    await handler(evt, {} as never);
    expect(await tickets.listTickets({ category: 'reconciliation' })).toHaveLength(1);
    // 载荷非法（attending_users=0）→ 拒绝不建单
    await expect(
      handler(
        {
          id: 5,
          eventId: 'evt-f4-dangling-bad',
          topic: ABSENCE_SHARE_DANGLING_TOPIC,
          payload: { session_id: 502, absent_users: 1, attending_users: 0 },
          retryCount: 0,
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    expect(await tickets.listTickets({ category: 'reconciliation' })).toHaveLength(1);
  });

  it('§10-1 SLA 统计正确：open/overdue 计数 + 分类计数（超时率口径留 H4）；列表行携带 sla_overdue 布尔', async () => {
    const recon1 = await tickets.createTicket({
      category: 'reconciliation',
      refType: 'recon_period',
      refId: 20261015,
      title: '对账差异 A',
      detail: 'd',
    });
    await tickets.createTicket({
      category: 'reconciliation',
      refType: 'recon_period',
      refId: 20261014,
      title: '对账差异 B',
      detail: 'd',
    });
    const dispute = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: 9005,
      title: '纠纷',
      detail: 'd',
    });
    // recon1 超时（回拨 sla_due）；dispute 保持未超时
    await backdateSla(recon1.ticket.id);
    // 已决工单不计入（resolve dispute → 终态出告警面）
    await tickets.resolveTicket({ ticketId: dispute.ticket.id, operatorId: ADMIN, approved: true });

    const stats = await tickets.slaStats();
    expect(stats.open_total).toBe(2);
    expect(stats.overdue_total).toBe(1);
    expect(stats.by_category['reconciliation']).toEqual({ open: 2, overdue: 1 });
    expect(stats.by_category['dispute']).toBeUndefined(); // 已决类目不计

    // 列表布尔位：超时行 true / 未超时行 false；status/category 筛选
    const list = await tickets.listTickets({ category: 'reconciliation', status: 'OPEN' });
    expect(list).toHaveLength(2);
    const overdueRow = list.find((t) => t.id === recon1.ticket.id);
    expect(overdueRow?.sla_overdue).toBe(true);
    expect(list.find((t) => t.id !== recon1.ticket.id)?.sla_overdue).toBe(false);
    const resolved = await tickets.listTickets({ status: 'RESOLVED' });
    expect(resolved.map((t) => t.id)).toEqual([dispute.ticket.id]);
  });

  // ===========================================================================
  // §10-2 审批回调恰一次（幂等）：pricing approve 既有 API 真链
  // ===========================================================================

  it('§10-2 审批回调真链（target=pricing）：approve 恰一次生效（approval_id=工单 id）+ 终态重放 409 不再回调', async () => {
    const historyId = await seedPendingPriceChange(LAWYER_CB, 30);
    const created = await tickets.createTicket({
      category: 'price_change',
      refType: 'pricing_history',
      refId: historyId,
      title: '改价审批（在团降价恰 10%）',
      detail: 'C6 ①期人工兜底',
    });
    // 回调恰一次观测（spy 装在服务实例上——注册表持同一实例引用）
    const approveSpy = vi.spyOn(priceChange, 'approve');

    const res = await tickets.resolveTicket({
      ticketId: created.ticket.id,
      operatorId: ADMIN,
      approved: true,
      actionPayload: { target: 'pricing', price_change_id: historyId },
    });
    expect(res.status).toBe('RESOLVED');
    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledWith(historyId, {
      approved: true,
      approval_id: created.ticket.id,
    });
    // C6 面生效断言（pricing 导出读面，禁直查 pricing 表）
    const hist = (await priceChange.listHistories(LAWYER_CB)).find(
      (h) => h.history_id === historyId,
    );
    expect(hist).toMatchObject({
      result: 'EFFECTED',
      approval_source: 'MANUAL',
      approval_id: created.ticket.id,
    });
    // price_change ref 非结算实体：无 TICKET_RESOLVED 出箱
    expect(await outboxOf(TICKET_RESOLVED_TOPIC)).toHaveLength(0);

    // 终态重放：409 CLOSED，回调不二次（恰一次）
    await expect(
      tickets.resolveTicket({
        ticketId: created.ticket.id,
        operatorId: ADMIN,
        approved: true,
        actionPayload: { target: 'pricing', price_change_id: historyId },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(approveSpy).toHaveBeenCalledTimes(1);
    approveSpy.mockRestore();
  });

  it('回调驳回路径：approved=false → C6 REJECTED（版本不生效）+ 工单 REJECTED；target 实体 id 非法 400', async () => {
    const historyId = await seedPendingPriceChange(LAWYER_CB2, 31);
    const created = await tickets.createTicket({
      category: 'price_change',
      refType: 'pricing_history',
      refId: historyId,
      title: '改价审批（驳回）',
      detail: 'd',
    });
    const res = await tickets.resolveTicket({
      ticketId: created.ticket.id,
      operatorId: ADMIN,
      approved: false,
      actionPayload: { target: 'pricing', price_change_id: historyId },
    });
    expect(res.status).toBe('REJECTED');
    const hist = (await priceChange.listHistories(LAWYER_CB2)).find(
      (h) => h.history_id === historyId,
    );
    expect(hist).toMatchObject({ result: 'REJECTED', approval_source: 'MANUAL' });

    // price_change_id 缺失/非正整数：入参校验 400，工单不落终态
    const other = await tickets.createTicket({
      category: 'price_change',
      refType: 'pricing_history',
      refId: historyId + 1,
      title: 't',
      detail: 'd',
    });
    await expect(
      tickets.resolveTicket({
        ticketId: other.ticket.id,
        operatorId: ADMIN,
        approved: true,
        actionPayload: { target: 'pricing' },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    expect((await tickets.getTicketDetail(other.ticket.id)).ticket.status).toBe('OPEN');
  });

  // ===========================================================================
  // R-04 未结 dispute 工单 → 该场结算 HOLD（F3 联调；§10-3）
  // ===========================================================================

  it('R-04 §10-3 联调：未结 dispute 工单使 F3 结算维持 HOLD（OPEN_TICKETS）；resolve→TICKET_RESOLVED→F3 既有消费面释放并结算', async () => {
    // F3 既有面造链：支付单 PAID + 商户 ACTIVE + 进结算（PENDING→HOLD）
    const order = await payment.createOrder({
      biz_type: 'enroll',
      biz_id: 7001,
      cash_amount: '100.00',
      points_amount: 0,
      idempotency_key: 'payment/h3-ticket-r04/order-1',
    });
    await payment.markFrozen(order.payment_order.id, 'MOCK-WECHAT-H3-R04');
    await payment.markPaid(order.payment_order.id);
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const entered = await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: SESSION_REF,
      lawyer_id: 9101,
      firm_id: FIRM,
      gross: '100.00',
      payment_order_id: order.payment_order.id,
    });
    expect(entered.settlement.status).toBe('HOLD');

    // 修复环 I-1 生产装配断言：TicketModule onModuleInit 已把工单源注册进 F3 闸
    // （SettlementModule 导出 OpenTicketGate + TicketGateRegistration——spec 不再自行换装）
    const gate = app.get(OpenTicketGate);
    expect(await gate.hasOpenTicket('session', SESSION_REF)).toBe(false); // 建单前

    // 未结 dispute 工单存在 → 24h 到期释放被闸（hold_reason=OPEN_TICKETS）
    const created = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: SESSION_REF,
      title: '该场纠纷未结',
      detail: 'd',
    });
    expect(await gate.hasOpenTicket('session', SESSION_REF)).toBe(true); // 生产注册生效
    await travelHoldCreated(pool, entered.settlement.id); // 冻结期时间注入（settlement-fixture）
    const blocked = await settlements.releaseDueHold(entered.settlement.id, 'HOLD_EXPIRED');
    expect(blocked).toMatchObject({ released: false, blocked: 'OPEN_TICKETS' });
    let rows = await settlements.listForAdmin();
    expect(rows.find((r) => r.id === entered.settlement.id)).toMatchObject({
      status: 'HOLD',
      hold_reason: 'OPEN_TICKETS',
    });

    // 工单关闭 → TICKET_RESOLVED 出箱 → relay 真链驱动 F3 既有 TicketResolved 消费面：
    // 释放（HOLD→READY）+ 重驱动结算（RUN_SETTLE 唯一解冻节点 → SETTLED）
    await tickets.resolveTicket({ ticketId: created.ticket.id, operatorId: ADMIN, approved: true });
    expect(await gate.hasOpenTicket('session', SESSION_REF)).toBe(false); // 工单关闭出闸
    expect(await outboxOf(TICKET_RESOLVED_TOPIC)).toHaveLength(1);
    await relay.tick();
    rows = await settlements.listForAdmin();
    expect(rows.find((r) => r.id === entered.settlement.id)).toMatchObject({
      status: 'SETTLED',
      hold_reason: null,
    });
    // 释放后同 ref 再开 dispute 不追溯已结行（结算已完成，补偿流=D4）
    const again = await settlements.releaseDueHold(entered.settlement.id, 'HOLD_EXPIRED');
    expect(again).toMatchObject({ released: false });
  });

  it('R-04 语义锁定（修复环 I-2）：闸只认未结 dispute（H3 §7 文义「未结纠纷」）——非 dispute 类目挂同 ref 不 HOLD', async () => {
    const order = await payment.createOrder({
      biz_type: 'enroll',
      biz_id: 7002,
      cash_amount: '100.00',
      points_amount: 0,
      idempotency_key: 'payment/h3-ticket-i2/order-1',
    });
    await payment.markFrozen(order.payment_order.id, 'MOCK-WECHAT-H3-I2');
    await payment.markPaid(order.payment_order.id);
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const entered = await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: 9006,
      lawyer_id: 9101,
      firm_id: FIRM,
      gross: '100.00',
      payment_order_id: order.payment_order.id,
    });

    // 非 dispute 类目（录制调取）挂同 ref：不入闸
    await tickets.createTicket({
      category: 'export_recording',
      refType: 'session',
      refId: 9006,
      title: '录制调取审批',
      detail: 'd',
    });
    const gate = app.get(OpenTicketGate);
    expect(await gate.hasOpenTicket('session', 9006)).toBe(false);
    await travelHoldCreated(pool, entered.settlement.id);
    const rel = await settlements.releaseDueHold(entered.settlement.id, 'HOLD_EXPIRED');
    expect(rel).toMatchObject({ released: true }); // 不拦截，到期即放行（HOLD→READY）

    // 对照：dispute 同 ref 入闸；已决（RESOLVED）后出闸
    const dispute = await tickets.createTicket({
      category: 'dispute',
      refType: 'session',
      refId: 9006,
      title: '纠纷',
      detail: 'd',
    });
    expect(await gate.hasOpenTicket('session', 9006)).toBe(true);
    await tickets.resolveTicket({ ticketId: dispute.ticket.id, operatorId: ADMIN, approved: true });
    expect(await gate.hasOpenTicket('session', 9006)).toBe(false);
  });
});
