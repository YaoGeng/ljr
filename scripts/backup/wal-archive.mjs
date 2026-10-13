// scripts/backup/wal-archive.mjs —— WAL 归档脚本（staging 起用；dev 只交付不运行，M0-3）
// 架构口径：PITR 备份，日全量 + WAL（架构 §5.2）。
//
// 用法（staging postgresql.conf）：
//   wal_level = replica
//   archive_mode = on
//   archive_command = 'node /opt/ljr/scripts/backup/wal-archive.mjs "%p" "%f"'
//   环境变量：PITR_WAL_ARCHIVE_DIR=<归档目录>（建议独立磁盘/NFS/对象存储挂载点）
//
// 退出码口径（PG 依赖）：0=归档成功（含对已归档同名同长度文件的重放幂等），1=失败（PG 稍后重试）。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const out = (...args) => process.stdout.write(`${args.join(' ')}\n`);

const [src, name] = process.argv.slice(2);
const archiveDir = process.env.PITR_WAL_ARCHIVE_DIR;

if (!src || !name || !archiveDir) {
  out(
    '用法（staging-only 模板，dev 不运行）:',
    'archive_command = \'node …/wal-archive.mjs "%p" "%f"\'，且设置 PITR_WAL_ARCHIVE_DIR',
  );
  process.exit(1);
}

try {
  fs.mkdirSync(archiveDir, { recursive: true });
  const dest = path.join(archiveDir, name);
  // 幂等：PG 可能对同一 WAL 重发 archive_command（.ready 重复/重启动），已归档同长度文件直接成功
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) {
    process.exit(0);
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest); // 原子落位，避免 PG 读到半写文件
  out(`archived ${name}`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`WAL 归档失败（PG 将重试）: ${err.message}\n`);
  process.exit(1);
}
