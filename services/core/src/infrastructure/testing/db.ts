/**
 * DB 测试前置 helper（M0-4）：确保 portable PG 已启动且迁移已跑，返回共享测试池。
 *
 * 前置命令序列（测试运行前，报告与 README 口径一致）：
 *   node scripts/db/start.mjs && node scripts/db/migrate.mjs
 * 未就绪时给出明确指引后失败（不自动起库/迁移——保持测试纯度，环境准备是编排职责）。
 *
 * 各 DB spec 共享一个 portable PG：vitest 配置 fileParallelism=false（文件串行），
 * 并在 before/afterEach 用 truncateAll 清场，保证用例隔离。
 */
import { Pool } from 'pg';
import { pgConfigFromEnv } from '../sql';

/** 全部基座/demo 表（TRUNCATE 清场清单，须与 V2/V3 迁移同步） */
export const TEST_DB_TABLES = [
  'platform.outbox',
  'platform.outbox_dead_letter',
  'platform.state_transition_log',
  'demo.orders',
  'demo.order_actions',
  'demo.consumed_events',
] as const;

export async function ensureTestDatabase(): Promise<Pool> {
  const pool = new Pool(pgConfigFromEnv());
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw new Error(
      `测试数据库不可达（${pgConfigFromEnv().host}:${pgConfigFromEnv().port}）：` +
        `先运行 node scripts/db/start.mjs。原始错误：${String(e)}`,
    );
  }
  const migrated = await pool.query<{ ok: number }>(
    `SELECT count(*)::int AS ok FROM information_schema.tables
      WHERE (table_schema, table_name) IN (('platform','outbox'), ('platform','state_transition_log'), ('demo','orders'))`,
  );
  if ((migrated.rows[0]?.ok ?? 0) < 3) {
    await pool.end();
    throw new Error('迁移未就绪（platform/demo 表缺失）：先运行 node scripts/db/migrate.mjs');
  }
  return pool;
}

/** 清场：RESTART IDENTITY 归零序列，用例间互不串号 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TEST_DB_TABLES.join(', ')} RESTART IDENTITY`);
}
