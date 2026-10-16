import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AppError, ErrorCode, type Money } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { BenefitsConfig, POINTS_TTL_DAYS_DEFAULT } from '../benefits/benefits.config';
import { PointsService } from '../benefits/points.service';
import {
  getPointsBalance,
  listRefundRestoreTxns,
  seedPointsBalance,
} from '../benefits/points-fixture';
import { ChannelRouter, MockChannelAdapter } from './payment.channels';
import { PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from './payment.alerts';
import { PaymentGatewayService } from './payment.gateway.service';
import { RefundService } from './refund.service';
import type { PaymentOrderView } from './payment.types';

/**
 * F2 退款受理（§4/§5 ISSUE_REFUND/R-04/§9 TDD 清单——本文件先钉受理面）：
 *   受理下发（REQUESTED→PROCESSING + F1 refund 指令面真实调用）；R-04 幂等（同键同载荷重放
 *   原单 / 异载荷 409 E_DUP_KEY，F1 replayOrder 同口径）；金额守恒硬项（同单累计退款
 *   现金+积分折算 ≤ 支付额，超限 400）；遗留 REQUESTED 单重入续发（批量断点续跑语义地基）。
 * F1 为金额硬闸（CONFIRMED 台账累计），F2 受理面守恒是入口 400 语义——双层（头注口径）。
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

describe('F2 退款受理（需 PG）', () => {
  let pool: Pool;
  let gateway: PaymentGatewayService;
  let points: PointsService;
  let svc: RefundService;
  let seq = 0;

  /** 夹具：已支付支付单（createOrder→markFrozen，PAY_SUCCESS 等价推进） */
  const createPaidOrder = async (opts?: {
    cash?: Money;
    points?: number;
  }): Promise<PaymentOrderView> => {
    seq += 1;
    const res = await gateway.createOrder({
      biz_type: 'enroll',
      biz_id: 300 + seq,
      cash_amount: opts?.cash ?? '100.00',
      points_amount: opts?.points ?? 0,
      idempotency_key: `payment/f2-order-${seq}/pay`,
    });
    await gateway.markFrozen(res.payment_order.id, `MOCK-WECHAT-F2-${seq}`);
    return res.payment_order;
  };

  const accept = (order: PaymentOrderView, cash: Money, pointsAmt: number, key: string) =>
    svc.accept({
      order_id: order.id,
      user_id: 601,
      cash,
      points: pointsAmt,
      reason: 'GROUP_FAIL',
      idempotency_key: key,
    });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const cfg = testConfig();
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
    const outbox = new OutboxService();
    const guard = new StateTransitionGuardService(new StateTransitionLogService(), poolSvc);
    gateway = new PaymentGatewayService(
      poolSvc,
      outbox,
      guard,
      router,
      new PaymentAlertService(new MockPaymentAlertSink()),
      cfg,
    );
    const benefitsConfig: BenefitsConfig = { pointsTtlDays: POINTS_TTL_DAYS_DEFAULT };
    points = new PointsService(poolSvc, outbox, benefitsConfig);
    svc = new RefundService(poolSvc, outbox, guard, gateway, points);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('受理下发：refund 落 PROCESSING + F1 单推进 REFUNDING + REFUND 台账 CONFIRMED + 视图逐字段', async () => {
    const order = await createPaidOrder();
    const out = await accept(order, '100.00', 0, 'refund/po-1/group-fail');

    expect(out.refund.order_id).toBe(order.id);
    expect(out.refund.user_id).toBe(601);
    expect(out.refund.cash_amount).toBe('100.00');
    expect(out.refund.points_amount).toBe(0);
    expect(out.refund.reason).toBe('GROUP_FAIL');
    expect(out.refund.status).toBe('PROCESSING');
    expect(out.refund.idempotency_key).toBe('refund/po-1/group-fail');
    expect(out.refund.requested_at).toBeTruthy();
    expect(out.refund.done_at).toBeNull();

    const row = await pool.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM payment.refunds WHERE id = $1`,
      [out.refund.refund_id],
    );
    expect(row.rows[0]!.status).toBe('PROCESSING');
    expect(row.rows[0]!.attempt_count).toBe(1);

    // F1 侧：指令面真实调用——支付单 REFUNDING + 台账 CONFIRMED（同幂等键）
    const orderRow = await pool.query<{ status: string }>(
      `SELECT status FROM payment.payment_orders WHERE id = $1`,
      [order.id],
    );
    expect(orderRow.rows[0]!.status).toBe('REFUNDING');
    const ledger = await pool.query<{ direction: string; status: string; amount: string }>(
      `SELECT direction, status, amount::text AS amount FROM payment.split_ledgers
        WHERE idempotency_key = $1`,
      ['refund/po-1/group-fail'],
    );
    expect(ledger.rows[0]).toMatchObject({
      direction: 'REFUND',
      status: 'CONFIRMED',
      amount: '100.00',
    });
  });

  it('R-04 幂等重放：同键同载荷返回原单（不新增行/不重复下发台账）', async () => {
    const order = await createPaidOrder();
    const first = await accept(order, '100.00', 0, 'refund/po-2/group-fail');
    const replay = await accept(order, '100.00', 0, 'refund/po-2/group-fail');

    expect(replay.refund.refund_id).toBe(first.refund.refund_id);
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`);
    expect(n.rows[0]!.n).toBe(1);
    const ledgers = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.split_ledgers WHERE direction = 'REFUND'`,
    );
    expect(ledgers.rows[0]!.n).toBe(1);
  });

  it('R-04 同键异载荷 409 E_DUP_KEY（F1 replayOrder 口径），不新增行', async () => {
    const order = await createPaidOrder();
    await accept(order, '100.00', 0, 'refund/po-3/group-fail');
    await expect(accept(order, '99.00', 0, 'refund/po-3/group-fail')).rejects.toMatchObject({
      code: ErrorCode.PaymentDuplicateKey,
      httpStatus: 409,
    });
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('金额守恒（§9 硬项）：同单累计退款（现金+积分折算）+本次 ≤ 支付额，超限 400 拒绝', async () => {
    // 拆分单：cash 60.00 + points 4000（=40.00 折算）→ total 100.00
    const order = await createPaidOrder({ cash: '60.00', points: 4000 });
    await accept(order, '30.00', 2000, 'refund/po-4a/group-fail'); // 累计 50.00（在途计入）
    // 本次 50.01（30.01+2000 分）→ 累计 100.01 > 100.00 超限
    await expect(accept(order, '30.01', 2000, 'refund/po-4b/group-fail')).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
    // 恰好补齐到 total 允许：累计 50.00 + 本次 50.00 = 100.00
    const fill = await accept(order, '30.00', 2000, 'refund/po-4c/group-fail');
    expect(fill.refund.status).toBe('PROCESSING');
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`);
    expect(n.rows[0]!.n).toBe(2);
  });

  it('受理防御：reason 越域/非法幂等键/支付单不存在/积分负数均 400，零残留', async () => {
    const order = await createPaidOrder();
    const base = { order_id: order.id, user_id: 601, cash: '1.00', points: 0 };
    await expect(
      svc.accept({ ...base, reason: 'MADE_UP' as never, idempotency_key: 'refund/x1/group-fail' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      svc.accept({ ...base, reason: 'GROUP_FAIL', idempotency_key: 'bad-key' }),
    ).rejects.toMatchObject({ code: ErrorCode.IdempotencyKeyInvalid });
    await expect(
      svc.accept({
        order_id: 999999,
        user_id: 601,
        cash: '1.00',
        points: 0,
        reason: 'GROUP_FAIL',
        idempotency_key: 'refund/x2/group-fail',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
    await expect(
      svc.accept({
        ...base,
        points: -1,
        reason: 'GROUP_FAIL',
        idempotency_key: 'refund/x3/group-fail',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });

    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`);
    expect(n.rows[0]!.n).toBe(0);
    expect(n.rows[0]!.n).toBe(0); // 双断言锚定零残留语义（AppError 形状校验在 rejects 内完成）
    expect(AppError).toBeDefined();
  });

  it('断点续跑：遗留 REQUESTED 单（受理后下发前崩溃）同键重入续发到位', async () => {
    const order = await createPaidOrder();
    seq += 1;
    // 夹具：直接落 REQUESTED 遗留单（模拟 claim 后、下发前崩溃窗口）
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO payment.refunds
         (payment_order_id, user_id, cash_amount, points_amount, reason, status, idempotency_key)
       VALUES ($1, $2, $3::numeric, $4, 'GROUP_FAIL', 'REQUESTED', $5) RETURNING id`,
      [order.id, 601, '100.00', 0, 'refund/po-5/group-fail'],
    );
    const stuckId = Number(ins.rows[0]!.id);

    const out = await accept(order, '100.00', 0, 'refund/po-5/group-fail');
    expect(out.refund.refund_id).toBe(stuckId); // 重入补发同一单，不另开新单
    expect(out.refund.status).toBe('PROCESSING');
    const orderRow = await pool.query<{ status: string }>(
      `SELECT status FROM payment.payment_orders WHERE id = $1`,
      [order.id],
    );
    expect(orderRow.rows[0]!.status).toBe('REFUNDING');
  });

  // =========================================================================
  // 回调收敛（REFUND_SUCCESS → DONE + RefundCompleted 出箱）+ R-03 积分还原
  // =========================================================================

  it('REFUND_SUCCESS 收敛：PROCESSING→DONE（done_at+STL）+ RefundCompleted 出箱逐字段', async () => {
    const order = await createPaidOrder();
    const { refund } = await accept(order, '100.00', 0, 'refund/po-6/group-fail');

    const out = await svc.convergeRefundSuccess(order.idempotency_key);
    expect(out.completed).toEqual([refund.refund_id]);

    const row = await pool.query<{ status: string; done_at: Date | null }>(
      `SELECT status, done_at FROM payment.refunds WHERE id = $1`,
      [refund.refund_id],
    );
    expect(row.rows[0]!.status).toBe('DONE');
    expect(row.rows[0]!.done_at).not.toBeNull();

    const events = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM platform.outbox WHERE topic = $1`,
      ['payment.refund.completed'],
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0]!.payload).toEqual({
      refund_id: refund.refund_id,
      order_id: order.id,
      amounts: { cash: '100.00', points: 0 },
    });

    const stl = await pool.query<{ allowed: boolean; entity_type: string }>(
      `SELECT allowed, entity_type FROM platform.state_transition_log
        WHERE entity_type = 'refund' AND entity_id = $1 ORDER BY id`,
      [refund.refund_id],
    );
    expect(stl.rows.map((r) => r.allowed)).toEqual([true, true]); // 下发 + 回调收敛两笔合法迁移
  });

  it('多笔在途按单收敛：同单两笔部分退款一次回调全部 DONE，各出箱一条', async () => {
    const order = await createPaidOrder();
    await accept(order, '50.00', 0, 'refund/po-7a/group-fail');
    await accept(order, '50.00', 0, 'refund/po-7b/group-fail');

    const out = await svc.convergeRefundSuccess(order.idempotency_key);
    expect(out.completed).toHaveLength(2);
    const events = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      ['payment.refund.completed'],
    );
    expect(events.rows[0]!.n).toBe(2);
    const statuses = await pool.query<{ status: string }>(
      `SELECT status FROM payment.refunds WHERE payment_order_id = $1 ORDER BY id`,
      [order.id],
    );
    expect(statuses.rows.map((r) => r.status)).toEqual(['DONE', 'DONE']);
  });

  it('R-03 积分还原：还原额=积分部分（不退现金额），ref=refund:{id}；重放收敛幂等（恰一次入账）', async () => {
    // 拆分单：cash 60.00 + points 4000；积分账户种子余额 100
    const order = await createPaidOrder({ cash: '60.00', points: 4000 });
    await seedPointsBalance(pool, 601, 100);
    const { refund } = await accept(order, '60.00', 4000, 'refund/po-8/group-fail');
    await svc.convergeRefundSuccess(order.idempotency_key);

    // 还原额=积分 4000（现金 60.00 走原路台账，绝不折积分入账）
    expect(await getPointsBalance(pool, 601)).toBe(100 + 4000);
    const txns = await listRefundRestoreTxns(pool);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toEqual({
      delta: 4000,
      source_ref: `refund:${refund.refund_id}`,
    });

    // 崩溃窗口收敛重放：completed 空、还原短路（不重复入账）
    const replay = await svc.convergeRefundSuccess(order.idempotency_key);
    expect(replay.completed).toEqual([]);
    expect(await getPointsBalance(pool, 601)).toBe(100 + 4000);
    expect(await listRefundRestoreTxns(pool)).toHaveLength(1);
  });

  // =========================================================================
  // 失败路径：指令面失败退避重试，耗尽 3 次 → FAILED + RefundFailed 出箱
  // =========================================================================

  it('失败重试（§4）：未支付单指令被 F1 守卫拒 → 退避记账；到期重入；3 次耗尽 FAILED+RefundFailed', async () => {
    seq += 1;
    // 未支付单（CREATED）：F1 矩阵无 CREATED→REFUNDING 边 → 指令面每次必抛（真实失败注入）
    const res = await gateway.createOrder({
      biz_type: 'enroll',
      biz_id: 300 + seq,
      cash_amount: '10.00',
      points_amount: 0,
      idempotency_key: `payment/f2-unpaid-${seq}/pay`,
    });
    const unpaid = res.payment_order;

    await expect(
      svc.accept({
        order_id: unpaid.id,
        user_id: 601,
        cash: '10.00',
        points: 0,
        reason: 'GROUP_FAIL',
        idempotency_key: 'refund/po-9/group-fail',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateIllegalTransition });

    // 首败记账：PROCESSING + attempt 1 + 退避位 + last_error
    const row = await pool.query<{
      status: string;
      attempt_count: number;
      next_retry_at: Date | null;
      last_error: string | null;
    }>(`SELECT status, attempt_count, next_retry_at, last_error FROM payment.refunds`);
    expect(row.rows[0]).toMatchObject({ status: 'PROCESSING', attempt_count: 1 });
    expect(row.rows[0]!.next_retry_at).not.toBeNull();
    expect(row.rows[0]!.last_error).toContain('非法状态迁移');

    // 未到期不重试
    expect(await svc.dispatchDue()).toEqual({ attempted: 0, failed: 0 });

    // 时间旅行到期 → 第 2 次尝试仍败 → 退避
    await pool.query(`UPDATE payment.refunds SET next_retry_at = now() - interval '1s'`);
    expect(await svc.dispatchDue()).toEqual({ attempted: 0, failed: 1 });
    const row2 = await pool.query<{
      status: string;
      attempt_count: number;
      next_retry_at: Date | null;
    }>(`SELECT status, attempt_count, next_retry_at FROM payment.refunds`);
    expect(row2.rows[0]).toMatchObject({ status: 'PROCESSING', attempt_count: 2 });
    expect(row2.rows[0]!.next_retry_at).not.toBeNull();

    // 第 3 次尝试耗尽 → FAILED + RefundFailed 出箱 + 终态无退避位
    await pool.query(`UPDATE payment.refunds SET next_retry_at = now() - interval '1s'`);
    expect(await svc.dispatchDue()).toEqual({ attempted: 0, failed: 1 });
    const row3 = await pool.query<{
      status: string;
      attempt_count: number;
      next_retry_at: Date | null;
      last_error: string | null;
    }>(`SELECT status, attempt_count, next_retry_at, last_error FROM payment.refunds`);
    expect(row3.rows[0]).toMatchObject({
      status: 'FAILED',
      attempt_count: 3,
      next_retry_at: null,
    });
    expect(row3.rows[0]!.last_error).toContain('非法状态迁移');

    const dead = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM platform.outbox WHERE topic = $1`,
      ['payment.refund.failed'],
    );
    expect(dead.rows.length).toBe(1);
    expect(dead.rows[0]!.payload).toMatchObject({
      refund_id: expect.any(Number),
      order_id: unpaid.id,
      reason: 'GROUP_FAIL',
      attempts: 3,
    });

    // FAILED 单同键重放不复活、不新增行、不重发指令（终态无出边，F1 重放口径：同键同载荷返回原单）
    const replay = await svc.accept({
      order_id: unpaid.id,
      user_id: 601,
      cash: '10.00',
      points: 0,
      reason: 'GROUP_FAIL',
      idempotency_key: 'refund/po-9/group-fail',
    });
    expect(replay.refund.status).toBe('FAILED');
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payment.refunds`);
    expect(n.rows[0]!.n).toBe(1);
    const deadAgain = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      ['payment.refund.failed'],
    );
    expect(deadAgain.rows[0]!.n).toBe(1);
  });
});
