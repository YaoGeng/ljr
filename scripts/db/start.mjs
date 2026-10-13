// scripts/db/start.mjs —— 初始化（首次）并启动 portable PostgreSQL 15，等待健康后确保 ljr_dev 库存在
// 数据目录 .tools/pg15-data（gitignore）；仅监听 127.0.0.1:$LJR_PG_PORT（默认 5435）
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { env, log, die, pgBin, run, psql, pgUp, PG_DATA, PG_LOG, TOOLS } from './lib.mjs';

function ensureTools() {
  if (!fs.existsSync(pgBin('psql'))) {
    die('未找到 portable PostgreSQL，先运行: node scripts/db/setup-tools.mjs');
  }
}

function initDataDir() {
  if (fs.existsSync(path.join(PG_DATA, 'postgresql.conf'))) return;

  log('首次运行：initdb（数据目录 .tools/pg15-data，UTF8、no-locale）…');
  const pwfile = path.join(TOOLS, 'pg-password.tmp');
  fs.writeFileSync(pwfile, env.pgPassword);
  try {
    run(pgBin('initdb'), [
      '-D',
      PG_DATA,
      '--username=postgres',
      `--pwfile=${pwfile}`,
      '--auth-local=trust',
      '--auth-host=scram-sha-256',
      '--no-locale',
      '-E',
      'UTF8',
    ]);
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
  // dev 口径对齐架构 §1.3：时间一律 timestamptz（Asia/Shanghai）
  fs.appendFileSync(
    path.join(PG_DATA, 'postgresql.conf'),
    "\n# M0-3 dev 口径（scripts/db/start.mjs 追加）\ntimezone = 'Asia/Shanghai'\nlog_timezone = 'Asia/Shanghai'\n",
  );
}

function startServer() {
  const status = spawnSync(pgBin('pg_ctl'), ['-D', PG_DATA, 'status'], { stdio: 'ignore' });
  if (status.status === 0) {
    log('PostgreSQL 已在运行，跳过启动。');
    return;
  }
  log(`启动 PostgreSQL（127.0.0.1:${env.pgPort}，日志 ${path.relative(process.cwd(), PG_LOG)}）…`);
  run(pgBin('pg_ctl'), [
    '-D',
    PG_DATA,
    '-l',
    PG_LOG,
    'start',
    '-o',
    `-h ${env.pgHost} -p ${env.pgPort}`,
  ]);
}

function waitHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pgUp()) {
      log('PostgreSQL 就绪。');
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // 同步等待 300ms
  }
  die(`等待健康超时（${timeoutMs}ms），查看日志: ${PG_LOG}`);
}

function ensureDatabase() {
  const exists = psql(
    `SELECT 1 FROM pg_database WHERE datname = '${env.pgDatabase}'`,
    'postgres',
  ).trim();
  if (exists.includes('1')) {
    log(`数据库 ${env.pgDatabase} 已存在。`);
    return;
  }
  log(`创建数据库 ${env.pgDatabase} …`);
  psql(`CREATE DATABASE ${env.pgDatabase}`, 'postgres');
  log(`数据库 ${env.pgDatabase} 创建完成。`);
}

ensureTools();
initDataDir();
startServer();
waitHealthy();
ensureDatabase();
log(`portable PostgreSQL 就绪：jdbc:postgresql://${env.pgHost}:${env.pgPort}/${env.pgDatabase}`);
