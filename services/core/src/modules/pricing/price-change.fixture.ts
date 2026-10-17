/**
 * pricing 域测试夹具（跨模块 spec 专用，M1-W4 T1 起）：改价历史行直插与时刻回拨。
 *
 * 定位（check-schema-refs 目录→schema 约定，trade-fixture/points-fixture 同款纪律）：H4
 * 资损巡检（ops 域）⑤类故障注入需要 pricing 侧 EFFECTED DOWN 在团历史夹具——SQL 落本文件
 * （owner=pricing，同域合法），spec 只 import 函数，不直写 pricing.* 表。仅供 *.spec.ts
 * 使用，生产代码禁 import。
 */
import type { Pool } from 'pg';

/** 直插一改价历史行（缺省 EFFECTED/DOWN/在团；createdAtAgoMs 回拨生效时刻——巡检⑤类窗口锚） */
export async function seedPriceHistoryRaw(
  pool: Pool,
  o: {
    readonly lawyerId: number;
    readonly direction?: 'UP' | 'DOWN';
    readonly result?: 'EFFECTED' | 'PENDING_APPROVAL' | 'REJECTED';
    readonly hasActiveGroup?: boolean;
    readonly createdAtAgoMs?: number;
  },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO pricing.pricing_histories
       (lawyer_id, old_version, new_version, direction, change_pct, has_active_group,
        result, credit_penalty, new_version_draft, created_at)
     VALUES ($1, 1, 2, $2, 10.000, $3, $4, -15, '{}'::jsonb,
             now() - ($5::bigint * interval '1 millisecond'))
     RETURNING id`,
    [
      o.lawyerId,
      o.direction ?? 'DOWN',
      o.hasActiveGroup ?? true,
      o.result ?? 'EFFECTED',
      o.createdAtAgoMs ?? 0,
    ],
  );
  return Number(res.rows[0]!.id);
}
