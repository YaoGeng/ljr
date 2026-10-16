import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AppError, ErrorCode, CHANNEL_DEGRADED_TOPIC, assertMoney, type Money } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { ChannelFaultError, ChannelRouter, MockChannelAdapter } from './payment.channels';
import { PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from './payment.alerts';
import { PaymentGatewayService } from './payment.gateway.service';
import { centsToMoney, moneyToCents } from './payment.types';

/**
 * F1 支付网关服务（§4/§5/§7 + Task 1 简报）：下单幂等（同键同载荷重放/异载荷 409）、
 * 金额不变量 cash+points/100=total 全接口断言（Money 字符串禁 float——生成列读回 NUMERIC
 * 字符串）、退款/分账/扣减指令与守卫推进、降级切换 ChannelDegraded 同事务出箱。
 * 生命周期推进用测试直调服务面驱动全状态机（Task 1 简报：HTTP 面以 §5 表为准不扩面）。
 */

const DAY = Date.UTC(2026, 9, 16, 8, 0, 0); // 2026-10-16（Asia/Shanghai 同日）

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

describe('F1 PaymentGatewayService（需 PG）', () => {
  let pool: Pool;
  let svc: PaymentGatewayService;
  let wechat: MockChannelAdapter;
  let alipay: MockChannelAdapter;
  let sink: MockPaymentAlertSink;
  let seq = 0;

  const key = (tag: string): string => `payment/${tag}-${++seq}/pay`;

  const createOrder = (over: Partial<Parameters<PaymentGatewayService['createOrder']>[0]> = {}) =>
    svc.createOrder({
      biz_type: 'enroll',
      biz_id: 101,
      cash_amount: '199.50',
      points_amount: 250,
      idempotency_key: key('order'),
      ...over,
    });

  /** 全生命周期到 PAID（退款/分账用例前置） */
  const orderAtPaid = async (
    over: Partial<Parameters<PaymentGatewayService['createOrder']>[0]> = {},
  ): Promise<{ id: number; cash: Money; points: number }> => {
    const created = await createOrder(over);
    await svc.markFrozen(created.payment_order.id, null);
    await svc.markPaid(created.payment_order.id);
    return {
      id: created.payment_order.id,
      cash: created.payment_order.cash_amount,
      points: created.payment_order.points_amount,
    };
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    // 每用例重建适配器/路由/服务：路由降级窗口是进程内状态，用例间必须隔离
    const cfg = testConfig();
    wechat = new MockChannelAdapter(
      'wechat_ecom',
      cfg.primary.merchantId,
      cfg.primary.secret,
      () => new Date(DAY),
    );
    alipay = new MockChannelAdapter(
      'alipay',
      cfg.backup.merchantId,
      cfg.backup.secret,
      () => new Date(DAY),
    );
    const router = new ChannelRouter({
      adapters: [wechat, alipay],
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

  afterAll(async () => {
    await pool.end();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------- 下单（§5 POST /pay/orders 语义） ----------

  it('下单：CREATED 落单 + mock pay_params 含 order_id；金额不变量 total=cash+points/100 生成列读回字符串', async () => {
    const res = await createOrder({ cash_amount: '199.50', points_amount: 250 });
    expect(res.payment_order.status).toBe('CREATED');
    expect(res.payment_order.channel).toBe('wechat_ecom');
    expect(res.payment_order.total).toBe('202.00'); // 199.50 + 2.50，Money 字符串
    expect(res.payment_order.idempotency_key).toBeTruthy();
    expect(res.pay_params.order_id).toBe(res.payment_order.id);
    expect(res.pay_params.mock_pay_url).toContain('mockpay://wechat_ecom/pay');
    expect(res.pay_params.mock_pay_url).toContain(`order_id=${res.payment_order.id}`);

    const row = await pool.query<{ total: string; channel_txn_no: string }>(
      `SELECT total::text AS total, channel_txn_no FROM payment.payment_orders WHERE id = $1`,
      [res.payment_order.id],
    );
    expect(row.rows[0]!.total).toBe('202.00'); // NUMERIC 生成列字符串往返（禁 float）
    expect(row.rows[0]!.channel_txn_no).toMatch(/^MOCK-WECHAT-\d{6}$/);
  });

  it('金额不变量全接口成立：边界组合（0.01+1 分、0+0、大额）生成列逐字', async () => {
    const a = await createOrder({ cash_amount: '0.01', points_amount: 1 });
    expect(a.payment_order.total).toBe('0.02');
    const b = await createOrder({ cash_amount: '0.00', points_amount: 0 });
    expect(b.payment_order.total).toBe('0.00');
    const c = await createOrder({ cash_amount: '99999999.99', points_amount: 999 });
    expect(c.payment_order.total).toBe('100000009.98'); // 99999999.99 + 9.99（999 积分）
  });

  it('非法金额/积分/业务类型/幂等键：422/400 拒绝，不落单', async () => {
    await expect(createOrder({ cash_amount: '199.5' })).rejects.toMatchObject({
      code: ErrorCode.MoneyInvalidFormat,
    });
    await expect(createOrder({ cash_amount: '-1.00' })).rejects.toMatchObject({
      code: ErrorCode.MoneyInvalidFormat,
    });
    await expect(createOrder({ points_amount: -1 })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(createOrder({ points_amount: 1.5 })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(createOrder({ biz_type: 'foo' })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await expect(createOrder({ idempotency_key: 'not-a-valid-key' })).rejects.toMatchObject({
      code: ErrorCode.IdempotencyKeyInvalid,
    });
    const n = await pool.query(`SELECT count(*)::int AS n FROM payment.payment_orders`);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('R-02 幂等：同键同载荷=重放原单+原 pay_params（恰一次）；同键异载荷=409 E_DUP_KEY', async () => {
    const first = await createOrder({ idempotency_key: 'payment/same-key/pay' });
    const replay = await createOrder({ idempotency_key: 'payment/same-key/pay' });
    expect(replay.payment_order.id).toBe(first.payment_order.id);
    expect(replay.payment_order.channel).toBe(first.payment_order.channel);
    expect(replay.pay_params.mock_pay_url).toBe(first.pay_params.mock_pay_url); // 确定性重建=原参数
    await expect(
      createOrder({ idempotency_key: 'payment/same-key/pay', cash_amount: '299.50' }),
    ).rejects.toMatchObject({ code: ErrorCode.PaymentDuplicateKey });

    const n = await pool.query(`SELECT count(*)::int AS n FROM payment.payment_orders`);
    expect(n.rows[0]!.n).toBe(1); // 恰一次
  });

  it('R-02 并发缺口（claim 冲突分支覆盖）：同键异载荷经冲突路径 → 409；同键同载荷经冲突路径 → 原单', async () => {
    // 确定性构造：未提交事务先占唯一键（模拟并发首访在飞），快路径读不到 → 进入事务 →
    // claim 撞唯一键败退走冲突分支；阻塞者提交后冲突分支读回比对载荷。
    const runConflictPath = async (
      key: string,
      stored: { bizId: number; cash: string; points: number },
      caller: { bizId: number; cash: string; points: number },
    ): Promise<{ id: number } | { code: string }> => {
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `INSERT INTO payment.payment_orders
             (biz_type, biz_id, channel, cash_amount, points_amount, status, idempotency_key)
           VALUES ('enroll', $1, 'wechat_ecom', $2::numeric, $3, 'CREATED', $4)`,
          [stored.bizId, stored.cash, stored.points, key],
        );
        const loser = svc.createOrder({
          biz_type: 'enroll',
          biz_id: caller.bizId,
          cash_amount: caller.cash,
          points_amount: caller.points,
          idempotency_key: key,
        });
        await new Promise((r) => setTimeout(r, 150)); // 让 loser 进入 claim 唯一键等待
        await blocker.query('COMMIT'); // 提交阻塞者 → loser 的 claim 败退（冲突分支）
        try {
          const res = await loser;
          return { id: res.payment_order.id };
        } catch (e) {
          return { code: (e as { code?: string }).code ?? 'UNKNOWN' };
        }
      } finally {
        blocker.release();
      }
    };

    // 异载荷经冲突路径 → 409 E_DUP_KEY（修复点：冲突分支必须比对载荷）
    const conflict = await runConflictPath(
      'payment/conflict-diff/pay',
      { bizId: 888, cash: '199.50', points: 250 },
      { bizId: 999, cash: '100.00', points: 0 },
    );
    expect(conflict).toEqual({ code: ErrorCode.PaymentDuplicateKey });

    // 同载荷经冲突路径 → 原单（恰一次语义不受并发影响）
    const ok = await runConflictPath(
      'payment/conflict-same/pay',
      { bizId: 777, cash: '50.00', points: 10 },
      { bizId: 777, cash: '50.00', points: 10 },
    );
    expect('id' in ok).toBe(true);
    const stored = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM payment.payment_orders WHERE idempotency_key = 'payment/conflict-same/pay'`,
    );
    expect((ok as { id: number }).id).toBe(Number(stored.rows[0]!.id));

    const n = await pool.query(`SELECT count(*)::int AS n FROM payment.payment_orders`);
    expect(n.rows[0]!.n).toBe(2); // 每键恰一单
  });

  it('降级切换：主通道 5xx 注入 → 备用通道接管落单 + ChannelDegraded 同事务出箱（恰一次）', async () => {
    wechat.fault = { kind: 'CHANNEL_ERROR' };
    const res = await createOrder();
    expect(res.payment_order.channel).toBe('alipay');
    expect(res.pay_params.mock_pay_url).toContain('mockpay://alipay/pay');

    // 第二单：仍在降级窗口 → 继续备用，但不重复出箱
    const second = await createOrder();
    expect(second.payment_order.channel).toBe('alipay');

    const events = await pool.query<{ payload: { channel: string } }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [CHANNEL_DEGRADED_TOPIC],
    );
    expect(events.rows.length).toBe(1); // 恰首次翻动
    expect(events.rows[0]!.payload.channel).toBe('wechat_ecom');
  });

  // ---------- 生命周期推进（守卫 + STL 留痕） ----------

  it('markFrozen：CREATED→FROZEN 落 paid_at 与通道流水号；STL 允许留痕', async () => {
    const created = await createOrder();
    const frozen = await svc.markFrozen(created.payment_order.id, 'CHN-EXT-1');
    expect(frozen.status).toBe('FROZEN');
    expect(frozen.paid_at).not.toBeNull();
    expect(frozen.channel_txn_no).toBe('CHN-EXT-1');

    const stl = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log
        WHERE entity_type = 'payment_order' AND entity_id = $1 AND to_status = 'FROZEN'`,
      [created.payment_order.id],
    );
    expect(stl.rows[0]!.allowed).toBe(true);
  });

  it('非法推进：markPaid 作用于 CREATED → StateIllegalTransition + STL 拒绝留痕（独立连接不随业务回滚）', async () => {
    const created = await createOrder();
    await expect(svc.markPaid(created.payment_order.id)).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
    });
    const stl = await pool.query<{ allowed: boolean; from_status: string; to_status: string }>(
      `SELECT allowed, from_status, to_status FROM platform.state_transition_log
        WHERE entity_type = 'payment_order' AND entity_id = $1`,
      [created.payment_order.id],
    );
    expect(stl.rows.length).toBe(1);
    expect(stl.rows[0]!.allowed).toBe(false);
    expect(stl.rows[0]!.from_status).toBe('CREATED');
    expect(stl.rows[0]!.to_status).toBe('PAID');
  });

  it('全生命周期 CREATED→FROZEN→PAID→SPLIT→CLOSED 守卫推进，STL 全允许；PAID→CLOSED 直关拒绝', async () => {
    const created = await createOrder({ cash_amount: '100.00', points_amount: 0 });
    const id = created.payment_order.id;
    await svc.markFrozen(id, null);
    await svc.markPaid(id);
    const split = await svc.split({
      order_id: id,
      splits: [{ payee_type: 'lawyer_firm', payee_id: 1, amount: '100.00' }],
      idempotency_key: 'payment/split-full/split',
    });
    expect(split.order_status).toBe('SPLIT');
    const closed = await svc.closeOrder(id, '归档');
    expect(closed.status).toBe('CLOSED');

    const stl = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log
        WHERE entity_type = 'payment_order' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(stl.rows.map((r) => r.allowed)).toEqual([true, true, true, true]);

    // PAID→CLOSED 直关拒绝（须先退款或分账）
    const paid2 = await orderAtPaid();
    await expect(svc.closeOrder(paid2.id, '非法直关')).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
    });
  });

  // ---------- 退款（§5 POST /pay/refund 语义，R-03） ----------

  it('退款：指令下发 → REFUNDING + REFUND 流水 CONFIRMED；markRefunded 回调推进 REFUNDED；全额走 refund 原语', async () => {
    const { id } = await orderAtPaid({ cash_amount: '199.50', points_amount: 250 });
    const before = wechat.journalSize();
    const res = await svc.refund({
      order_id: id,
      cash_refund: '199.50',
      points_refund: 250,
      reason: '用户取消',
      idempotency_key: 'payment/refund-full/refund',
    });
    expect(res.direction).toBe('REFUND');
    expect(res.amount).toBe('202.00'); // 退款总额=cash+points/100
    expect(res.status).toBe('CONFIRMED');

    const order = await pool.query<{ status: string }>(
      `SELECT status FROM payment.payment_orders WHERE id = $1`,
      [id],
    );
    expect(order.rows[0]!.status).toBe('REFUNDING');

    const refunded = await svc.markRefunded(id, null);
    expect(refunded.status).toBe('REFUNDED');

    // 全额退款走 adapter.refund（账单 REFUND 行金额=退款总额）
    const lines = await wechat.statement('2026-10-16');
    expect(lines.length).toBe(before + 1);
    expect(lines[lines.length - 1]!.direction).toBe('REFUND');
    expect(lines[lines.length - 1]!.amount).toBe('202.00');
  });

  it('部分退款走 partialRefund 原语；累计退款超 total → 400', async () => {
    const { id } = await orderAtPaid({ cash_amount: '100.00', points_amount: 0 });
    const first = await svc.refund({
      order_id: id,
      cash_refund: '40.00',
      points_refund: 0,
      reason: '部分1',
      idempotency_key: 'payment/refund-p1/refund',
    });
    expect(first.amount).toBe('40.00');

    await svc.refund({
      order_id: id,
      cash_refund: '60.00',
      points_refund: 0,
      reason: '部分2',
      idempotency_key: 'payment/refund-p2/refund',
    });

    await expect(
      svc.refund({
        order_id: id,
        cash_refund: '0.01',
        points_refund: 0,
        reason: '超额',
        idempotency_key: 'payment/refund-p3/refund',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });

    await expect(
      svc.refund({
        order_id: id,
        cash_refund: '100.01',
        points_refund: 0,
        reason: '单笔超总',
        idempotency_key: 'payment/refund-p4/refund',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });

  it('退款幂等：同键同载荷=同流水重放（不再推进状态）；同键异载荷=409 E_DUP_KEY；CREATED 退款被守卫拒', async () => {
    const { id } = await orderAtPaid();
    const first = await svc.refund({
      order_id: id,
      cash_refund: '99.75',
      points_refund: 125,
      reason: 'r1',
      idempotency_key: 'payment/refund-idem/refund',
    });
    const replay = await svc.refund({
      order_id: id,
      cash_refund: '99.75',
      points_refund: 125,
      reason: 'r1',
      idempotency_key: 'payment/refund-idem/refund',
    });
    expect(replay.ledger_id).toBe(first.ledger_id);

    await expect(
      svc.refund({
        order_id: id,
        cash_refund: '50.00',
        points_refund: 0,
        reason: 'r2',
        idempotency_key: 'payment/refund-idem/refund',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PaymentDuplicateKey });

    // 未冻结支付即退款：CREATED→REFUNDING 非法
    const created = await createOrder();
    await expect(
      svc.refund({
        order_id: created.payment_order.id,
        cash_refund: '1.00',
        points_refund: 0,
        reason: '早退',
        idempotency_key: 'payment/refund-early/refund',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateIllegalTransition });
  });

  // ---------- 分账（§5 POST /pay/split 语义，唯一解冻节点） ----------

  it('分账：splits 求和 ≤ 可分金额 → SPLIT + split_detail 持久化 + SPLIT 流水；求和超 total → 400', async () => {
    const { id } = await orderAtPaid({ cash_amount: '100.00', points_amount: 100 });
    const res = await svc.split({
      order_id: id,
      splits: [
        { payee_type: 'lawyer_firm', payee_id: 7, amount: '90.00' },
        { payee_type: 'platform', payee_id: 0, amount: '11.00' },
      ],
      idempotency_key: 'payment/split-ok/split',
    });
    expect(res.amount).toBe('101.00'); // 可分上限=total=101.00
    expect(res.order_status).toBe('SPLIT');

    const row = await pool.query<{ split_detail: { splits: unknown[] }; status: string }>(
      `SELECT split_detail, status FROM payment.payment_orders WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]!.status).toBe('SPLIT');
    expect(row.rows[0]!.split_detail.splits.length).toBe(2);

    // 超额
    const other = await orderAtPaid({ cash_amount: '10.00', points_amount: 0 });
    await expect(
      svc.split({
        order_id: other.id,
        splits: [{ payee_type: 'lawyer_firm', payee_id: 7, amount: '10.01' }],
        idempotency_key: 'payment/split-over/split',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });

  it('分账幂等（同键重放/异载荷 409）；FROZEN 未确认支付分账被守卫拒（唯一解冻节点）', async () => {
    const { id } = await orderAtPaid();
    const first = await svc.split({
      order_id: id,
      splits: [{ payee_type: 'lawyer_firm', payee_id: 7, amount: '202.00' }],
      idempotency_key: 'payment/split-idem/split',
    });
    const replay = await svc.split({
      order_id: id,
      splits: [{ payee_type: 'lawyer_firm', payee_id: 7, amount: '202.00' }],
      idempotency_key: 'payment/split-idem/split',
    });
    expect(replay.ledger_id).toBe(first.ledger_id);
    await expect(
      svc.split({
        order_id: id,
        splits: [{ payee_type: 'lawyer_firm', payee_id: 8, amount: '202.00' }],
        idempotency_key: 'payment/split-idem/split',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PaymentDuplicateKey });

    // FROZEN（未业务确认）不得分账
    const created = await createOrder();
    await svc.markFrozen(created.payment_order.id, null);
    await expect(
      svc.split({
        order_id: created.payment_order.id,
        splits: [{ payee_type: 'lawyer_firm', payee_id: 7, amount: '202.00' }],
        idempotency_key: 'payment/split-frozen/split',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateIllegalTransition });
  });

  // ---------- 违约扣减（§5 POST /pay/deduct 语义） ----------

  it('扣减：成功落 DEDUCT 流水（detail=lawyer_id/from）；INSUFFICIENT 应答 → 400 E_INSUFFICIENT 且不落流水', async () => {
    const res = await svc.deduct({
      lawyer_id: 9101,
      amount: '30.00',
      from: 'settlement',
      idempotency_key: 'payment/deduct-1/deduct',
    });
    expect(res.direction).toBe('DEDUCT');
    expect(res.status).toBe('CONFIRMED');
    expect(res.amount).toBe('30.00');

    alipay.fault = null;
    wechat.fault = { kind: 'INSUFFICIENT' };
    await expect(
      svc.deduct({
        lawyer_id: 9101,
        amount: '999.00',
        from: 'deposit',
        idempotency_key: 'payment/deduct-2/deduct',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InsufficientFunds });

    const n = await pool.query(`SELECT count(*)::int AS n FROM payment.split_ledgers`);
    expect(n.rows[0]!.n).toBe(1); // 失败尝试不落流水（事务回滚，幂等键不烧）
  });

  it('扣减幂等（同键重放/异载荷 409）；主通道故障 → 备用接管 + ChannelDegraded 出箱', async () => {
    const first = await svc.deduct({
      lawyer_id: 9101,
      amount: '30.00',
      from: 'settlement',
      idempotency_key: 'payment/deduct-idem/deduct',
    });
    const replay = await svc.deduct({
      lawyer_id: 9101,
      amount: '30.00',
      from: 'settlement',
      idempotency_key: 'payment/deduct-idem/deduct',
    });
    expect(replay.ledger_id).toBe(first.ledger_id);
    await expect(
      svc.deduct({
        lawyer_id: 9101,
        amount: '31.00',
        from: 'settlement',
        idempotency_key: 'payment/deduct-idem/deduct',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PaymentDuplicateKey });

    wechat.fault = { kind: 'CHANNEL_ERROR' };
    const viaBackup = await svc.deduct({
      lawyer_id: 9102,
      amount: '5.00',
      from: 'deposit',
      idempotency_key: 'payment/deduct-failover/deduct',
    });
    expect(viaBackup.channel).toBe('alipay');
    const events = await pool.query(`SELECT topic FROM platform.outbox WHERE topic = $1`, [
      CHANNEL_DEGRADED_TOPIC,
    ]);
    expect(events.rows.length).toBe(1);
  });

  // ---------- 金额工具（Money 字符串往返禁 float） ----------

  it('moneyToCents/centsToMoney 严格两位小数整数分往返', () => {
    expect(moneyToCents('199.50')).toBe(19950);
    expect(centsToMoney(19950)).toBe('199.50');
    expect(centsToMoney(0)).toBe('0.00');
    expect(() => moneyToCents('1.005')).toThrow();
    assertMoney('199.50');
  });

  it('ChannelFaultError 非 AppError（通道侧错误不混入 API 契约错误面）', () => {
    const e = new ChannelFaultError('CHANNEL_ERROR', 'wechat_ecom', 'x');
    expect(e).not.toBeInstanceOf(AppError);
  });
});
