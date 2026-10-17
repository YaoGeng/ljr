import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  SETTLEMENT_DEBT_INCURRED_TOPIC,
  SETTLEMENT_HELD_TOPIC,
  SETTLEMENT_RELEASED_TOPIC,
  SPLIT_SETTLED_TOPIC,
  ErrorCode,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
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
import {
  countLedgersByDirection,
  getPaymentOrderById,
  listLedgersByDirection,
} from '../payment/order-fixture';
import { seedFirmMerchant, setFirmMerchantStatus } from '../payment/firm-merchant.fixture';
import { listJobsByType } from '../schedule/job-fixture';
import { centsToMoney } from './settlement.types';
import { OpenTicketGate } from './settlement.gate';
import { SettlementService } from './settlement.service';

/**
 * F3 分账结算服务集成用例（§4 状态机全迁移 / §7 R-01~R-07 / §10 验收清单）：
 *   - 进结算：RoomClosed/OneOnOneSettled 的服务核（PENDING→HOLD+SETTLE_HOLD_RELEASE job 在册）；
 *   - HOLD 边界：24h 内不分账 / 到期释放（DB 钟锚 created_at，SQL 时间旅行注入）；
 *   - R-01/R-07：唯一解冻节点 READY→SETTLED + 进件前置 assertSplittable（payment 域夹具行）；
 *   - R-04/§10-4：APPLY_PENALTY 扣减顺序两档 + deduction_detail 留痕 + 欠款出箱（G1 消费位）；
 *   - R-03/§10-3：缺席 70/30 构成复核；R-05：违约金不抽佣；R-06/§10-6：fee_versions 口径 + 1对1。
 * 消费器/执行器端到端（事件直投+scheduler tick）在 settlement.consumer.spec.ts。
 */

const DAY = Date.UTC(2026, 9, 16, 8, 0, 0);
const LAWYER = 9101;
const LAWYER2 = 9102;
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

