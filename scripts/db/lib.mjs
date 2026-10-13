// scripts/db/lib.mjs —— portable 轨共用：路径/环境解析 + 子进程封装（M0-3，ADR-0002 双轨口径）
// 环境变量（均可覆盖，默认值为 dev 口径）：
//   LJR_PG_PORT     默认 5435（与 docker 轨映射端口一致）
//   LJR_PG_USER     默认 postgres（dev 超级用户；staging 应改用专用迁移账号）
//   LJR_PG_PASSWORD 进程 env 优先；否则读 .secrets/dev.env（start.mjs 首跑生成随机口令写入）。
//                   无任何源码兜底字面量（Mimosa 修复，架构 §1.3）；消费方经 requirePgPassword() fail-fast
//   LJR_PG_DB       默认 ljr_dev（与 compose POSTGRES_DB 一致）
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(HERE, '..', '..');
export const TOOLS = path.join(ROOT, '.tools');
export const PG_HOME = path.join(TOOLS, 'pg15'); // EDB zip 顶层 pgsql/ 重命名而来，bin/lib 在其下
export const PG_DATA = path.join(TOOLS, 'pg15-data');
export const PG_LOG = path.join(TOOLS, 'pg15.log');
export const FLYWAY_HOME = path.join(TOOLS, 'flyway');
export const FLYWAY_CONF = path.join(ROOT, 'services', 'core', 'flyway.conf');

// ---- dev 凭据层（.secrets/dev.env，gitignored 本机状态；Mimosa 修复：凭据无源码字面量） ----

export const SECRETS_DIR = path.join(ROOT, '.secrets');
export const DEV_SECRETS_FILE = path.join(SECRETS_DIR, 'dev.env');

/** 极简 env 解析（与 services/core/src/config/env-file.ts 同语法：KEY=VALUE + # 注释 + 引号剥离） */
export function parseEnvText(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') vars[key] = value;
  }
  return vars;
}

export function readDevSecrets() {
  if (!fs.existsSync(DEV_SECRETS_FILE)) return {};
  return parseEnvText(fs.readFileSync(DEV_SECRETS_FILE, 'utf8'));
}

/** 合并式写入单个凭据键（保留文件内其他键/注释行；.secrets/ 已 gitignore，仅本机状态） */
export function setDevSecret(key, value) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  const lines = fs.existsSync(DEV_SECRETS_FILE)
    ? fs
        .readFileSync(DEV_SECRETS_FILE, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '')
    : [];
  const kept = lines.filter((l) => !new RegExp(`^\\s*${key}\\s*=`).test(l));
  kept.push(`${key}=${value}`);
  fs.writeFileSync(DEV_SECRETS_FILE, kept.join('\n') + '\n');
  try {
    fs.chmodSync(DEV_SECRETS_FILE, 0o600); // POSIX 收紧到属主；Windows 近似 no-op（目录已 gitignore 且属当前用户）
  } catch {
    /* 权限收紧失败不阻断 */
  }
}

/** 随机 dev 口令（32 hex）：仅写入 .secrets/dev.env，不回显日志、不进 argv */
export function generateDbPassword() {
  return crypto.randomBytes(16).toString('hex');
}

const devSecrets = readDevSecrets();

export const env = {
  pgHost: '127.0.0.1',
  pgPort: process.env.LJR_PG_PORT ?? '5435',
  pgUser: process.env.LJR_PG_USER ?? 'postgres',
  // 无代码兜底：start.mjs 首跑生成随机口令落 .secrets/dev.env；消费前经 requirePgPassword() fail-fast
  pgPassword: process.env.LJR_PG_PASSWORD ?? devSecrets.LJR_PG_PASSWORD,
  pgDatabase: process.env.LJR_PG_DB ?? 'ljr_dev',
};

/** PG 口令 fail-fast：缺失（未跑 start.mjs 且未注入 env）即 die，不静默回落任何字面量 */
export function requirePgPassword() {
  if (!env.pgPassword) {
    die(
      'LJR_PG_PASSWORD 缺失：.secrets/dev.env 无该键且进程 env 未注入。' +
        '先运行 node scripts/db/start.mjs（首跑自动生成随机口令写入 .secrets/dev.env 并轮换本地 PG）',
    );
  }
  return env.pgPassword;
}

