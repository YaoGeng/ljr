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

/** 全量退款单行（M2-W2 T3：D4 取消 spec 的退款面断言锚——跨 reason/status 维度计数；
 *  同头注纪律 owner=payment 唯一合法直读点） */
export async function listAllRefundsRaw(pool: Pool): Promise<
  ReadonlyArray<{
    readonly payment_order_id: number;
    readonly cash_amount: string;
    readonly points_amount: number;
    readonly reason: string;
    readonly status: string;
    readonly idempotency_key: string;
  }>
> {
  const res = await pool.query<{
    payment_order_id: string;
    cash_amount: string;
    points_amount: number;
    reason: string;
    status: string;
    idempotency_key: string;
  }>(
    `SELECT payment_order_id::text AS payment_order_id, cash_amount::text AS cash_amount,
            points_amount, reason, status, idempotency_key
       FROM payment.refunds ORDER BY id`,
  );
  return res.rows.map((r) => ({
    payment_order_id: Number(r.payment_order_id),
    cash_amount: r.cash_amount,
    points_amount: r.points_amount,
    reason: r.reason,
    status: r.status,
    idempotency_key: r.idempotency_key,
  }));
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

// ---- M1-W4 T1 扩展：H4 资损巡检故障注入（支付单/退款单/指令流水直插 + 时刻回拨） ----
// 头注纪律同上：owner=payment 唯一合法直触点，引用方（ops 巡检 spec）只 import 函数。

/** 直插一支付单（缺省 CREATED→可指定状态；幂等键=调用方给定——巡检①类 enroll/e{id}/pay 关联锚） */
export async function seedPaymentOrderRaw(
  pool: Pool,
  o: {
    readonly idempotencyKey: string;
    readonly bizId: number;
    readonly cash?: string;
    readonly points?: number;
    readonly status?: string;
  },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO payment.payment_orders
       (biz_type, biz_id, channel, cash_amount, points_amount, status, idempotency_key)
     VALUES ('enroll', $1, 'wechat_ecom', $2, $3, $4, $5)
     RETURNING id`,
    [o.bizId, o.cash ?? '100.00', o.points ?? 0, o.status ?? 'CREATED', o.idempotencyKey],
  );
  return Number(res.rows[0]!.id);
}

/** 直插一退款单（状态可指定——巡检①类在途/终局失败核对面） */
export async function seedRefundRaw(
  pool: Pool,
  o: {
    readonly orderId: number;
    readonly userId: number;
    readonly status: string;
    readonly idempotencyKey: string;
    readonly cash?: string;
    readonly points?: number;
  },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO payment.refunds
       (payment_order_id, user_id, cash_amount, points_amount, reason, status, idempotency_key)
     VALUES ($1, $2, $3, $4, 'GROUP_FAIL', $5, $6)
     RETURNING id`,
    [o.orderId, o.userId, o.cash ?? '100.00', o.points ?? 0, o.status, o.idempotencyKey],
  );
  return Number(res.rows[0]!.id);
}

/** 直插一指令流水行（巡检④类 ISSUED 未确认故障注入；createdAtAgoMs 回拨指令时刻） */
export async function seedSplitLedgerRaw(
  pool: Pool,
  o: {
    readonly direction: 'SPLIT' | 'DEDUCT' | 'REFUND';
    readonly status: 'ISSUED' | 'CONFIRMED';
    readonly amount?: string;
    readonly createdAtAgoMs?: number;
    readonly idempotencyKey?: string;
  },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO payment.split_ledgers
       (period, channel, direction, amount, status, idempotency_key, created_at)
     VALUES (current_date, 'wechat_ecom', $1, $2, $3, $4,
             now() - ($5::bigint * interval '1 millisecond'))
     RETURNING id`,
    [
      o.direction,
      o.amount ?? '80.00',
      o.status,
      o.idempotencyKey ?? `patrol-fixture/${o.direction}/${Date.now()}-${Math.random()}`,
      o.createdAtAgoMs ?? 0,
    ],
  );
  return Number(res.rows[0]!.id);
}

/** 按幂等键的指令流水计数（D6=M2-W3 T2：「补差单未确认不扣款」断言锚——零流水即零扣款） */
export async function countLedgersByKey(pool: Pool, key: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment.split_ledgers WHERE idempotency_key = $1`,
    [key],
  );
  return res.rows[0]!.n;
}
