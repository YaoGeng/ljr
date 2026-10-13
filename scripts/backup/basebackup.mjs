// scripts/backup/basebackup.mjs —— 日全量基线备份脚本（staging 起用；dev 只交付不运行，M0-3）
// 架构口径：PITR 备份，日全量 + WAL（架构 §5.2）；与 wal-archive.mjs 的归档目录配套恢复。
//
// 前置（staging，详见同目录 PITR-README.md）：
//   * 备份账号具备 REPLICATION（或 superuser）；pg_hba 放行本机 replication 连接
//   * WAL 归档已启用（wal_level=replica、archive_mode=on、archive_command 指向 wal-archive.mjs）
//
// 用法（cron 每日，示例 02:30 Asia/Shanghai）：
//   PITR_BACKUP_DIR=/backups PITR_PG_BIN=/usr/lib/postgresql/15/bin \
//   PITR_PG_USER=backup PITR_PG_PASSWORD=*** node basebackup.mjs
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

const out = (...args) => process.stdout.write(`${args.join(' ')}\n`);
const fail = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
  process.exit(1);
};

const backupRoot = process.env.PITR_BACKUP_DIR;
const pgBin = process.env.PITR_PG_BIN;
const pgUser = process.env.PITR_PG_USER;
const pgPassword = process.env.PITR_PG_PASSWORD;

if (!backupRoot || !pgBin || !pgUser || !pgPassword) {
  fail(
    'staging-only 模板（dev 不运行）。需要环境变量：',
    'PITR_BACKUP_DIR / PITR_PG_BIN / PITR_PG_USER / PITR_PG_PASSWORD（口令禁入文件）',
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-'); // UTC 时间戳命名，含毫秒不冲突
const dest = path.join(backupRoot, 'base', stamp);
fs.mkdirSync(dest, { recursive: true });

out(`pg_basebackup → ${dest}`);
const r = spawnSync(
  path.join(pgBin, 'pg_basebackup'),
  [
    '-h',
    '127.0.0.1',
    '-U',
    pgUser,
    '-D',
    dest,
    '-Fp', // plain 格式（目录形态，PITR 恢复直接可用）
    '-Xs', // stream：备份期内 WAL 流式收齐，基线自洽
    '--checkpoint=fast',
    '--label',
    `ljr-daily-${stamp}`,
    '--progress',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, PGPASSWORD: pgPassword },
  },
);
if (r.error) fail(`pg_basebackup 无法执行: ${r.error.message}`);
if (r.status !== 0) fail(`pg_basebackup 失败（exit ${r.status}）`);

// 落一份清单（保留策略、巡检取数用；不影响恢复）
fs.writeFileSync(
  path.join(backupRoot, 'base', `${stamp}.json`),
  `${JSON.stringify({ startedAtUtc: stamp, host: 'staging', tool: 'pg_basebackup -Fp -Xs' }, null, 2)}\n`,
);
out(`完成：${dest}（保留策略与恢复步骤见 PITR-README.md）`);
