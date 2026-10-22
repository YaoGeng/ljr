// apps/app/e2e/run-e2e.mjs —— E2E 编排器（M3-W1 T5）：一条命令跑通全链，teardown 全杀。
//   node apps/app/e2e/run-e2e.mjs [--port 8792] [--core-port 3000] [--skip-build]
//
// 步骤（顺序敏感）：
//   0. 预检：PG 5435 存活、core/shared dist 已构建、目标端口未被占（防连到旧 core 造成假绿）
//   1. 夹具造数（不依赖 core：直插 PG——先种后起服可避开 core 列表 30s 进程内缓存回旧数据）：
//      seed-question-tree → seed-sessions（解析 stdout 拿报名中场次 id）→
//      seed-room（房间 OPEN 底座：J11/J12）→ seed-groupbuy（C2B 响应链：J10——M3-W2 T7 增量）→
//      mint+seed-notifications 幂等演示（J1 手机号连跑两次：inserted=2 → 0）
//   2. 生成 dev 支付模拟凭据（secret=node:crypto 随机，零字面量；MCH_ID=dev 通道标识非凭据）
//   3. 起 core（env 同注 LJR_PAYMENT_WECHAT_MCH_ID+SECRET 双变量——缺一回落 mock 值，T3 实证）
//      并等 /healthz 就绪
//   4. expo export --platform web --clear（E2E env 注入；--clear 必须——Metro 缓存会残留
//      上一次构建的 EXPO_PUBLIC_* 内联产物，T3 评审修复波实证）
//   5. 起同源静态宿+core 反代（lib/serve-e2e.mjs——core 无 CORS，浏览器直连 3000 必被拦）
//   6. npx playwright test（E2E_* 坐标/运行期数据经 env 注入，不落文件）
//   7. teardown：core/静态服/浏览器进程全杀，退出码透传
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleepMs } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const CORE_ROOT = path.join(REPO_ROOT, 'services', 'core');

// ---- 参数 ----
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}
const PORT = Number(argValue('--port', '8792'));
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

/** 端口探测（node:http 实现——全仓 .mjs 惯例禁裸全局 fetch/AbortSignal，no-undef 面零例外） */
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
    `端口 ${CORE_PORT} 已有服务在跑（/healthz 可达）——请先停掉旧 core 再跑 E2E（双凭据不一致会让支付回调 403）`,
  );
}
if ((await probePort(PORT, '/')) !== null) {
  die(`端口 ${PORT} 已被占用——请先释放或用 --port 换端口`);
}

// ---- 1. 夹具造数（先种后起服：core 冷启列表缓存为空，种子场次即时可见） ----
function runFixture(script, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'fixtures', script), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) die(`夹具 ${script} 失败：${(r.stderr ?? '').trim() || out}`);
  return out.split(/\r?\n/).pop();
}

const treeOut = runFixture('seed-question-tree.mjs', []);
log('fixture', `seed-question-tree → ${treeOut}`);
const seedOut = runFixture('seed-sessions.mjs', []);
log('fixture', `seed-sessions → ${seedOut}`);
const seed = JSON.parse(seedOut);
const createdSession = seed.sessions.find((s) => s.status === 'CREATED');
if (!createdSession) die('seed-sessions 未产出 CREATED 场次');
const SESSION_ID = createdSession.id;

// M3-W2 T7 增量：seed-room（房间 OPEN 底座——J11 看板/J12 气泡链）+ seed-groupbuy
// （C2B 响应链——J10 confirm 消费）。两夹具均 id 稳定式幂等（重跑复位规范态，E2E 坐标不漂移）。
const roomOut = JSON.parse(runFixture('seed-room.mjs', []));
log(
  'fixture',
  `seed-room → session=${roomOut.session_id} room=${roomOut.room_id} conversation=${roomOut.conversation_id} verify=${roomOut.verify}`,
);
const gbOut = JSON.parse(runFixture('seed-groupbuy.mjs', []));
log('fixture', `seed-groupbuy → pending_gb=${gbOut.pending_gb_id} verify=${gbOut.verify}`);
if (!roomOut.session_id || !roomOut.room_id || !roomOut.conversation_id || !gbOut.pending_gb_id) {
  die('seed-room/seed-groupbuy 坐标缺失（stdout 形状异常）');
}

