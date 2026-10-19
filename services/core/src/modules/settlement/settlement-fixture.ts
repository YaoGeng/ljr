/**
 * 跨域集成测试夹具：settlement 结算行直读直写（本 schema owner 侧唯一合法直触点，
 * firm-merchant.fixture/points-fixture/trade-fixture 同款纪律）。仅供其他域的集成 spec
 * 复用（生产代码禁 import）——F3 自身覆盖在 settlement.*spec（owner 直读同口径）；此处只造
 * 「R-02 24h 冻结期的时间注入位」：hold 锚=DB 钟 created_at（应用钟不参与，settlement.service
 * releaseDueHoldInTx/resumeForFirm 双查点），跨域 spec 禁直写 settlement 表，时间旅行经本文件
 * 承载（settlement.consumer.spec travelCreated 的夹具化收口）。
 *
 * check-schema-refs：本文件 owner=settlement，直写 settlement 表合法；引用方（其他域 spec）
 * 只 import 本函数、不内联 settlement 表名，红线不破。
 */
import type { Pool } from 'pg';

/** 冻结期锚回拨（SQL 时间旅行）：created_at −25h，令「24h 到期释放」判定在测试时刻为真 */
export async function travelHoldCreated(pool: Pool, settlementId: number): Promise<void> {
  await pool.query(
    `UPDATE settlement.settlements SET created_at = now() - interval '25 hours'
     WHERE id = $1`,
    [settlementId],
  );
}

// ---- M2-W2 T3 扩展：D4 取消 spec 的 settlement 侧直读锚（owner=settlement 同头注纪律） ----

/** 违约扣减幂等收据全量行（D4 赔付指令断言锚：penalty/ 键+金额恰一次） */
export async function penaltyReceiptsRaw(
  pool: Pool,
): Promise<ReadonlyArray<{ penalty_key: string; amount: string }>> {
  const res = await pool.query<{ penalty_key: string; amount: string }>(
    `SELECT penalty_key, amount::text AS amount FROM settlement.settlement_penalty_receipts ORDER BY id`,
  );
  return res.rows;
}
