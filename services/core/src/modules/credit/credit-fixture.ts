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
