/**
 * notify 域测试夹具（跨模块 spec 专用，M1-W3 T9 C6 起）：模板参照数据补种与触达台账读数。
 *
 * 定位（check-schema-refs 目录→schema 约定）：C6（pricing 域）e2e 需要断言 I1 扇出结果与
 * 补种撤销话术夹具——SQL 落本文件（owner=notify，同域合法），spec 只 import 函数，不直写
 * notify.* 表。仅供 *.spec.ts 使用，生产代码禁 import。
 *
 * ⚠参照数据纪律（testing/db.ts 头注同口径）：notification_templates 不入 TRUNCATE 清场清单，
 * 本文件插入的自定义模板 spec 必须自行清理（不得污染 V4/V27 参照数据）。
 */
import type { Pool } from 'pg';

/** 自插一个非关键 INBOX 模板（ON CONFLICT 幂等；用后须删，参照数据纪律） */
export async function seedTemplateRaw(
  pool: Pool,
  code: string,
  content: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
     VALUES ($1, 'INBOX', $2, 1, false) ON CONFLICT (code) DO NOTHING`,
    [code, content],
  );
}

/** 删除自插模板（用后清理） */
export async function deleteTemplateRaw(pool: Pool, code: string): Promise<void> {
  await pool.query('DELETE FROM notify.notification_templates WHERE code = $1', [code]);
}

/** 触达台账读数（按用户+可选模板过滤，id 升序；status=QUEUED|SENT|FAILED|SKIPPED） */
export async function listNotificationsRaw(
  pool: Pool,
  userId: number,
  templateCode?: string,
): Promise<Array<{ template_code: string; status: string }>> {
  const res = await pool.query<{ template_code: string; status: string }>(
    `SELECT template_code, status FROM notify.notifications
      WHERE user_id = $1 ${templateCode ? 'AND template_code = $2' : ''} ORDER BY id`,
    templateCode ? [userId, templateCode] : [userId],
  );
  return res.rows;
}
