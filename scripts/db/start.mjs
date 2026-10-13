// scripts/db/start.mjs —— 初始化（首次）并启动 portable PostgreSQL 15，等待健康后确保 ljr_dev 库存在
// 数据目录 .tools/pg15-data（gitignore）；仅监听 127.0.0.1:$LJR_PG_PORT（默认 5435）
// 凭据口径（Mimosa 修复，架构 §1.3）：PG 口令无源码兜底——
//   ① 进程 env LJR_PG_PASSWORD（若设置）优先；
//   ② 否则采用 .secrets/dev.env 的 LJR_PG_PASSWORD（已存在即直接采用）；
//   ③ 仍缺 → crypto 生成 32 hex 随机口令写入 .secrets/dev.env（gitignored），并在数据目录已存在时
//      轮换本地 PG 口令对齐（ALTER USER；经 pg_hba 临时 trust 行免旧口令连接，语句走 stdin——
//      新口令不进 argv、不落 .secrets/ 之外的任何文件）。历史数据目录的旧占位口令由此首跑退役。
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import {
  env,
  log,
  die,
  pgBin,
  run,
  psql,
  ensurePgUp,
  PG_DATA,
  PG_LOG,
  TOOLS,
  generateDbPassword,
  setDevSecret,
} from './lib.mjs';

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

// 健康等待统一走 lib.ensurePgUp（300ms 轮询 + 总超时），此处只补日志
function waitHealthy() {
  ensurePgUp();
  log('PostgreSQL 就绪。');
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

// 口令三段决策（进程 env > .secrets/dev.env > 生成随机）：返回是否本次新生成
function ensureDevPassword() {
  if (env.pgPassword) return false;
  const password = generateDbPassword();
  setDevSecret('LJR_PG_PASSWORD', password);
  env.pgPassword = password;
  return true;
}

// 轮换本地 PG 口令：pg_hba.conf 顶部临时插 trust 行（仅 127.0.0.1 + 当前用户）→ ALTER USER →
// finally 还原 hba 原文并 reload（磁盘配置先还原，reload 失败也会在下次重启时回到 scram）。
// ALTER 语句经 stdin 传递，新口令不进 argv、不回显、不落 .secrets/ 之外的文件。
function rotateDbPassword(newPassword) {
  if (env.pgHost !== '127.0.0.1') {
    die(
      `口令轮换仅支持回环监听（当前 LJR_PG_HOST=${env.pgHost}）：` +
        '请手工执行 ALTER USER 对齐 .secrets/dev.env 中的口令后重跑',
    );
  }
  const hbaPath = path.join(PG_DATA, 'pg_hba.conf');
  const original = fs.readFileSync(hbaPath, 'utf8');
  const trustBlock = `# ljr scripts/db/start.mjs 临时轮换行（自动还原）\nhost all ${env.pgUser} 127.0.0.1/32 trust\n`;
  const reload = () => run(pgBin('pg_ctl'), ['-D', PG_DATA, 'reload']);
  fs.writeFileSync(hbaPath, trustBlock + original);
  const sql = `ALTER USER ${env.pgUser} PASSWORD '${newPassword.replaceAll("'", "''")}';`;
  try {
    reload();
    const childEnv = { ...process.env };
    delete childEnv.PGPASSWORD; // trust 行生效期间不带任何口令连接
    const r = spawnSync(
      pgBin('psql'),
      [
        '-h',
        env.pgHost,
        '-p',
        env.pgPort,
        '-U',
        env.pgUser,
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { input: sql, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', env: childEnv },
    );
    if (r.error) die(`psql 无法执行: ${r.error.message}`);
    if (r.status !== 0) die(`口令轮换失败: ${r.stderr.trim()}`);
  } finally {
    fs.writeFileSync(hbaPath, original);
    reload();
  }
}

ensureTools();
const generated = ensureDevPassword();
const dataDirExisted = fs.existsSync(path.join(PG_DATA, 'postgresql.conf'));
initDataDir();
startServer();
waitHealthy();
if (generated && dataDirExisted) {
  log(
    '.secrets/dev.env 缺 LJR_PG_PASSWORD：已生成随机口令，正在轮换本地 PG 口令（旧占位口令退役）…',
  );
  rotateDbPassword(env.pgPassword);
  log('本地 PG 口令已与 .secrets/dev.env 对齐（该文件已 gitignore，勿提交/外传）。');
}
ensureDatabase();
log(`portable PostgreSQL 就绪：jdbc:postgresql://${env.pgHost}:${env.pgPort}/${env.pgDatabase}`);
