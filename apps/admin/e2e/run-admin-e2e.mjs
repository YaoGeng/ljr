// apps/admin/e2e/run-admin-e2e.mjs —— admin E2E 编排器（M3-W3 T7）：一条命令跑通全链，
//   node apps/admin/e2e/run-admin-e2e.mjs [--port 8795] [--core-port 3000] [--skip-build]
//
// 形态照抄 apps/app/e2e/run-e2e.mjs（W1 T5 编排七步），本文件为 admin 面适配（W3-1 决策位：
// 零触碰 app 已交付编排器，admin 自含拷贝改根）。步骤：
//   0. 预检：PG 5435 存活、core/shared dist 已构建、目标端口未被占（端口探测防「连到旧 core
//      造成假绿」——app 版同款实证注记）
//   1. DB 夹具（先种后起服：core 冷启列表缓存为空，种子行即时可见）：
//      seed-admin-lawyer（SUBMITTED 律师=J14）→ seed-admin-risk（3 行待处置=J16）→
//      mint-login 13700000001 222222 --admin（admin 号幂等=J13/J14~J18 会话）→
//      seed-sessions→seed-room 依赖链（seed-room 自含律师/用户/价格 v1 引导，独立可跑——
//      其 OPEN 场次=C6 在团底座；两夹具均幂等重跑复位规范态）
//   2. 起 core（等 /healthz 就绪；admin 面无支付旅程——双凭据 env 无需注入）
//   3. C6 造数腿（W3-6 律师腿真链）：c6-pricing-leg.mjs 经 POST /lawyer/pricing/change 造
//      PENDING_APPROVAL 行（单调 -1 分恒在团 DOWN 恒审批档——重跑论证见该夹具头注；
//      失败即 die 显性，降级路径须在任务报告记录后才启用）
//   4. vite build（VITE_API_BASE=http://127.0.0.1:<port> 构建期注入——hash 路由无 Metro 缓存
//      问题，无需 --clear 等价物）
//   5. 起同源静态宿+core 反代（lib/serve-e2e.mjs，DIST_ROOT=apps/admin/dist）
//   6. npx playwright test（E2E_* 坐标经 env 注入，不落文件）
//   7. teardown：core 进程树 Windows taskkill /T /F + 静态服关闭（app 版同款全杀）
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleepMs } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(ADMIN_ROOT, '..', '..');
const CORE_ROOT = path.join(REPO_ROOT, 'services', 'core');
const APP_FIXTURES = path.join(REPO_ROOT, 'apps', 'app', 'e2e', 'fixtures');

// ---- 参数 ----
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}
const PORT = Number(argValue('--port', '8795'));
const CORE_PORT = Number(argValue('--core-port', '3000'));
const SKIP_BUILD = argv.includes('--skip-build');

