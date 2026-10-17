/**
 * 跨域集成测试夹具：payment 律所进件商户行直读/直写（owner=payment 侧唯一合法直读点，
 * order-fixture/points-fixture 同款纪律）。仅供其他域的集成 spec 复用（生产代码禁 import）——
 * F3=R8/T8 等消费域的 R-07 进件前置用例需要构造非 ACTIVE 商户行（A3b 导出面 submit 只产
 * ACTIVE 链路，SUSPENDED 夹具无生产端点），断言/夹具读数经本文件承载；A3b 自身覆盖在
 * payment.*spec（owner 直读同口径）。
 *
 * check-schema-refs：本文件 owner=payment，直读 payment 表合法；引用方（其他域 spec）只
 * import 本函数、不内联 payment 表名，红线不破。
 */
import type { Pool } from 'pg';

/** 夹具口径的商户状态（测试构造集；生产值域=A3b 六态，本夹具只收用例所需两态） */
export type MerchantFixtureStatus = 'ACTIVE' | 'SUSPENDED';

/** 造商户行（R-07 消费域用例前置：ACTIVE=生效含复验锚；SUSPENDED=非 ACTIVE 前置不满足） */
export async function seedFirmMerchant(
  pool: Pool,
  firmId: number,
  status: MerchantFixtureStatus,
): Promise<void> {
  await pool.query(
    `INSERT INTO payment.firm_merchants (firm_id, channel, status, materials, verified_at, reverify_due)
     VALUES ($1::bigint, 'wechat_ecom', $2::text, '{}'::jsonb,
             CASE WHEN $2::text = 'ACTIVE' THEN now() ELSE NULL END,
             CASE WHEN $2::text = 'ACTIVE' THEN now() + interval '365 days' ELSE NULL END)`,
    [firmId, status],
  );
}

/** 状态直改（恢复/挂起场景推进夹具；用例内驱动 A3b 状态机语义的轻量替身） */
export async function setFirmMerchantStatus(
  pool: Pool,
  firmId: number,
  status: MerchantFixtureStatus,
): Promise<void> {
  await pool.query(`UPDATE payment.firm_merchants SET status = $2::text WHERE firm_id = $1`, [
    firmId,
    status,
  ]);
}

/** 商户状态读数（断言用；无行=未进件语义由调用方断言） */
export async function getFirmMerchantStatus(pool: Pool, firmId: number): Promise<string | null> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM payment.firm_merchants WHERE firm_id = $1`,
    [firmId],
  );
  return res.rows[0]?.status ?? null;
}