export const log = (...args) => process.stdout.write(`${args.join(' ')}\n`);
export const die = (...args) => {
  process.stderr.write(`${args.join(' ')}\n`);
  process.exit(1);
};

export function pgBin(name) {
  return path.join(PG_HOME, 'bin', `${name}.exe`);
}

export function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: 'inherit', ...opts });
  if (r.error) die(`无法执行 ${bin}: ${r.error.message}`);
  if (r.status !== 0) die(`命令失败（exit ${r.status}）: ${bin} ${args.join(' ')}`);
  return r;
}

// psql 执行 SQL：TCP + scram 口令认证（与 docker 轨口令注入口径一致），返回 stdout
// 默认连应用库 ljr_dev（reset/校验用）；建库等维护语句显式传 'postgres'
export function psql(statement, database = env.pgDatabase) {
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
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      statement,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: requirePgPassword() },
    },
  );
  if (r.error) die(`psql 无法执行: ${r.error.message}`);
  if (r.status !== 0) die(`psql 失败: ${r.stderr.trim()}`);
  return r.stdout;
}

// pg_isready 探活（true/false，不抛错）
export function pgUp() {
  const r = spawnSync(
    pgBin('pg_isready'),
    ['-h', env.pgHost, '-p', env.pgPort, '-U', env.pgUser, '-d', env.pgDatabase],
    { stdio: 'ignore' },
  );
  return r.status === 0;
}

// 等待就绪：每 300ms 轮询 pg_isready，总超时（默认 30s）后 die（真等待，覆盖 PG 启动窗口）
export function ensurePgUp(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pgUp()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // 同步等待 300ms
  }
  die(
    `PostgreSQL 未在 ${env.pgHost}:${env.pgPort} 就绪（已轮询 ${timeoutMs}ms 超时）。` +
      '先运行: node scripts/db/start.mjs，或查看日志 .tools/pg15.log',
  );
}

// Flyway CLI（flyway.cmd）：CWD=services/core 使 locations=filesystem:migrations 与 docker 轨同口径；
// 连接信息经 FLYWAY_* 环境变量注入（flyway.conf 不落任何连接信息）。
// Java 用 zip 自带 jre/（flyway.cmd 优先级：FLYWAY_JAVA_CMD > 自带 jre > JAVA_HOME > PATH）
export function flyway(args) {
  const flywayCmd = path.join(FLYWAY_HOME, 'flyway.cmd');
  if (!fs.existsSync(flywayCmd)) {
    die('未找到 portable Flyway CLI，先运行: node scripts/db/setup-tools.mjs');
  }
  const r = spawnSync(
    'cmd.exe',
    ['/c', flywayCmd, `-configFiles=${FLYWAY_CONF}`, '-configFileEncoding=UTF-8', ...args],
    {
      stdio: 'inherit',
      cwd: path.join(ROOT, 'services', 'core'),
      env: {
        ...process.env,
        FLYWAY_URL: `jdbc:postgresql://${env.pgHost}:${env.pgPort}/${env.pgDatabase}`,
        FLYWAY_USER: env.pgUser,
        FLYWAY_PASSWORD: requirePgPassword(),
      },
    },
  );
  if (r.error) die(`flyway 无法执行: ${r.error.message}`);
  if (r.status !== 0) die(`flyway 失败（exit ${r.status}）: flyway ${args.join(' ')}`);
}

// reset 演练要 drop 的全部 schema（V1-V3 迁移的镜像清单；增删须同步对应迁移）：
//   V1：13 个业务 schema（事实源=架构 §3.2）；
//   V2/V3（M0-4）：infra schema platform（Outbox/死信/state_transition_log，Ruling-4）+ demo（验收脚手架）。
export const BUSINESS_SCHEMAS = [
  'identity',
  'schedule',
  'pricing',
  'trade',
  'fulfillment',
  'payment',
  'settlement',
  'credit',
  'review',
  'notify',
  'benefits',
  'agent_assist',
  'ops',
  // ---- V2/V3（M0-4）----
  'platform',
  'demo',
];
