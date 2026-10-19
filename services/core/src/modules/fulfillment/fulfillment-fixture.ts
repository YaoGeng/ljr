/**
 * fulfillment 域测试夹具（跨模块 spec 专用，M2-W1 T4 起）：房间行与 room 会话消息的直读。
 *
 * 定位（check-schema-refs 目录→schema 约定；trade-fixture/job-fixture 同款纪律）：D2（notify
 * 域）spec 需要断言开房结果与房间内 @Agent 消息——SQL 落本文件（owner=fulfillment，同域
 * 合法），spec 只 import 函数，不直写 fulfillment.* 表（架构 §3.2「跨模块取数走接口」的
 * 测试面口径；运行时取数仍走导出服务）。仅供 *.spec.ts 使用，生产代码禁 import。
 */
import type { Pool } from 'pg';

/** 场次的房间行（openRoomViaScheduler 结果断言锚；无房间=undefined） */
export async function roomRowOfSessionRaw(
  pool: Pool,
  sessionId: number,
): Promise<{ id: number; grace_end: Date; status: string }> {
  const res = await pool.query<{ id: string; grace_end: Date; status: string }>(
    `SELECT id, grace_end, status FROM fulfillment.rooms WHERE session_id = $1`,
    [sessionId],
  );
  const row = res.rows[0]!;
  return { id: Number(row.id), grace_end: row.grace_end, status: row.status };
}

/** room 会话全部消息（seq 升序；join conversations type='room'——@Agent 提醒断言锚） */
export async function roomConversationMessagesRaw(
  pool: Pool,
  roomId: number,
): Promise<
  ReadonlyArray<{
    readonly seq: number;
    readonly sender_role: string;
    readonly type: string;
    readonly content: string;
    readonly mention: string | null;
  }>
> {
  const res = await pool.query<{
    seq: string;
    sender_role: string;
    type: string;
    content: string;
    mention: string | null;
  }>(
    `SELECT m.seq, m.sender_role, m.type, m.content, m.mention
       FROM fulfillment.messages m
       JOIN fulfillment.conversations c ON c.id = m.conversation_id
      WHERE c.type = 'room' AND c.ref_id = $1
      ORDER BY m.seq`,
    [roomId],
  );
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    sender_role: r.sender_role,
    type: r.type,
    content: r.content,
    mention: r.mention,
  }));
}

// ---- M2-W2 T2 扩展：D3 到场与缺席判定 spec 的直读锚（attendances 行/room 会话 id） ----

/** 房间全部到场判定行（user_id 升序；D3 判定/presence 幂等断言锚） */
export async function attendanceRowsRaw(
  pool: Pool,
  roomId: number,
): Promise<
  ReadonlyArray<{
    readonly id: number;
    readonly user_id: number;
    readonly role: string;
    readonly first_join_at: Date | null;
    readonly last_seen_at: Date | null;
    readonly status: string;
    readonly adjudicated_at: Date | null;
  }>
> {
  const res = await pool.query<{
    id: string;
    user_id: string;
    role: string;
    first_join_at: Date | null;
    last_seen_at: Date | null;
    status: string;
    adjudicated_at: Date | null;
  }>(
    `SELECT id, user_id, role, first_join_at, last_seen_at, status, adjudicated_at
       FROM fulfillment.attendances WHERE room_id = $1 ORDER BY user_id`,
    [roomId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    user_id: Number(r.user_id),
    role: r.role,
    first_join_at: r.first_join_at,
    last_seen_at: r.last_seen_at,
    status: r.status,
    adjudicated_at: r.adjudicated_at,
  }));
}

/** 房间的 room 会话 id（presence 序列重放的会话锚；无会话=null） */
export async function roomConversationIdRaw(pool: Pool, roomId: number): Promise<number | null> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM fulfillment.conversations WHERE type = 'room' AND ref_id = $1`,
    [roomId],
  );
  const row = res.rows[0];
  return row === undefined ? null : Number(row.id);
}