function log(step, msg) {
  process.stdout.write(`[e2e ${step}] ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`[e2e] ${msg}\n`);
  process.exitCode = 1;
  process.exit(1);
}

// ---- 0. 预检 ----
const dbLib = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'db', 'lib.mjs')).href);
if (!dbLib.pgUp()) die('PostgreSQL 未就绪（127.0.0.1:5435）——先运行: node scripts/db/start.mjs');
if (!existsSync(path.join(CORE_ROOT, 'dist', 'main.js'))) {
  die('未找到 services/core/dist/main.js——先运行: pnpm --filter @ljr/core build');
}
if (!existsSync(path.join(REPO_ROOT, 'packages', 'shared', 'dist', 'index.js'))) {
  die('未找到 packages/shared/dist——先运行: pnpm --filter @ljr/shared build');
}

/** 端口探测（node:http——全仓 .mjs 禁裸全局 fetch，no-undef 面零例外；app 版同款） */
function probePort(port, probePath) {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: probePath, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}
if ((await probePort(CORE_PORT, '/healthz')) !== null) {
  die(
    `端口 ${CORE_PORT} 已有服务在跑（/healthz 可达）——先停掉旧 core 再跑 E2E` +
      '（E2E 与 core vitest 禁并发=同库互清纪律）',
  );
}
if ((await probePort(PORT, '/')) !== null) {
  die(`端口 ${PORT} 已被占用——请先释放或用 --port 换端口`);
}

// ---- 1. DB 夹具（先种后起服；apps/app 夹具只读复用——禁动 app 树） ----
function runFixture(script, args) {
  const r = spawnSync(process.execPath, [path.join(APP_FIXTURES, script), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) die(`夹具 ${script} 失败：${(r.stderr ?? '').trim() || out}`);
  return out.split(/\r?\n/).pop();
}

const lawyerOut = JSON.parse(runFixture('seed-admin-lawyer.mjs', []));
log(
  'fixture',
  `seed-admin-lawyer → user=${lawyerOut.user_id} profile=${lawyerOut.profile_id} (SUBMITTED)`,
);
const riskOut = JSON.parse(runFixture('seed-admin-risk.mjs', []));
const riskIds = riskOut.records.map((r) => r.id);
if (riskIds.length < 3) die(`seed-admin-risk 待处置行不足（${riskIds.length} < 3）`);
log('fixture', `seed-admin-risk → records=[${riskIds.join(',')}] (reviewed_* NULL)`);

// admin 号（13700000001 幂等：角色/用户行 ON CONFLICT，验证码覆盖式重插）
const ADMIN_PHONE = '13700000001';
const ADMIN_CODE = '222222';
const adminMint = JSON.parse(runFixture('mint-login.mjs', [ADMIN_PHONE, ADMIN_CODE, '--admin']));
log('fixture', `mint-login(admin) → user=${adminMint.user_id} role=${adminMint.admin_role}`);

// C6 在团底座（seed-sessions→seed-room：后者自含律师/价格 v1/OPEN 场次引导，独立幂等可跑；
// seed-sessions 先跑补齐律师既有场次坐标，防 seed-room 律师档案/角色行缺位——两者均幂等）
runFixture('seed-sessions.mjs', []);
const roomOut = JSON.parse(runFixture('seed-room.mjs', []));
log(
  'fixture',
  `seed-room → lawyer_user=${roomOut.lawyer_user_id} session=${roomOut.session_id} (OPEN=在团底座)`,
);

// ---- 2. 起 core + 等 /healthz ----
let tearingDown = false; // core 意外退出时抑制 teardown 重复报告
let e2eServer = null; // 静态服（步骤 5 赋值；早退路径可能尚未创建）
const coreLog = [];
const core = spawn(process.execPath, ['dist/main.js'], {
  cwd: CORE_ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
core.stdout.on('data', (d) => coreLog.push(String(d)));
core.stderr.on('data', (d) => coreLog.push(String(d)));
core.on('exit', (code) => {
  if (!tearingDown && code !== null) {
    log(
      'core',
      `core 进程意外退出（code=${code}）；末尾日志：\n${coreLog.join('').split(/\r?\n/).slice(-25).join('\n')}`,
    );
  }
});
log('core', `起服 pid=${core.pid}（127.0.0.1:${CORE_PORT}）`);

let coreReady = false;
for (let i = 0; i < 60; i += 1) {
  if ((await probePort(CORE_PORT, '/healthz')) === 200) {
    coreReady = true;
    break;
  }
  await new Promise((r) => sleepMs(r, 1000));
}
if (!coreReady) {
  tearingDown = true;
  await teardown();
  die(
    `core /healthz 60s 未就绪；core 日志末尾：\n${coreLog.join('').split(/\r?\n/).slice(-40).join('\n')}`,
  );
}
log('core', '/healthz 200 就绪');

// ---- 3. C6 造数腿（律师腿真链；须 core 在跑——/auth/verify+改价面全走 HTTP） ----
const c6Leg = spawnSync(
  process.execPath,
  [path.join(HERE, 'fixtures', 'c6-pricing-leg.mjs'), '--core-port', String(CORE_PORT)],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
const c6Out = (c6Leg.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
if (c6Leg.status !== 0) {
  tearingDown = true;
  await teardown();
  die(
    `C6 造数腿（律师腿真链）失败：${(c6Leg.stderr ?? '').trim() || c6Out}\n` +
      '（W3-6：降级=seed-pricing.mjs 直插——先修复真链或在任务报告记录失败原因后再启用降级）',
  );
}
const c6 = JSON.parse(c6Out);
log(
  'fixture',
  `c6-pricing-leg → history=${c6.history_id} lawyer=${c6.lawyer_id} ${c6.old_price}→${c6.new_price} (${c6.result})`,
);

// ---- 4. vite build（VITE_API_BASE 构建期注入） ----
if (!SKIP_BUILD) {
  const build = spawnSync('npx', ['vite', 'build'], {
    cwd: ADMIN_ROOT,
    env: { ...process.env, VITE_API_BASE: `http://127.0.0.1:${PORT}` },
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  const buildOut = `${build.stdout ?? ''}${build.stderr ?? ''}`;
  if (build.status !== 0) {
    tearingDown = true;
    await teardown();
    die(
      `vite build 失败（code=${build.status}）：\n${buildOut.split(/\r?\n/).slice(-30).join('\n')}`,
    );
  }
  log(
    'build',
    `vite build 完成（${
      buildOut
        .split(/\r?\n/)
        .filter((l) => l.includes('built in'))
        .pop() ?? '见上方输出'
    }）`,
  );
} else {
  log('build', '--skip-build：复用既有 dist（须为同 VITE_API_BASE 构建，否则 API 基址不匹配）');
}

// ---- 5. 同源静态宿 + core 反代 ----
const { startE2EServer } = await import(
  pathToFileURL(path.join(HERE, 'lib', 'serve-e2e.mjs')).href
);
e2eServer = await startE2EServer({ port: PORT, corePort: CORE_PORT });
log(
  'serve',
  `静态宿+core 反代 → http://127.0.0.1:${PORT}/（admin dist 静态 + API 转发 ${CORE_PORT}）`,
);
const homeStatus = await probePort(PORT, '/');
if (homeStatus !== 200) {
  tearingDown = true;
  await teardown();
  die(`静态宿首页探测失败（HTTP ${homeStatus}）`);
}

// ---- 6. playwright（异步 spawn：进程内静态宿/反代必须保持事件循环活着——spawnSync 会冻结
//         本进程使 HTTP 服务无响应，app 版首跑实证同因保留） ----
const pw = spawn('npx', ['playwright', 'test', '--config', 'e2e/playwright.config.ts'], {
  cwd: ADMIN_ROOT,
  env: {
    ...process.env,
    E2E_APP_BASE: `http://127.0.0.1:${PORT}`,
    E2E_API_BASE: `http://127.0.0.1:${PORT}`,
    E2E_ADMIN_PHONE: ADMIN_PHONE,
    E2E_ADMIN_CODE: ADMIN_CODE,
    E2E_SUBMITTED_LAWYER_USER_ID: String(lawyerOut.user_id),
    E2E_RISK_RECORD_IDS: riskIds.join(','),
    E2E_PRICING_HISTORY_ID: String(c6.history_id),
    E2E_PRICING_LAWYER_ID: String(c6.lawyer_id),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: true,
  windowsHide: true,
});
const pwCode = await new Promise((resolve) => {
  pw.on('error', (e) => {
    log('playwright', `启动失败：${String(e?.message ?? e)}`);
    resolve(1);
  });
  pw.on('exit', (code) => resolve(code ?? 1));
});
log('playwright', `退出码=${pwCode}`);

// ---- 7. teardown 全杀 ----
tearingDown = true;
await teardown();
process.exit(pwCode);

/** 清场：core 进程树（Windows taskkill /T /F）+ 静态服关闭 */
async function teardown() {
  try {
    if (e2eServer) await new Promise((resolve) => e2eServer.close(resolve));
  } catch {
    /* 已关 */
  }
  if (core.exitCode === null && core.pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(core.pid), '/T', '/F'], { windowsHide: true });
    } else {
      core.kill('SIGTERM');
    }
  }
  log('teardown', 'core 与静态服已清场');
}