// 幂等演示（J1 手机号）：通知首种=2，重跑=0（夹具可重复执行的直接证据，进运行输出留档）
const J1_PHONE = '13800003001';
runFixture('mint-login.mjs', [J1_PHONE, '111111', '--realname']);
log('fixture', `seed-notifications(1st) → ${runFixture('seed-notifications.mjs', [J1_PHONE])}`);
log('fixture', `seed-notifications(2nd) → ${runFixture('seed-notifications.mjs', [J1_PHONE])}`);

// 运行期唯一坐标：发团用户（B2 R-03 per-user-per-lawyer PENDING_PAYMENT ≤1，重跑同号会 429）
// 与咨询时段（律师维度 SLOT_TAKEN；分钟粒度+12 天后=逐跑唯一）
const now = Date.now();
const PUBLISHER_PHONE = `19${String(now).slice(-9)}`;
const slotAt = new Date(now + 12 * 24 * 3600 * 1000);
const slotParts = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}).formatToParts(slotAt);
const sp = {};
for (const p of slotParts) if (p.type !== 'literal') sp[p.type] = p.value;
const SLOT_DATE = `${sp.year}-${sp.month}-${sp.day}`;
const SLOT_TIME = `${sp.hour}:${sp.minute}`;

// J9 开团时段（B2 律师+slot 占用锁 → 逐跑唯一）：未来 30-300 天随机日 + 整点（8-21 时），
// 时钟秒粒度取日偏移避免同分钟双跑同 slot；硬避开夹具固定 slot（seed-sessions 三场 +
// seed-room 12-26 + seed-groupbuy 律师 1 三团——同律师同时段 B2 锁 409）。
const FORBIDDEN_LAWYER_SLOTS = new Set([
  '2026-12-18 20:00', // seed-sessions CREATED
  '2026-11-20 19:00', // seed-sessions FULL（19:30 半点——整点生成天然避开，防御性保留日期位）
  '2026-10-30 20:00', // seed-sessions IN_SERVICE
  '2026-12-26 20:00', // seed-room（房间 OPEN 底座）
  '2026-12-28 19:00', // seed-groupbuy PENDING_LAWYER
  '2027-01-08 19:00', // seed-groupbuy PUBLISHED（律师 1）
  '2027-01-09 19:00', // seed-groupbuy 第二律师（不同律师不占锁，防御性保留）
]);
function lawyerSlotCandidate(nowMs) {
  // 时钟秒粒度（双跑必异）+ randomBytes 抖动（防双跑恰逢周期对齐）→ 逐跑唯一 slot；
  // 日期取上海日界，时刻=8-21 整点任选（SLOT_DATE+SLOT_TIME 组合即上海墙钟语义）
  const dayOffset = 30 + ((Math.floor(nowMs / 1000) + randomBytes(2).readUInt16BE(0)) % 271);
  const hour = 8 + ((Math.floor(nowMs / 60000) + randomBytes(1)[0]) % 14);
  const d = new Date(nowMs + dayOffset * 24 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const q = {};
  for (const p of parts) if (p.type !== 'literal') q[p.type] = p.value;
  return { date: `${q.year}-${q.month}-${q.day}`, time: `${String(hour).padStart(2, '0')}:00` };
}
let lawyerSlot = lawyerSlotCandidate(Date.now());
let lawyerSlotGuard = 0;
while (
  FORBIDDEN_LAWYER_SLOTS.has(`${lawyerSlot.date} ${lawyerSlot.time}`) &&
  lawyerSlotGuard < 271
) {
  lawyerSlotGuard += 1;
  lawyerSlot = lawyerSlotCandidate(Date.now() + lawyerSlotGuard * 86_400_000);
}
if (FORBIDDEN_LAWYER_SLOTS.has(`${lawyerSlot.date} ${lawyerSlot.time}`)) {
  die('J9 开团时段生成失败（禁用 slot 集无法避开——不可达防御位）');
}

// ---- 2. dev 支付模拟凭据（随机 secret，零字面量；不写任何文件） ----
const PAY_SECRET = randomBytes(32).toString('hex');
const PAY_MCH_ID = 'ljr-e2e-sim-mch'; // dev 通道标识（非凭据；T3 先例 ljr-dev-sim-mch 同性质）

// ---- 3. 起 core（双凭据 env 同注）+ 等 /healthz ----
let tearingDown = false; // core 意外退出时抑制 teardown 重复报告
let e2eServer = null; // 静态服（步骤 5 赋值；早退路径可能尚未创建）
const coreLog = [];
const core = spawn(process.execPath, ['dist/main.js'], {
  cwd: CORE_ROOT,
  env: {
    ...process.env,
    LJR_PAYMENT_WECHAT_MCH_ID: PAY_MCH_ID,
    LJR_PAYMENT_WECHAT_SECRET: PAY_SECRET,
  },
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
log('core', `起服 pid=${core.pid}（127.0.0.1:${CORE_PORT}，MCH_ID 已注、SECRET 随机生成零字面量）`);

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

// ---- 4. expo export --clear（E2E env 注入） ----
if (!SKIP_BUILD) {
  const buildEnv = {
    ...process.env,
    EXPO_PUBLIC_API_BASE: `http://127.0.0.1:${PORT}`,
    EXPO_PUBLIC_DEV_PAY_SIM: '1',
    EXPO_PUBLIC_DEV_PAY_SECRET: PAY_SECRET,
  };
  const build = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], {
    cwd: APP_ROOT,
    env: buildEnv,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  const buildOut = `${build.stdout ?? ''}${build.stderr ?? ''}`;
  if (build.status !== 0) {
    tearingDown = true;
    await teardown();
    die(
      `expo export 失败（code=${build.status}）：\n${buildOut.split(/\r?\n/).slice(-30).join('\n')}`,
    );
  }
  log(
    'build',
    `expo export --clear 完成（${
      buildOut
        .split(/\r?\n/)
        .filter((l) => l.includes('Exported') || l.includes('Web Bundled'))
        .pop() ?? '见上方输出'
    }）`,
  );
} else {
  log('build', '--skip-build：复用既有 dist（须为同 env 构建，否则 API 基址/模拟器闸不匹配）');
}

// ---- 5. 同源静态宿 + core 反代 ----
const { startE2EServer } = await import(
  pathToFileURL(path.join(HERE, 'lib', 'serve-e2e.mjs')).href
);
e2eServer = await startE2EServer({ port: PORT, corePort: CORE_PORT });
log('serve', `静态宿+core 反代 → http://127.0.0.1:${PORT}/（dist 静态 + API 转发 ${CORE_PORT}）`);
const homeStatus = await probePort(PORT, '/');
if (homeStatus !== 200) {
  tearingDown = true;
  await teardown();
  die(`静态宿首页探测失败（HTTP ${homeStatus}）`);
}

// ---- 6. playwright（异步 spawn：进程内静态宿/反代必须保持事件循环活着——spawnSync 会
//         冻结本进程使 HTTP 服务无响应，浏览器 load 事件永不到达，首跑实证） ----
const pw = spawn('npx', ['playwright', 'test', '--config', 'e2e/playwright.config.ts'], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    E2E_APP_BASE: `http://127.0.0.1:${PORT}`,
    E2E_API_BASE: `http://127.0.0.1:${PORT}`,
    E2E_SESSION_ID: String(SESSION_ID),
    E2E_PHONE_PUBLISHER: PUBLISHER_PHONE,
    E2E_SLOT_DATE: SLOT_DATE,
    E2E_SLOT_TIME: SLOT_TIME,
    // M3-W2 T7 律师端旅程坐标（夹具 stdout → env 注入，不落文件；ws 直连 core 不经反代）
    E2E_LAWYER_PHONE: '13900000001',
    E2E_LAWYER_USER_ID: String(roomOut.lawyer_user_id),
    E2E_MEMBER_PHONE: '13900000101',
    E2E_ROOM_SESSION_ID: String(roomOut.session_id),
    E2E_ROOM_ID: String(roomOut.room_id),
    E2E_CONVERSATION_ID: String(roomOut.conversation_id),
    E2E_CORE_WS_URL: `ws://127.0.0.1:${CORE_PORT}/ws`,
    E2E_LAWYER_SLOT_DATE: lawyerSlot.date,
    E2E_LAWYER_SLOT_TIME: lawyerSlot.time,
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
