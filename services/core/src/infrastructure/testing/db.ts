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

/**
 * 全部基座/demo/notify/schedule/ops/agent_assist/identity/pricing 测试表（TRUNCATE 清场清单，须与 V2~V17 迁移同步）。
 *
 * notify.notification_templates 不入清单：PRD §8.2 三档话术是 V4 迁移 seed 的参照数据
 * （R-01 全等断言的事实源），清场会把它一并抹掉——同 flyway 历史表不参与清场的道理。
 * 插入自定义模板 fixture 的 spec 必须自行清理（不得污染参照数据）。
 */
export const TEST_DB_TABLES = [
  'platform.outbox',
  'platform.outbox_dead_letter',
  'platform.state_transition_log',
  'demo.orders',
  'demo.order_actions',
  'demo.consumed_events',
  'identity.users',
  'identity.user_roles',
  'identity.refresh_tokens',
  'identity.verify_codes',
  'identity.real_name_infos',
  'identity.consents',
  'identity.decrypt_approvals',
  'identity.lawyer_profiles',
  'identity.qualification_files',
  'notify.notifications',
  'notify.notification_prefs',
  'notify.verify_code_sends',
  'schedule.schedule_jobs',
  'schedule.schedule_job_log',
  'schedule.slot_locks',
  'schedule.time_slot_templates',
  'schedule.lawyer_schedule_versions',
  'pricing.price_versions',
  'ops.rule_definitions',
  'ops.risk_records',
  'agent_assist.specialty_configs',
  'agent_assist.knowledge_docs',
  'agent_assist.knowledge_chunks',
  'agent_assist.sanitize_audit',
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
