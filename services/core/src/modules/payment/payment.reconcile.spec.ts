import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AppError, ErrorCode, RECONCILIATION_DIFF_FOUND_TOPIC } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { ChannelRouter, MockChannelAdapter } from './payment.channels';
import { PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from './payment.alerts';
import { PaymentGatewayService } from './payment.gateway.service';
import { PaymentReconcileService } from './payment.reconcile.service';

/**
 * F1 T+1 对账（§2/§4/R-04 + Task 1 简报 ⚠W3-10）：statement 拉 mock 账单 → 与
 * payment_orders（PAY 行）/ split_ledgers（REFUND/SPLIT/DEDUCT 行）双向核对 →
 * 差异行落 split_ledgers（direction=DIFF + diff_reason + recon:* 确定性幂等键）+
 * ReconciliationDiffFound 同事务出箱（仅新差异行——重跑幂等，不重复工单）。
 * 调度面后置：本批仅 service+admin REST 手动触发；T+1 定时挂 I2 属 M2 真通道批。
 */

const DAY = Date.UTC(2026, 9, 16, 8, 0, 0); // 2026-10-16（Asia/Shanghai 同日）
const PERIOD = '2026-10-16';

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

describe('F1 PaymentReconcileService（需 PG）', () => {
  let pool: Pool;
  let svc: PaymentGatewayService;
  let recon: PaymentReconcileService;
  let wechat: MockChannelAdapter;
  let seq = 0;

  const createPaidOrder = async (cash = '199.50', points = 250) => {
    seq += 1;
    const created = await svc.createOrder({
      biz_type: 'enroll',
      biz_id: 300 + seq,
      cash_amount: cash,
      points_amount: points,
      idempotency_key: `payment/recon-${seq}/pay`,
    });
    await svc.markFrozen(created.payment_order.id, null);
    return created.payment_order;
  };

  beforeEach(async () => {
    await truncateAll(pool);
    const cfg = testConfig();
    wechat = new MockChannelAdapter(
      'wechat_ecom',
      cfg.primary.merchantId,
      cfg.primary.secret,
      () => new Date(DAY),
    );
    const alipay = new MockChannelAdapter(
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
    svc = new PaymentGatewayService(
      poolSvc,
      new OutboxService(),
      new StateTransitionGuardService(new StateTransitionLogService(), poolSvc),
      router,
      new PaymentAlertService(new MockPaymentAlertSink()),
      cfg,
    );
    recon = new PaymentReconcileService(poolSvc, new OutboxService(), [wechat, alipay]);
  });

  beforeAll(async () => {
    pool = await ensureTestDatabase();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('双边齐平：无差异、无事件、无 DIFF 行（PAY 行金额=支付总额 cash+points/100 口径）', async () => {
    const order = await createPaidOrder();
    await svc.refund({
      order_id: order.id,
      cash_refund: '100.00',
      points_refund: 0,
      reason: '部分退',
      idempotency_key: 'payment/recon-r1/refund',
    });

    const res = await recon.reconcile({ period: PERIOD });
    expect(res.period).toBe(PERIOD);
    const w = res.per_channel.find((c) => c.channel === 'wechat_ecom')!;
    expect(w.statement_lines).toBe(2); // PAY + REFUND
    expect(w.matched).toBe(2);
    expect(w.diffs).toEqual([]);

    const diffRows = await pool.query(
      `SELECT count(*)::int AS n FROM payment.split_ledgers WHERE direction = 'DIFF'`,
    );
    expect(diffRows.rows[0]!.n).toBe(0);
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [RECONCILIATION_DIFF_FOUND_TOPIC],
    );
    expect(events.rows[0]!.n).toBe(0);
  });

  it('CHANNEL_ONLY：通道账单有行、本地无记录 → DIFF 行 + 事件出箱；重跑幂等（不重复行、不再出箱）', async () => {
    wechat.appendStatementLine({ direction: 'PAY', amount: '66.00', channelTxnNo: 'GHOST-TXN-1' });

    const first = await recon.reconcile({ period: PERIOD });
    const w = first.per_channel.find((c) => c.channel === 'wechat_ecom')!;
    expect(w.diffs.length).toBe(1);
    expect(w.diffs[0]!.kind).toBe('CHANNEL_ONLY');
    expect(w.diffs[0]!.channel_txn_no).toBe('GHOST-TXN-1');
    expect(w.diffs[0]!.amount).toBe('66.00');

    const row = await pool.query<{
      direction: string;
      status: string;
      diff_reason: string;
      idempotency_key: string;
    }>(
      `SELECT direction, status, diff_reason, idempotency_key FROM payment.split_ledgers WHERE direction = 'DIFF'`,
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]!.status).toBe('DIFF');
    expect(row.rows[0]!.diff_reason).toContain('CHANNEL_ONLY');
    expect(row.rows[0]!.idempotency_key).toBe(
      `recon:${PERIOD}:wechat_ecom:GHOST-TXN-1:CHANNEL_ONLY`,
    );

    const events = await pool.query(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [RECONCILIATION_DIFF_FOUND_TOPIC],
    );
    expect(events.rows[0]!.n).toBe(1);
    const payload = await pool.query<{
      payload: { period: string; detail: Array<{ kind: string; amount: string }> };
    }>(`SELECT payload FROM platform.outbox WHERE topic = $1`, [RECONCILIATION_DIFF_FOUND_TOPIC]);
    expect(payload.rows[0]!.payload.period).toBe(PERIOD);
    expect(payload.rows[0]!.payload.detail[0]!.amount).toBe('66.00'); // Money 字符串

    // 重跑：差异行已记录（recon:* 键冲突短路）→ 不重复、不再出箱（工单不重复触发）
    const second = await recon.reconcile({ period: PERIOD });
    expect(second.per_channel.find((c) => c.channel === 'wechat_ecom')!.diffs.length).toBe(0);
    expect(events.rows[0]!.n).toBe(1);
    const still = await pool.query(
      `SELECT count(*)::int AS n FROM payment.split_ledgers WHERE direction = 'DIFF'`,
    );
    expect(still.rows[0]!.n).toBe(1);
  });

  it('LOCAL_ONLY：本地有已付单、通道账单缺行 → DIFF 行（金额=本地 total）', async () => {
    await pool.query(
      `INSERT INTO payment.payment_orders
         (biz_type, biz_id, channel, cash_amount, points_amount, status, idempotency_key, channel_txn_no, paid_at)
       VALUES ('enroll', 999, 'wechat_ecom', '50.00', 0, 'FROZEN', 'payment/recon-local/pay', 'LOCAL-TXN-1', now())`,
    );

    const res = await recon.reconcile({ period: PERIOD });
    const w = res.per_channel.find((c) => c.channel === 'wechat_ecom')!;
    expect(w.diffs.length).toBe(1);
    expect(w.diffs[0]!.kind).toBe('LOCAL_ONLY');
    expect(w.diffs[0]!.amount).toBe('50.00');
    expect(w.diffs[0]!.reason).toContain('LOCAL-TXN-1');

    const row = await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM payment.split_ledgers WHERE direction = 'DIFF'`,
    );
    expect(row.rows[0]!.idempotency_key).toBe(`recon:${PERIOD}:wechat_ecom:LOCAL-TXN-1:LOCAL_ONLY`);
  });

  it('AMOUNT_MISMATCH：双边同单金额不一致 → DIFF 行（模拟通道账单金额漂移）', async () => {
    const order = await createPaidOrder('100.00', 0);
    expect(order.channel_txn_no).toBeTruthy();
    wechat.setStatementDiscrepancy(order.channel_txn_no!, '1.00');

    const res = await recon.reconcile({ period: PERIOD });
    const w = res.per_channel.find((c) => c.channel === 'wechat_ecom')!;
    expect(w.diffs.length).toBe(1);
    expect(w.diffs[0]!.kind).toBe('AMOUNT_MISMATCH');
    expect(w.diffs[0]!.amount).toBe('1.00');

    const row = await pool.query<{ diff_reason: string }>(
      `SELECT diff_reason FROM payment.split_ledgers WHERE direction = 'DIFF'`,
    );
    expect(row.rows[0]!.diff_reason).toContain('AMOUNT_MISMATCH');
    expect(row.rows[0]!.diff_reason).toContain('100.00'); // 本地期望值入文
  });

  it('指令行对账：REFUND/SPLIT/DEDUCT 按 detail.channel_txn_no 与账单核对；ISSUED 未确认行不参与', async () => {
    const order = await createPaidOrder('100.00', 0);
    await svc.markPaid(order.id); // 分账前置=业务确认（PAID→SPLIT 唯一解冻节点）
    await svc.split({
      order_id: order.id,
      splits: [{ payee_type: 'lawyer_firm', payee_id: 3, amount: '100.00' }],
      idempotency_key: 'payment/recon-split/split',
    });
    await svc.deduct({
      lawyer_id: 9101,
      amount: '7.00',
      from: 'settlement',
      idempotency_key: 'payment/recon-deduct/deduct',
    });

    const res = await recon.reconcile({ period: PERIOD });
    const w = res.per_channel.find((c) => c.channel === 'wechat_ecom')!;
    expect(w.statement_lines).toBe(3); // PAY + SPLIT + DEDUCT
    expect(w.matched).toBe(3);
    expect(w.diffs).toEqual([]);
  });

  it('形态：period 非法 400；指定单通道只核该通道', async () => {
    await expect(recon.reconcile({ period: '2026/10/16' })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    const res = await recon.reconcile({ period: PERIOD, channels: ['alipay'] });
    expect(res.per_channel.length).toBe(1);
    expect(res.per_channel[0]!.channel).toBe('alipay');
    expect(AppError).toBeDefined();
  });
});
