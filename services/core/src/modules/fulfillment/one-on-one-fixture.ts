/**
 * D6 1对1 测试夹具（M2-W3 T2；fulfillment-fixture/job-fixture 同款纪律）：订单行直读 +
 * 时窗回拨（接单锅/实结默认锅——执行器确定性触发的时间注入；job due 回拨经 schedule 域
 * job-fixture，spec 不内联跨域表名）。仅供 *.spec.ts 使用，生产代码禁 import
 * （check-schema-refs：本文件 owner=fulfillment，直写 fulfillment 表合法）。
 */
import type { Pool } from 'pg';

/** 订单行直读（状态断言锚；无行=undefined） */
export async function oooRowRaw(
  pool: Pool,
  orderId: number,
): Promise<Record<string, unknown> | undefined> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT * FROM fulfillment.one_on_one_orders WHERE id = $1`,
    [orderId],
  );
  return res.rows[0];
}

/** 直插房间行（OPEN；D6 create 的房间锚——开房全链归 D1 spec，此处只造行） */
export async function seedRoomRaw(pool: Pool, sessionId: number): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO fulfillment.rooms
       (session_id, mode, scheduled_start, opened_at, grace_end, status)
     VALUES ($1, 'text', now() - interval '1 hour', now() - interval '1 hour',
             now() - interval '55 minutes', 'OPEN')
     RETURNING id`,
    [sessionId],
  );
  return Number(res.rows[0]!.id);
}

/** 接单锅时窗注入：accept_deadline 拨到过去/未来（边界两侧用例共用；不改 job——due 回拨另配） */
export async function setOooAcceptDeadline(pool: Pool, orderId: number, at: Date): Promise<void> {
  await pool.query(`UPDATE fulfillment.one_on_one_orders SET accept_deadline = $2 WHERE id = $1`, [
    orderId,
    at,
  ]);
}
