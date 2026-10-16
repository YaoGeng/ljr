/**
 * 跨域集成测试夹具：支付单行计数（owner=payment 侧唯一合法直读点，lawyer-fixture 同款纪律）。
 * 仅供其他域的集成 spec 复用（生产代码禁 import）——「拒绝路径零业务行」断言需要全表计数，
 * F1 导出面（findOrderByIdempotencyKey）只支持按键定位、无计数位，故以 owner 夹具承载；
 * F1 自身覆盖在 payment.*spec（owner 直读同口径）。
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
