// scripts/db/lib.mjs —— portable 轨共用：路径/环境解析 + 子进程封装（M0-3，ADR-0002 双轨口径）
// 环境变量（均可覆盖，默认值为 dev 口径）：
//   LJR_PG_PORT     默认 5435（与 docker 轨映射端口一致）
//   LJR_PG_USER     默认 postgres（dev 超级用户；staging 应改用专用迁移账号）
//   LJR_PG_PASSWORD dev 占位口令，真值经 env 注入（密钥禁入文件，架构 §1.3）
//   LJR_PG_DB       默认 ljr_dev（与 compose POSTGRES_DB 一致）
import { spawnSync } from 'node:child_process';
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

export const env = {
  pgHost: '127.0.0.1',
  pgPort: process.env.LJR_PG_PORT ?? '5435',
  pgUser: process.env.LJR_PG_USER ?? 'postgres',
  // dev 占位口令：仅本机演练；任何共享环境必须经环境变量注入真值
  pgPassword: process.env.LJR_PG_PASSWORD ?? 'ljr-dev-only',
  pgDatabase: process.env.LJR_PG_DB ?? 'ljr_dev',
};

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
      env: { ...process.env, PGPASSWORD: env.pgPassword },
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
        FLYWAY_PASSWORD: env.pgPassword,
      },
    },
  );
  if (r.error) die(`flyway 无法执行: ${r.error.message}`);
  if (r.status !== 0) die(`flyway 失败（exit ${r.status}）: flyway ${args.join(' ')}`);
}

// 13 个业务 schema（V1__schemas_roles.sql 的镜像清单；仅 reset.mjs 的 drop 演练用，
// 增删须同步 V1 迁移——事实源仍是架构 §3.2）
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
];
