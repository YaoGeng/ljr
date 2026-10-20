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

/**
 * 直插 1对1 订单行（M2-W3 T3：#43 成员门/consent 身份核验/C1 ooo_rate 断言锚——绕开
 * 下单链聚焦 parties 锚，不挂支付单（payment_order_id=0 占位，服务创建路径同款初值））。
 * unit_price=prepaid=50.00（text 档锚）；status 缺省 CREATED（调用方可传 SETTLED 等——
 * 成员门不要求订单状态，历史会话回看口径用例锚）。
 */
export async function seedOooOrderRaw(
  pool: Pool,
  opts: {
    readonly roomId: number;
    readonly userId: number;
    readonly lawyerId: number;
    readonly mode?: 'text' | 'voice' | 'video';
    readonly serviceType?: 'deep_answer' | 'doc_revision' | 'strategy';
    readonly status?: string;
  },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO fulfillment.one_on_one_orders
       (room_id, user_id, lawyer_id, service_type, mode, unit_price, prepaid,
        consumed_units, payment_order_id, status)
     VALUES ($1, $2, $3, $4, $5, 50.00, 50.00, 0, 0, $6)
     RETURNING id`,
    [
      opts.roomId,
      opts.userId,
      opts.lawyerId,
      opts.serviceType ?? 'deep_answer',
      opts.mode ?? 'text',
      opts.status ?? 'CREATED',
    ],
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
