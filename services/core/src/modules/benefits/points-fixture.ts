/**
 * 跨域集成测试夹具：benefits 积分账户/还原流水直读直写（本 schema owner 侧唯一合法直触点，
 * order-fixture/lawyer-fixture 同款纪律）。仅供其他域的集成 spec 复用（生产代码禁 import）——
 * F4 自身覆盖在 points.*spec；此处只造「F2 退款还原（R-03）断言所需的余额种子与流水读数」。
 *
 * check-schema-refs：本文件 owner=benefits，直触 benefits 表合法；引用方（其他域 spec）只
 * import 本函数、不内联 benefits 表名，红线不破。
 */
import type { Pool } from 'pg';

/** 种子/重置账户可用余额（还原入账的可观测基线；ON CONFLICT 幂等） */
export async function seedPointsBalance(
  pool: Pool,
  userId: number,
  balance: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO benefits.points_accounts (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = $2`,
    [userId, balance],
  );
}

/** 读账户可用余额（无行=0） */
export async function getPointsBalance(pool: Pool, userId: number): Promise<number> {
  const res = await pool.query<{ balance: number }>(
    `SELECT balance FROM benefits.points_accounts WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0]?.balance ?? 0;
}

/** REFUND_RESTORE 流水行（delta+source_ref；断言「还原额=积分部分/恰一次/ref=refund:{id}」用） */
export async function listRefundRestoreTxns(
  pool: Pool,
): Promise<{ delta: number; source_ref: string }[]> {
  const res = await pool.query<{ delta: number; source_ref: string }>(
    `SELECT delta, source_ref FROM benefits.points_txns WHERE kind = 'REFUND_RESTORE' ORDER BY id`,
  );
  return res.rows;
}