describe('F3 SettlementService（需 PG）', () => {
  let pool: Pool;
  let poolSvc: PgPoolService;
  let outbox: OutboxService;
  let payment: PaymentGatewayService;
  let merchants: FirmMerchantService;
  let scheduler: SchedulerService;
  let gate: OpenTicketGate;
  let wechat: MockChannelAdapter;
  let settlements: SettlementService;
  let orderSeq = 0;

  /** F1 夹具：真实支付单 CREATED→FROZEN→PAID（结算分账指令的定位单） */
  const createPaidOrder = async (cash = '100.00'): Promise<PaymentOrderView> => {
    orderSeq += 1;
    const res = await payment.createOrder({
      biz_type: 'enroll',
      biz_id: 500 + orderSeq,
      cash_amount: cash,
      points_amount: 0,
      idempotency_key: `payment/f3s-order-${orderSeq}/pay`,
    });
    await payment.markFrozen(res.payment_order.id, `MOCK-WECHAT-F3S-${orderSeq}`);
    await payment.markPaid(res.payment_order.id);
    return res.payment_order;
  };

  const enter = async (opts?: {
    refType?: 'session' | 'one_on_one';
    refId?: number;
    lawyer?: number;
    firm?: number;
    gross?: string;
    order?: number;
  }) =>
    settlements.enterSettlement({
      ref_type: opts?.refType ?? 'session',
      ref_id: opts?.refId ?? 601,
      lawyer_id: opts?.lawyer ?? LAWYER,
      firm_id: opts?.firm ?? FIRM,
      gross: opts?.gross ?? '100.00',
      payment_order_id: opts?.order ?? (await createPaidOrder()).id,
    });

  const getRow = async (refType: string, refId: number) =>
    (
      await pool.query<Record<string, unknown>>(
        `SELECT id::int AS id, ref_type, ref_id::int AS ref_id, lawyer_id::int AS lawyer_id,
                firm_id::int AS firm_id, gross::text AS gross, penalty::text AS penalty,
                platform_fee::text AS platform_fee, fee_version_id::int AS fee_version_id,
                net::text AS net, share_mode, payment_order_id::int AS payment_order_id,
                escrow_status, deduction_detail, status, hold_reason, created_at, settled_at
           FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
        [refType, refId],
      )
    ).rows[0];

  const outboxPayloads = async (topic: string) =>
    (
      await pool.query<{ payload: unknown }>(
        `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
        [topic],
      )
    ).rows.map((r) => r.payload as Record<string, unknown>);

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    wechat = new MockChannelAdapter(
      'wechat_ecom',
      'mock-wechat-mch',
      'test-secret-w',
      () => new Date(DAY),
    );
    const alipay = new MockChannelAdapter(
      'alipay',
      'mock-alipay-mch',
      'test-secret-a',
      () => new Date(DAY),
    );
    poolSvc = new PgPoolService(pool);
    outbox = new OutboxService();
    const guard = new StateTransitionGuardService(new StateTransitionLogService(), poolSvc);
    const router = new ChannelRouter({
      adapters: [wechat, alipay],
      switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
      now: () => DAY,
    });
    payment = new PaymentGatewayService(
      poolSvc,
      outbox,
      guard,
      router,
      new PaymentAlertService(new MockPaymentAlertSink()),
      testConfig(),
    );
    merchants = new FirmMerchantService(
      poolSvc,
      outbox,
      guard,
      new SchedulerService(
        poolSvc,
        outbox,
        guard,
        new ScheduleExecutorRegistry(),
        new SchedulerAlertService(new MockPhoneAlertSink()),
        { batch: 10 },
      ),
      [wechat, alipay],
      MERCHANT_CONFIG,
    );
    scheduler = new SchedulerService(
      poolSvc,
      outbox,
      guard,
      new ScheduleExecutorRegistry(),
      new SchedulerAlertService(new MockPhoneAlertSink()),
      { batch: 10 },
    );
    gate = new OpenTicketGate();
    settlements = new SettlementService(
      poolSvc,
      outbox,
      guard,
      scheduler,
      gate,
      merchants,
      payment,
    );
  });

  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    wechat.fault = null;
  });
  afterEach(async () => {
    await truncateAll(pool);
    await pool.query(`DELETE FROM settlement.fee_versions WHERE rate <> 0.0000`); // 自定义费率夹具自清（种子参照数据不污染）
    wechat.fault = null;
  });

  // =========================================================================
  // A. enterSettlement：进 PENDING→HOLD（R-02；§6 RoomClosed/OneOnOneSettled 服务核）
  // =========================================================================

  it('A1 进结算：PENDING→HOLD（hold_reason=HOLD_24H）+ 0% 费率构成 + SETTLE_HOLD_RELEASE job 在册 + SettlementHeld 出箱', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    const res = await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: 601,
      lawyer_id: LAWYER,
      firm_id: FIRM,
      gross: '100.00',
      payment_order_id: order.id,
    });
    expect(res.created).toBe(true);
    expect(res.settlement).toMatchObject({
      ref_type: 'session',
      ref_id: 601,
      status: 'HOLD',
      hold_reason: 'HOLD_24H',
      gross: '100.00',
      penalty: '0.00',
      platform_fee: '0.00', // R-06 种子 0%（D20 ⚠W3 服务费后置）
      net: '100.00',
      share_mode: 'FULL_TO_LAWYER',
      escrow_status: 'PAID',
    });
    // SETTLE_HOLD_RELEASE job 在册（I2 目录在册：producer/executor=F3，锚=settlement 行；读经 owner 夹具）
    const jobs = await listJobsByType(pool, 'SETTLE_HOLD_RELEASE');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.ref_id).toBe(res.settlement.id);
    expect(jobs[0]!.due_at.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);

    const held = await outboxPayloads(SETTLEMENT_HELD_TOPIC);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      settlement_id: res.settlement.id,
      ref_type: 'session',
      ref_id: 601,
      session_id: 601,
      reason: 'HOLD_24H',
    });
  });

  it('A2 §10-7 幂等前哨：同 ref 重复进结算 created=false 不重建（UNIQUE(ref_type,ref_id) 锚）', async () => {
    await enter({ refId: 602 });
    const again = await enter({ refId: 602 });
    expect(again.created).toBe(false);
    expect(again.settlement.ref_id).toBe(602);
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM settlement.settlements`,
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it('A3 入参防御：gross 形态/ref_type 越域/正整数越界 → 400', async () => {
    await expect(
      settlements.enterSettlement({
        ref_type: 'session',
        ref_id: 603,
        lawyer_id: LAWYER,
        firm_id: FIRM,
        gross: '100' as '100.00',
        payment_order_id: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MoneyInvalidFormat });
    await expect(
      settlements.enterSettlement({
        ref_type: 'groupbuy' as 'session',
        ref_id: 603,
        lawyer_id: LAWYER,
        firm_id: FIRM,
        gross: '1.00',
        payment_order_id: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });

  // =========================================================================
  // B. releaseDueHold：HOLD 边界（R-02；§10-1 时间注入）
  // =========================================================================

  it('B1 §10-1 HOLD 24h 内不释放（DB 钟锚 created_at）', async () => {
    await enter({ refId: 610 });
    const row = await getRow('session', 610);
    const res = await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');
    expect(res).toEqual({ released: false, blocked: 'HOLD_24H' });
    expect((await getRow('session', 610))!.status).toBe('HOLD');
  });

  it('B2 到期释放：created_at 回拨 25h（SQL 时间旅行）→ READY + SettlementReleased 出箱；重复释放幂等', async () => {
    await enter({ refId: 611 });
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_type='session' AND ref_id=611`,
    );
    const row = await getRow('session', 611);
    const res = await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');
    expect(res).toEqual({ released: true });
    const after = await getRow('session', 611);
    expect(after!.status).toBe('READY');
    expect(after!.hold_reason).toBeNull();
    const released = await outboxPayloads(SETTLEMENT_RELEASED_TOPIC);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ ref_id: 611, reason: 'HOLD_EXPIRED' });

    const again = await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');
    expect(again.released).toBe(false); // 非 HOLD 幂等
    expect((await outboxPayloads(SETTLEMENT_RELEASED_TOPIC)).length).toBe(1);
  });

  it('B3 工单闸：闸口报有未结工单 → 释放被挡（hold_reason=OPEN_TICKETS）；闸口关闭后放行', async () => {
    await enter({ refId: 612 });
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_type='session' AND ref_id=612`,
    );
    gate.registerSource({ hasOpenTicket: async () => true });
    const row = await getRow('session', 612);
    const blocked = await settlements.releaseDueHold(row!.id as number, 'TICKET_RESOLVED');
    expect(blocked).toEqual({ released: false, blocked: 'OPEN_TICKETS' });
    expect((await getRow('session', 612))!.hold_reason).toBe('OPEN_TICKETS');

    gate.registerSource({ hasOpenTicket: async () => false }); // 工单关闭（H3=M2 换装语义）
    const ok = await settlements.releaseDueHold(row!.id as number, 'TICKET_RESOLVED');
    expect(ok).toEqual({ released: true });
  });

  // =========================================================================
  // C. runSettlement：唯一解冻节点（R-01）+ 进件前置（R-07/§10-5）+ 幂等（§10-7）
  // =========================================================================

  it('C1 R-01 全链：释放→结算 SETTLED，F1 单 PAID→SPLIT，SplitSettled 构成出箱；重复结算幂等无操作', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await enter({ refId: 620, order: order.id });
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_type='session' AND ref_id=620`,
    );
    const row = await getRow('session', 620);
    await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');

    const res = await settlements.runSettlement({ ref_type: 'session', ref_id: 620 });
    expect(res).toMatchObject({ settled: true, settlement_id: row!.id });
    const after = await getRow('session', 620);
    expect(after!.status).toBe('SETTLED');
    expect(after!.escrow_status).toBe('SPLIT');
    expect(after!.settled_at).not.toBeNull();

    // F1 指令真下发：支付单 PAID→SPLIT（唯一解冻；分账台账 CONFIRMED 一条；读经 owner 夹具）
    expect((await getPaymentOrderById(pool, order.id))['status']).toBe('SPLIT');
    const splits = (await listLedgersByDirection(pool, 'SPLIT')).filter(
      (l) => l.status === 'CONFIRMED',
    );
    expect(splits).toHaveLength(1);
    expect(splits[0]!.amount).toBe('100.00');

    const settled = await outboxPayloads(SPLIT_SETTLED_TOPIC);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      settlement_id: row!.id,
      ref_type: 'session',
      ref_id: 620,
      session_id: 620,
      net: '100.00', // Σsplits = net = gross − penalty（构成校验锚）
      fee: '0.00',
    });
    expect(settled[0]!.splits).toEqual([
      { payee_type: 'lawyer_firm', payee_id: FIRM, amount: '100.00' },
    ]);

    // §10-7 重复触发幂等无操作
    const replay = await settlements.runSettlement({ ref_type: 'session', ref_id: 620 });
    expect(replay).toMatchObject({ settled: false, already_settled: true });
    expect((await outboxPayloads(SPLIT_SETTLED_TOPIC)).length).toBe(1);
    expect(await countLedgersByDirection(pool, 'SPLIT')).toBe(1);
  });

  it('C2 未到 READY 不结算：HOLD 行 runSettlement → settled:false + 无 F1 指令（跳过 HOLD 直分被禁）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    await enter({ refId: 621 });
    const res = await settlements.runSettlement({ ref_type: 'session', ref_id: 621 });
    expect(res).toMatchObject({ settled: false, status: 'HOLD' });
    expect(await countLedgersByDirection(pool, 'SPLIT')).toBe(0);
  });

  it('C3 R-07/§10-5 进件非 ACTIVE：READY 结算被拒并挂起 SUSPENDED（MERCHANT_NOT_ACTIVE），F1 单不分账', async () => {
    await seedFirmMerchant(pool, FIRM, 'SUSPENDED'); // A3b 查询面 assertSplittable 非 ACTIVE
    const order = await createPaidOrder('100.00');
    await enter({ refId: 622, order: order.id });
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_type='session' AND ref_id=622`,
    );
    const row = await getRow('session', 622);
    await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');

    const res = await settlements.runSettlement({ ref_type: 'session', ref_id: 622 });
    expect(res).toMatchObject({ settled: false, suspended: true });
    const after = await getRow('session', 622);
    expect(after!.status).toBe('SUSPENDED');
    expect(after!.hold_reason).toBe('MERCHANT_NOT_ACTIVE');
    expect((await getPaymentOrderById(pool, order.id))['status']).toBe('PAID'); // 未分账
    const held = await outboxPayloads(SETTLEMENT_HELD_TOPIC);
    expect(held.some((p) => p['reason'] === 'MERCHANT_NOT_ACTIVE' && p['ref_id'] === 622)).toBe(
      true,
    );
  });

  it('C4 F1 支付单不可读（绑定漂移）→ 404 显性化进重试轨道（不静默）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    await enter({ refId: 623, order: 999999999 });
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_type='session' AND ref_id=623`,
    );
    const row = await getRow('session', 623);
    await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');
    await expect(
      settlements.runSettlement({ ref_type: 'session', ref_id: 623 }),
    ).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });

  // =========================================================================
  // D. suspendForFirm / resumeForFirm：进件挂起与恢复重驱动（A3b 真事件消费的服务核）
  // =========================================================================

  it('D1 R-07 进件挂起：该律所 HOLD/READY 全量 → SUSPENDED（STL 留痕）；恢复（冻结期满）→ READY→SETTLED 全链', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const orderA = await createPaidOrder('100.00');
    const orderB = await createPaidOrder('40.00');
    await enter({ refId: 630, order: orderA.id }); // HOLD（24h 内）
    await enter({ refId: 631, order: orderB.id, gross: '40.00' }); // HOLD
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_id IN (630, 631)`,
    );
    const rowB = await getRow('session', 631);
    await settlements.releaseDueHold(rowB!.id as number, 'HOLD_EXPIRED'); // B → READY

    const suspended = await settlements.suspendForFirm(FIRM, 'ACCOUNT_CHANGING');
    expect(suspended.suspended).toBe(2);
    const states = await pool.query<{ ref_id: number; status: string; hold_reason: string }>(
      `SELECT ref_id::int AS ref_id, status, hold_reason FROM settlement.settlements WHERE firm_id = $1 ORDER BY ref_id`,
      [FIRM],
    );
    expect(
      states.rows.every((r) => r.status === 'SUSPENDED' && r.hold_reason === 'MERCHANT_NOT_ACTIVE'),
    ).toBe(true);
    // STL 留痕（entity_type='settlement'，经守卫）
    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type='settlement' AND to_status='SUSPENDED' AND allowed=true`,
    );
    expect(stl.rows[0]!.n).toBeGreaterThanOrEqual(2);

    // 恢复（进件 ACTIVE 化 + FirmMerchantActivated 消费核）：冻结期已满 → READY；
    // 重驱动分账由消费链承担（resume 原子面只做状态迁移，F1 外部指令在消费器续跑——本用例同形）
    await setFirmMerchantStatus(pool, FIRM, 'ACTIVE');
    const resumed = await settlements.resumeForFirm(FIRM);
    expect(resumed.readied.length).toBe(2);
    for (const id of resumed.readied) {
      await settlements.runSettlementById(id);
    }
    const settled = await pool.query<{ status: string }>(
      `SELECT status FROM settlement.settlements WHERE firm_id = $1 ORDER BY ref_id`,
      [FIRM],
    );
    expect(settled.rows.every((r) => r.status === 'SETTLED')).toBe(true);
    expect((await outboxPayloads(SPLIT_SETTLED_TOPIC)).length).toBe(2);
  });

  it('D2 恢复但冻结期未满：SUSPENDED→HOLD + SETTLE_HOLD_RELEASE job 重新注册（锚仍=created_at）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    await enter({ refId: 632 });
    const row = await getRow('session', 632);
    await settlements.suspendForFirm(FIRM, 'REVERIFY_OVERDUE');
    // 模拟原 job 已被消费：经 I2 API 作废在册行（schedule_jobs 禁直改）
    await scheduler.cancelJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: row!.id as number,
    });

    await setFirmMerchantStatus(pool, FIRM, 'ACTIVE');
    const resumed = await settlements.resumeForFirm(FIRM);
    expect(resumed.readied).toHaveLength(0);
    expect(resumed.reheld).toBe(1);
    expect((await getRow('session', 632))!.status).toBe('HOLD');
    const pending = (await listJobsByType(pool, 'SETTLE_HOLD_RELEASE')).filter(
      (j) => j.status === 'PENDING',
    );
    expect(pending).toHaveLength(1); // 重注册（恢复后冻结期重走）
    expect(row).toBeDefined();
  });

  // =========================================================================
  // E. applyPenalty：R-04 扣减顺序两档 / §10-4 留痕 / R-05 不抽佣 / G1 欠款出箱
  // =========================================================================

  /** 违约扣减入参（同键构造器） */
  const penaltyInput = (over?: Partial<{ amount: string; key: string; owner: number }>) => ({
    owner_id: over?.owner ?? LAWYER,
    amount: over?.amount ?? ('60.00' as const),
    base_ref: { ref_type: 'session', ref_id: 640 },
    base_version: 3,
    reason: 'LAWYER_CANCEL_20',
    idempotency_key: over?.key ?? 'penalty/session-640/cancel-20',
  });

  it('E1 R-04 第一档：待结算余额足额扣减，FIFO 摊扣行 penalty（net 递减、platform_fee 不动=R-05）+ deduction_detail 留痕', async () => {
    await enter({ refId: 640, gross: '50.00', lawyer: LAWYER });
    await enter({ refId: 641, gross: '30.00', lawyer: LAWYER });
    const res = await settlements.applyPenalty(penaltyInput()); // 60.00
    expect(res).toMatchObject({
      replayed: false,
      from_settlement: '60.00',
      from_deposit: '0.00',
      debt: '0.00',
    });

    const r1 = await getRow('session', 640);
    const r2 = await getRow('session', 641);
    expect(r1).toMatchObject({ penalty: '50.00', net: '0.00', platform_fee: '0.00' }); // FIFO 首行吃满
    expect(r2).toMatchObject({ penalty: '10.00', net: '20.00' });
    const detail = r2!.deduction_detail as Record<string, unknown>; // 锚=最后被摊扣行
    expect(detail['idempotency_key']).toBe('penalty/session-640/cancel-20');
    expect(detail['debt']).toBe('0.00');
    const items = detail['items'] as { leg: string; amount: string; status: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ leg: 'settlement', amount: '60.00', status: 'CONFIRMED' });

    // F1 DEDUCT 台账一条 CONFIRMED（from=settlement；读经 owner 夹具）
    const deducts = (await listLedgersByDirection(pool, 'DEDUCT')).filter(
      (l) => l.status === 'CONFIRMED',
    );
    expect(deducts).toHaveLength(1);
    expect(deducts[0]!.detail?.['from']).toBe('settlement');
    // 欠款事件不出（无欠款）
    expect((await outboxPayloads(SETTLEMENT_DEBT_INCURRED_TOPIC)).length).toBe(0);
  });

  it('E2 R-04 第二档（§10-4）：余额 80 违约 100 → settlement 80 + 保证金专户 20，两腿 CONFIRMED 留痕', async () => {
    await enter({ refId: 642, gross: '80.00', lawyer: LAWYER });
    const res = await settlements.applyPenalty(
      penaltyInput({ amount: '100.00', key: 'penalty/session-643/cancel-50' }),
    );
    expect(res).toMatchObject({ from_settlement: '80.00', from_deposit: '20.00', debt: '0.00' });
    const legs = (await listLedgersByDirection(pool, 'DEDUCT')).filter(
      (l) => l.status === 'CONFIRMED',
    );
    expect(legs.map((l) => ({ from: l.detail?.['from'], amount: l.amount }))).toEqual([
      { from: 'settlement', amount: '80.00' },
      { from: 'deposit', amount: '20.00' },
    ]);
    const detail = (await getRow('session', 642))!.deduction_detail as { items: unknown[] };
    expect(detail.items).toHaveLength(2);
  });

  it('E3 无未结算行：全额走保证金专户；无行可锚=deduction_detail 缺位（F1 台账+事件承载）', async () => {
    const res = await settlements.applyPenalty(
      penaltyInput({ amount: '30.00', key: 'penalty/session-644/cancel-30' }),
    );
    expect(res).toMatchObject({ from_settlement: '0.00', from_deposit: '30.00', debt: '0.00' });
    expect(
      (await listLedgersByDirection(pool, 'DEDUCT')).filter((l) => l.status === 'CONFIRMED'),
    ).toHaveLength(1);
  });

  it('E4 §10-4 保证金亦不足：SHORTFALL 腿留痕 + SettlementDebtIncurred 出箱（G1 SUSPEND_TAKE 消费位=M2）', async () => {
    await enter({ refId: 645, gross: '80.00', lawyer: LAWYER });
    // 腿级故障注入：仅保证金腿（from='deposit'）通道业务应答 INSUFFICIENT——R-04 次序下第二档不足
    const { ChannelFaultError } = await import('../payment/payment.channels');
    const depositFault = Object.create(wechat) as MockChannelAdapter & {
      deduct: (req: { from?: string }) => Promise<unknown>;
    };
    depositFault.deduct = async (req: { from?: string }) => {
      if (req.from === 'deposit') {
        throw new ChannelFaultError('INSUFFICIENT', wechat.channel, 'INSUFFICIENT：保证金专户不足');
      }
      return MockChannelAdapter.prototype.deduct.call(wechat, req as never);
    };
    const paymentWithFault = new PaymentGatewayService(
      poolSvc,
      outbox,
      new StateTransitionGuardService(new StateTransitionLogService(), poolSvc),
      new ChannelRouter({
        adapters: [depositFault, wechat],
        switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
        now: () => DAY,
      }),
      new PaymentAlertService(new MockPaymentAlertSink()),
      testConfig(),
    );
    const settlementsFaulted = new SettlementService(
      poolSvc,
      outbox,
      new StateTransitionGuardService(new StateTransitionLogService(), poolSvc),
      scheduler,
      gate,
      merchants,
      paymentWithFault,
    );
    const res = await settlementsFaulted.applyPenalty(
      penaltyInput({ amount: '100.00', key: 'penalty/session-646/cancel-50' }),
    );
    expect(res).toMatchObject({ from_settlement: '80.00', from_deposit: '0.00', debt: '20.00' });
    const detail = (await getRow('session', 645))!.deduction_detail as {
      debt: string;
      items: { leg: string; status: string; amount: string }[];
    };
    expect(detail.debt).toBe('20.00');
    expect(detail.items).toEqual([
      expect.objectContaining({ leg: 'settlement', status: 'CONFIRMED', amount: '80.00' }),
      expect.objectContaining({ leg: 'deposit', status: 'SHORTFALL', amount: '20.00' }),
    ]);
    const debts = await outboxPayloads(SETTLEMENT_DEBT_INCURRED_TOPIC);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({
      lawyer_id: LAWYER,
      firm_id: FIRM,
      amount: '20.00',
      ref_type: 'session',
      ref_id: 640,
    });
  });

  it('E5 §10-7 APPLY_PENALTY 幂等：同键重放无操作（F1 台账不新增、行不重扣）；同键异载荷 409', async () => {
    await enter({ refId: 647, gross: '50.00', lawyer: LAWYER });
    const first = await settlements.applyPenalty(penaltyInput({ amount: '40.00' }));
    expect(first.replayed).toBe(false);
    const replay = await settlements.applyPenalty(penaltyInput({ amount: '40.00' }));
    expect(replay).toMatchObject({ replayed: true, from_settlement: '40.00', debt: '0.00' });
    expect(await countLedgersByDirection(pool, 'DEDUCT')).toBe(1);
    expect((await getRow('session', 647))!.penalty).toBe('40.00');

    await expect(
      settlements.applyPenalty(penaltyInput({ amount: '41.00' })), // 同键异载荷
    ).rejects.toMatchObject({ code: ErrorCode.PaymentDuplicateKey });
  });

  it('E6 入参防御：amount 0/非法、幂等键非 penalty/ 域、base_ref 缺失 → 400', async () => {
    await expect(settlements.applyPenalty(penaltyInput({ amount: '0.00' }))).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(
      settlements.applyPenalty({ ...penaltyInput(), idempotency_key: 'deposit/session-1/x' }),
    ).rejects.toMatchObject({ code: ErrorCode.IdempotencyKeyInvalid }); // penalty/ 域约束（保证金腿派生键防撞）
    await expect(
      settlements.applyPenalty({ ...penaltyInput(), base_ref: { ref_type: '', ref_id: 0 } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });

  it('E7 R-05 全链钉：违约后结算构成——penalty 不进 platform_fee、净额递减、Σsplits=net=gross−penalty', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await enter({ refId: 648, gross: '100.00', order: order.id });
    await settlements.applyPenalty(
      penaltyInput({ amount: '30.00', key: 'penalty/session-648/cancel-20' }),
    );
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_id=648`,
    );
    const row = await getRow('session', 648);
    await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');
    await settlements.runSettlement({ ref_type: 'session', ref_id: 648 });

    const after = await getRow('session', 648);
    expect(after).toMatchObject({
      status: 'SETTLED',
      penalty: '30.00',
      platform_fee: '0.00',
      net: '70.00',
    });
    const settled = (await outboxPayloads(SPLIT_SETTLED_TOPIC))[0]!;
    expect(settled).toMatchObject({ net: '70.00', fee: '0.00' });
    expect(settled['splits']).toEqual([
      { payee_type: 'lawyer_firm', payee_id: FIRM, amount: '70.00' },
    ]);
    // F1 台账守恒：SPLIT 70 + DEDUCT 30 = gross 100（读经 owner 夹具）
    const sumOf = async (direction: 'SPLIT' | 'DEDUCT'): Promise<number> =>
      (await listLedgersByDirection(pool, direction))
        .filter((l) => l.status === 'CONFIRMED')
        .reduce((s, l) => s + Number(l.amount.replace('.', '')), 0);
    expect(centsToMoney(await sumOf('SPLIT'))).toBe('70.00');
    expect(centsToMoney(await sumOf('DEDUCT'))).toBe('30.00');
  });

  // =========================================================================
  // F. markAbsenceShare：R-03 触发位 + 70/30 构成复核（§10-3）
  // =========================================================================

  it('F1 §10-3 缺席 70/30：标记→结算构成 firm=floor(net×0.7)、备付=尾差，SplitSettled.splits 携带备付份额（F4 消费位）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    const order = await createPaidOrder('100.00');
    await enter({ refId: 650, gross: '100.00', order: order.id });
    expect(await settlements.markAbsenceShare('session', 650)).toEqual({ marked: true });
    expect((await getRow('session', 650))!.share_mode).toBe('ABSENCE_7030');

    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_id=650`,
    );
    const row = await getRow('session', 650);
    await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');
    await settlements.runSettlement({ ref_type: 'session', ref_id: 650 });

    const settled = (await outboxPayloads(SPLIT_SETTLED_TOPIC))[0]!;
    expect(settled['net']).toBe('100.00');
    expect(settled['splits']).toEqual([
      { payee_type: 'lawyer_firm', payee_id: FIRM, amount: '70.00' },
      { payee_type: 'platform', payee_id: 0, amount: '30.00' }, // 30% 平台分账接收账户（备付，F4 台账桩）
    ]);
    expect((await getRow('session', 650))!.status).toBe('SETTLED');
  });

  it('F2 标记防御：无结算行=NO_SETTLEMENT（D3 先于 RoomClosed 时序=M2 联调位，不炸）；已 SETTLED=SETTLED 拒改', async () => {
    expect(await settlements.markAbsenceShare('session', 651)).toEqual({
      marked: false,
      reason: 'NO_SETTLEMENT',
    });
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    await enter({ refId: 652 });
    await pool.query(`UPDATE settlement.settlements SET status='SETTLED' WHERE ref_id=652`); // 测试直改终态（夹具）
    expect(await settlements.markAbsenceShare('session', 652)).toEqual({
      marked: false,
      reason: 'SETTLED',
    });
  });

  // =========================================================================
  // G. R-06 fee_versions 版本化 + §10-6 1对1 落表（同口径平台费）
  // =========================================================================

  it('G1 §10-6 1对1 结算落表 ref_type=one_on_one，平台费同 fee_versions 口径（升级 5% 版本后构成含费项）', async () => {
    await seedFirmMerchant(pool, FIRM, 'ACTIVE');
    await pool.query(
      `INSERT INTO settlement.fee_versions (rate, effective_at) VALUES (0.0500, now())`,
    ); // 运营配置升级（H7 位；afterEach 自清）
    const order = await createPaidOrder('200.00');
    const res = await enter({
      refType: 'one_on_one',
      refId: 660,
      gross: '200.00',
      order: order.id,
    });
    expect(res.settlement.platform_fee).toBe('10.00'); // floor(200×0.05)；建行固化
    expect(res.settlement.net).toBe('200.00'); // 分账净额=gross−penalty（fee 为构成项）
    await pool.query(
      `UPDATE settlement.settlements SET created_at = now() - interval '25 hours' WHERE ref_type='one_on_one' AND ref_id=660`,
    );
    const row = await getRow('one_on_one', 660);
    await settlements.releaseDueHold(row!.id as number, 'HOLD_EXPIRED');
    await settlements.runSettlement({ ref_type: 'one_on_one', ref_id: 660 });

    const after = await getRow('one_on_one', 660);
    expect(after!.status).toBe('SETTLED');
    const settled = (await outboxPayloads(SPLIT_SETTLED_TOPIC))[0]!;
    expect(settled).toMatchObject({
      ref_type: 'one_on_one',
      ref_id: 660,
      session_id: null, // one_on_one 无 session 兼容位
      net: '200.00',
      fee: '10.00',
    });
    expect(settled['splits']).toEqual([
      { payee_type: 'lawyer_firm', payee_id: FIRM, amount: '190.00' },
      { payee_type: 'platform', payee_id: 0, amount: '10.00' },
    ]);
  });

  // =========================================================================
  // H. 查询面（§5 GET /lawyer/settlements + /admin/settlements 数据核）
  // =========================================================================

  it('H1 lawyer 列表本人过滤；admin 列表 status 过滤', async () => {
    await enter({ refId: 670, lawyer: LAWYER });
    await enter({ refId: 671, lawyer: LAWYER2, gross: '40.00' });
    const mine = await settlements.listForLawyer(LAWYER);
    expect(mine.map((s) => s.ref_id)).toEqual([670]);
    const holding = await settlements.listForAdmin({ status: 'HOLD' });
    expect(holding.length).toBe(2);
    const settledNone = await settlements.listForAdmin({ status: 'SETTLED' });
    expect(settledNone).toHaveLength(0);
  });
});
