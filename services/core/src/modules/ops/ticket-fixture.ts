/**
 * 跨域集成测试夹具：ops 工单行的 owner 侧直写（settlement/credit/payment-fixture 同款纪律）。
 * 仅供其他域的集成 spec 复用（生产代码禁 import）——H3 自身覆盖在 ticket.*spec（owner 侧）。
 *
 * M2-W2 T3 修复环 I-3：D4 自愈用例的漂移注入——「工单 RESOLVED 而取消流未生效」的历史/
 * 缺 target 处置形态等价物（resolveTicket 正常路径回调在事务内先行，无法造出该形态，
 * 经 owner 夹具直写）；check-schema-refs：本文件 owner=ops，直写 ops 表合法。
 */
import type { Pool } from 'pg';

/** 强制工单 RESOLVED（绕过处置面直写终态——I-3 自愈二道防线的漂移注入） */
export async function forceResolveTicketRaw(pool: Pool, ticketId: number): Promise<void> {
  await pool.query(
    `UPDATE ops.tickets SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`,
    [ticketId],
  );
}
