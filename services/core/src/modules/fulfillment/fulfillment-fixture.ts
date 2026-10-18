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
