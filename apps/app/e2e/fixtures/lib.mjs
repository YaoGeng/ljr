// apps/app/e2e/fixtures/lib.mjs —— dev 夹具共用件（M3-W1 T2）：core dist 契约装载 + psql 执行。
//
// 设计口径：
//   - 密钥值零字面量：pepper/数据密钥经 core dist 的 identityConfigFromEnv 运行时装载
//     （与 core 服务同一三层解析：进程 env > config/<env>/app.env > dev-only 派生默认），
//     本文件不复制任何派生公式或密钥常量——core 改口径时夹具随之而变，不会漂移；
//   - psql 复用 scripts/db/lib.mjs 的 portable 轨（.tools/pg15/bin，口令经 .secrets/dev.env），
//     不引任何 npm 依赖（W1-3 零新依赖红线）；
//   - 夹具只 INSERT/DELETE 数据，不改任何 core/services/shared 文件（任务纪律）。
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 退出并留痕（scripts/db/lib.mjs 同款 die 形态） */
function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const CORE_DIST = path.join(REPO_ROOT, 'services', 'core', 'dist');

/** scripts/db/lib.mjs（portable 轨共用件：pgBin/env/口令/探活） */
export const dbLib = await import(
  pathToFileURL(path.join(REPO_ROOT, 'scripts', 'db', 'lib.mjs')).href
);

/** core dist 动态装载（缺 dist → 提示先构建 core） */
async function coreDist(rel) {
  try {
    return await import(pathToFileURL(path.join(CORE_DIST, rel)).href);
  } catch {
    die(`未找到 services/core/dist（${rel}）——先运行: pnpm --filter @ljr/core build`);
  }
}
const identityConfigMod = await coreDist(path.join('modules', 'identity', 'identity.config.js'));
const identityCryptoMod = await coreDist(path.join('modules', 'identity', 'identity.crypto.js'));

/** IdentityCryptoService 实例（与 core 同密钥配置——pepper/数据密钥运行时装载） */
export function coreIdentityCrypto() {
  // loadAppConfig 需要 LJR_PG_PASSWORD（dev 由 .secrets/dev.env 兜底），与 core 启动同序补齐
  const env = { ...process.env };
  if (!env.LJR_PG_PASSWORD) env.LJR_PG_PASSWORD = dbLib.readDevSecrets().LJR_PG_PASSWORD;
  const identity = identityConfigMod.identityConfigFromEnv(env);
  return {
    crypto: new identityCryptoMod.IdentityCryptoService(identity),
    hashCodeValue: identityCryptoMod.hashCodeValue,
  };
}

/** psql 执行（tuples-only 无对齐，便于解析返回值）；statement 经 stdin 传递：
 *  Windows 下 argv 会按代码页转码中文（"invalid byte sequence UTF8"），stdin 走 UTF-8 字节且不进命令行 */
export function psql(statement) {
  if (!dbLib.pgUp()) {
    die('PostgreSQL 未就绪（127.0.0.1:5435）——先运行: node scripts/db/start.mjs');
  }
  const r = spawnSync(
    dbLib.pgBin('psql'),
    [
      '-h',
      dbLib.env.pgHost,
      '-p',
      dbLib.env.pgPort,
      '-U',
      dbLib.env.pgUser,
      '-d',
      dbLib.env.pgDatabase,
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    {
      input: statement,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: dbLib.requirePgPassword() },
    },
  );
  if (r.error) {
    die(`psql 无法执行: ${r.error.message}`);
  }
  if (r.status !== 0) {
    die(`psql 失败: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/** psql 执行并取首行（-t -A 会附打印命令标签如 INSERT 0 1，取值只认第一行） */
export function psqlFirst(statement) {
  return psql(statement).split(/\r?\n/)[0] ?? '';
}

/** INSERT ... RETURNING 首行判值（M3-W2 T1）：psql -t -A 在 RETURNING 0 行时仍打印命令
 *  标签（如 INSERT 0 0）——标签行=无返回行（ON CONFLICT 跳过），返回 ''；非标签行=真值。
 *  修正口径：原各夹具 `=== ''` 判空在冲突路径永假（首行恒为标签串），exists(kept) 回显失真；
 *  数据行为不变，仅回显/取值修正。 */
export function returningRow(firstLine) {
  return /^(INSERT|UPDATE|DELETE|SELECT) /.test(firstLine) ? '' : firstLine;
}

/** Buffer → bytea 字面量（`\x` + hex，pg 十六Hex转义形态） */
export function byteaLiteral(buf) {
  return `'\\x${buf.toString('hex')}'`;
}

/** SQL 单引号字符串字面量转义（夹具值仍以受控字符为主，双保险） */
export function sqlString(v) {
  return `'${String(v).replaceAll("'", "''")}'`;
}
