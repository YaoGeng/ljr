/**
 * 跨域集成测试夹具：credit 限制令直插（本 schema owner 侧唯一合法直触点，points-fixture/
 * order-fixture 同款纪律）。仅供其他域的集成 spec 复用（生产代码禁 import）——G1 自身覆盖在
 * credit.*spec；此处只造「入口拦截断言所需的活跃限制令种子」。
 *
 * check-schema-refs：本文件 owner=credit，直触 credit 表合法；引用方（其他域 spec）只 import
 * 本函数、不内联 credit 表名，红线不破。
 */
import type { Pool } from 'pg';

/** 种子活跃限制令（until=now()+days；G1 listActiveRestrictions 缓存 30s——种子后直查命中） */
export async function seedRestriction(
  pool: Pool,
  ownerType: 'user' | 'lawyer',
  ownerId: number,
  kind: string,
  days = 7,
): Promise<void> {
  await pool.query(
    `INSERT INTO credit.credit_restrictions (owner_type, owner_id, kind, until, reason)
     VALUES ($1::varchar, $2::bigint, $3::varchar, now() + make_interval(days => $4::int),
             'fixture:seed-restriction')`,
    [ownerType, ownerId, kind, days],
  );
}

// ---- M2-W2 T3 扩展：D4 取消 spec 的 credit 侧直读锚（owner=credit 同头注纪律） ----

/** 流水行直读（D4 取消/选择信用档的入账断言锚；action 升序） */
export async function creditEventRowsRaw(
  pool: Pool,
  ownerType: 'user' | 'lawyer',
  ownerId: number,
): Promise<ReadonlyArray<{ action: string; delta: number; ref_id: string }>> {
  const res = await pool.query<{ action: string; delta: number; ref_id: string }>(
    `SELECT action, delta, ref_id::text AS ref_id FROM credit.credit_events
      WHERE owner_type = $1 AND owner_id = $2 ORDER BY id`,
    [ownerType, ownerId],
  );
  return res.rows;
}

/** 限制令行直读（D4 真事件驱动的 G1 停接令断言锚） */
export async function restrictionRowsRaw(
  pool: Pool,
  ownerType: 'user' | 'lawyer',
  ownerId: number,
): Promise<ReadonlyArray<{ kind: string; reason: string }>> {
  const res = await pool.query<{ kind: string; reason: string }>(
    `SELECT kind, reason FROM credit.credit_restrictions
      WHERE owner_type = $1 AND owner_id = $2 ORDER BY id`,
    [ownerType, ownerId],
  );
  return res.rows;
}
