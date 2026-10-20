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

/** ref 维度结算行计数（D6=M2-W3 T2：OneOnOneSettled→F3 结算行落位断言锚） */
export async function countSettlementsByRef(
  pool: Pool,
  refType: string,
  refId: number,
): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
    [refType, refId],
  );
  return res.rows[0]!.n;
}

/** ref 维度结算行直读（M2-W4 T1：D6 spec 断言「构成基=net 落 gross 列」锚——gross 列在
 *  one_on_one 行承载结算构成基，W4-1 裁决；owner=settlement 同头注纪律）。
 *  M2-W4 T2 扩展（纯加法）：status/share_mode/escrow_status 三列并入出参——合并验收 spec
 *  断言 ABSENCE_7030 标记与 SETTLED 终态（消费方 toMatchObject 不受加列影响） */
export async function settlementByRefRaw(
  pool: Pool,
  refType: string,
  refId: number,
): Promise<{
  gross: string;
  penalty: string;
  platform_fee: string;
  net: string;
  status: string;
  share_mode: string;
  escrow_status: string | null;
} | null> {
  const res = await pool.query<{
    gross: string;
    penalty: string;
    platform_fee: string;
    net: string;
    status: string;
    share_mode: string;
    escrow_status: string | null;
  }>(
    `SELECT gross::text AS gross, penalty::text AS penalty,
       platform_fee::text AS platform_fee, net::text AS net,
       status, share_mode, escrow_status
     FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
    [refType, refId],
  );
  return res.rows[0] ?? null;
}

/** ref 维度违约扣减留痕直读（M2-W4 T2：合并验收 C 链 deduction_detail 腿级断言锚；
 *  owner=settlement 同头注纪律） */
export async function deductionDetailByRefRaw(
  pool: Pool,
  refType: string,
  refId: number,
): Promise<Record<string, unknown> | null> {
  const res = await pool.query<{ deduction_detail: Record<string, unknown> | null }>(
    `SELECT deduction_detail FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
    [refType, refId],
  );
  return res.rows[0]?.deduction_detail ?? null;
}

/** ref 维度结算行 id 直读（M2-W4 T2：合并验收 spec 的 SETTLE_HOLD_RELEASE job 重注册锚——
 *  I2 API cancel+register 按 settlement 行 id 定位；owner=settlement 同头注纪律） */
export async function settlementIdByRefRaw(
  pool: Pool,
  refType: string,
  refId: number,
): Promise<number | null> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM settlement.settlements WHERE ref_type = $1 AND ref_id = $2`,
    [refType, refId],
  );
  const row = res.rows[0];
  return row === undefined ? null : Number(row.id);
}
