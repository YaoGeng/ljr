/**
 * 跨域集成测试夹具：payment 支付单/退款单/Inbox 行直读（owner=payment 侧唯一合法直读点，
 * points-fixture/lawyer-fixture 同款纪律）。仅供其他域的集成 spec 复用（生产代码禁 import）——
 * 「拒绝路径零业务行」「状态推进」「退款受理」「inbox 消费标记」等断言所需读数，F1 导出面
 * （findOrderByIdempotencyKey/findOrderById/findInboxRowKey）只覆盖生产取数位、返回视图不含
 * 断言所需全列，故以 owner 夹具承载；F1/F2 自身覆盖在 payment.*spec（owner 直读同口径）。
 *
 * check-schema-refs：本文件 owner=payment，直读 payment 表合法；引用方（其他域 spec）只
 * import 本函数、不内联 payment 表名，红线不破。
 */
import type { Pool } from 'pg';

/** 支付单全表计数（零残留断言用） */
export async function countPaymentOrders(pool: Pool): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment.payment_orders`,
  );
  return res.rows[0]!.n;
}

/** id 定位支付单全行（状态推进/拆分核对断言用；无行抛错——断言前置数据不可缺失） */
export async function getPaymentOrderById(
  pool: Pool,
  orderId: number,
): Promise<Record<string, unknown>> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT * FROM payment.payment_orders WHERE id = $1`,
    [orderId],
  );
  return res.rows[0]!;
}

/** 幂等键定位支付单全行（enrollments↔orders 键关联断言用；无行抛错——同上） */
export async function getPaymentOrderByKey(
  pool: Pool,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT * FROM payment.payment_orders WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return res.rows[0]!;
}

/** 按支付单列退款单全行（自动退款分支/批量退款受理断言用；created_at 序） */
export async function listRefundsByOrderId(
  pool: Pool,
  orderId: number,
): Promise<Record<string, unknown>[]> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT id::text AS id, user_id::int AS user_id, payment_order_id::text AS payment_order_id,
            cash_amount::text AS cash_amount, points_amount, reason, status, idempotency_key
       FROM payment.refunds WHERE payment_order_id = $1 ORDER BY id`,
    [orderId],
  );
  return res.rows;
}

/** Inbox 行状态列表（按 channel_txn_no 前缀；回调消费标记 CONSUMED 断言用） */
export async function listInboxStatusesByTxnNoPrefix(
  pool: Pool,
  txnNoPrefix: string,
): Promise<string[]> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM payment.inbox WHERE channel_txn_no LIKE $1 ORDER BY id`,
    [`${txnNoPrefix}%`],
  );
  return res.rows.map((r) => r.status);
}

// ---- F3=R8/T8 消费域断言扩展（M1-W3 T8；同头注纪律：owner=payment 唯一合法直读点） ----

/** 指令流水行列表（F1 split_ledgers 按 direction；分账/扣减指令落地与金额核对断言用） */
export async function listLedgersByDirection(
  pool: Pool,
  direction: 'SPLIT' | 'DEDUCT' | 'REFUND',
): Promise<readonly { status: string; amount: string; detail: Record<string, unknown> | null }[]> {
  const res = await pool.query<{
    status: string;
    amount: string;
    detail: Record<string, unknown> | null;
  }>(
    `SELECT status, amount::text AS amount, detail
       FROM payment.split_ledgers WHERE direction = $1 ORDER BY id`,
    [direction],
  );
  return res.rows;
}

/** 指令流水计数（「重复触发幂等无操作」类断言用） */
export async function countLedgersByDirection(
  pool: Pool,
  direction: 'SPLIT' | 'DEDUCT' | 'REFUND',
): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment.split_ledgers WHERE direction = $1`,
    [direction],
  );
  return res.rows[0]!.n;
}
