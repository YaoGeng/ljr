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

/**
 * 既有改价历史行生效时刻回拨（owner=pricing 同域 SQL；M1-W4 T2 起）。巡检⑤类窗口锚=
 * created_at——真链（C6 requestChange/approve HTTP 面）落行的 created_at 恒为当下，无法经
 * API 注入超窗时刻；本 helper 与 trade-fixture backdateSessionStatusSince / settlement-fixture
 * travelHoldCreated 同款时间注入形态（w3-smoke 段 ⑩ SETTLE_HOLD_RELEASE 先例），供链路级
 * 验收 spec 把真链改价行推入巡检候选窗（不新造简化夹具——巡检清零并验须以真链数据承载）。
 */
export async function backdatePriceHistorySince(
  pool: Pool,
  historyId: number,
  agoMs: number,
): Promise<void> {
  await pool.query(
    `UPDATE pricing.pricing_histories
        SET created_at = now() - ($2::bigint * interval '1 millisecond')
      WHERE id = $1`,
    [historyId, agoMs],
  );
}
