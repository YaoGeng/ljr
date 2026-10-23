// apps/admin/e2e/fixtures/c6-pricing-leg.mjs —— C6 改价审批 E2E 造数腿（M3-W3 T7，W3-6）：
// 经**律师腿真链**（POST /lawyer/pricing/change）造一条 PENDING_APPROVAL 待审行，供 J18
// 审批台端到端（05 §7.1 W3 验收判据载体）。
//
// 用法：node apps/admin/e2e/fixtures/c6-pricing-leg.mjs [--core-port 3000]
//   前置：PG 5435 在跑 + core 已起（/auth/verify 与改价面都走 HTTP）+ seed-room 已种
//   （在团底座=seed-room 的 OPEN 场次属非终态 → hasActiveSessions=true）。
//
// 真链步骤（对照 price-change.controller/service 实码）：
//   ① mint-login 13900000001 取律师验证码（seed-sessions/seed-room 同号幂等，角色行已在册）；
//   ② POST /auth/verify {phone, code} → access_token（roles 含 lawyer——@RequireRole('lawyer')）；
//   ③ 查 DB 当前 head 版本（price_versions 按 lawyer_id version DESC 首行）；
//   ④ 价格单调降 1 分策略（见下）构造 new_version_draft（计价侧=head 同侧 per_head/session_total，
//      one_on_one_prices 三通道照抄 head——normalizePricingWrite 全量必填）；
//   ⑤ POST /lawyer/pricing/change {new_version_draft}（Bearer）→ 断言 result=PENDING_APPROVAL，
//      stdout {history_id, lawyer_id, ...} 供编排器 env 注入 playwright。
//
// 重跑稳定论证（价格单调降 1 分而非「回升翻转」）：
//   - 任务例示「200.00→199.99、反之亦然」的回升方向=在团 UP=直效档（classifyChange：
//     tierRequiresApproval 仅在团 DOWN）——回升翻转会拿到 EFFECTED 而非 PENDING，违背
//     「逐跑必异价=必新版本=必 PENDING_APPROVAL」的决策位不变量，故采**单调 -1 分**：
//     每跑申 head 价-1 分，恒 DOWN、恒异价、恒新版本号（head+1）；
//   - 幂等键 lawyer+new_version（PENDING 面 UNIQUE）：逐跑 new_version 递增且无遗留 PENDING
//     （J18 每跑已把上一跑审批至终态），无重放/409 面；
//   - R-03 频率窗（30 天 3 次）超限后与在团 DOWN 同走审批兜底档（requiresApproval 两路合流，
//     service 实码 freqExceeded||tierRequiresApproval）——多跑后依旧 PENDING，重跑稳定；
//   - seed-room 重跑复位 OPEN 场次（在团底座恒在）；J18 approve 后 head 前移至新版本
//     （B3 createVersionFromDraftInTx），下一跑继续 head-1 分（价格域内单调可承受千级跑次）。
//
// 降级路径（W3-6 允许）：本腿失败（前置链跑不通）时改 seed-pricing.mjs 直插
//   pricing_histories PENDING_APPROVAL 行——先真链，失败再降级并在任务报告记录（本腿失败
//   即 exit 1 显性，不静默降级）。
//
// 纪律：HTTP 腿用 node:http（全仓 .mjs 禁裸全局 fetch——no-undef 面零例外）；psql/加密件
//   经 apps/app/e2e/fixtures/lib.mjs 相对 import（dev 工具跨树单源复用，W3-1 决策位同口径）。
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_FIXTURES = path.resolve(HERE, '..', '..', '..', 'app', 'e2e', 'fixtures');

// apps/app 夹具共用件单源复用（psql/口令/core dist 密钥装载——复制公式即漂移，禁）
const { coreIdentityCrypto, psqlFirst } = await import(
  pathToFileURL(path.join(APP_FIXTURES, 'lib.mjs')).href
);

const args = process.argv.slice(2);
const corePort = Number(
  args.indexOf('--core-port') >= 0 ? args[args.indexOf('--core-port') + 1] : '3000',
);

const LAWYER_PHONE = '13900000001'; // seed-sessions/seed-room 同号（lawyer 角色行已在册）
const LAWYER_CODE = '333333'; // 固定码（mint 覆盖式幂等——同码重插，逐跑可重放）

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** node:http JSON 请求（全仓 .mjs 禁裸 fetch 纪律；对照 run-e2e.mjs probePort 形态） */
function httpJson(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: corePort,
        method,
        path: pathname,
        headers: {
          ...(payload !== null
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* 非 JSON 错误体原样透传 */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP ${method} ${pathname} 超时`));
    });
    req.on('error', (e) => reject(e));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ---- ① 夹具取码（mint-login：先清同号未消费码再插新码=覆盖式幂等） ----
const mint = spawnSync(
  process.execPath,
  [path.join(APP_FIXTURES, 'mint-login.mjs'), LAWYER_PHONE, LAWYER_CODE],
  {
    encoding: 'utf8',
    windowsHide: true,
  },
);
if (mint.status !== 0)
  die(`mint-login 失败：${(mint.stderr ?? '').trim() || (mint.stdout ?? '').trim()}`);
const mintOut = JSON.parse((mint.stdout ?? '').trim().split(/\r?\n/).pop());

// ---- ② /auth/verify 换 token → switch-role 激活 lawyer（@RequireRole 判激活角色非角色集） ----
const verify = await httpJson('POST', '/auth/verify', { phone: LAWYER_PHONE, code: mintOut.code });
if (
  !(verify.status >= 200 && verify.status < 300) ||
  typeof verify.body?.access_token !== 'string'
) {
  die(`/auth/verify 失败（${verify.status}）：${verify.text.slice(0, 200)}`);
}
const switched = await httpJson(
  'POST',
  '/auth/switch-role',
  { target_role: 'lawyer' },
  verify.body.access_token,
);
if (
  !(switched.status >= 200 && switched.status < 300) ||
  typeof switched.body?.access_token !== 'string'
) {
  die(`/auth/switch-role(lawyer) 失败（${switched.status}）：${switched.text.slice(0, 200)}`);
}
const token = switched.body.access_token;

// ---- ③ 当前 head 版本（计价侧+1对1价照抄；lawyer_id=identity.users.id，经盲索引定位） ----
const { crypto } = coreIdentityCrypto();
const lawyerId = Number(
  psqlFirst(
    `SELECT id FROM identity.users WHERE phone_blind_idx = '${crypto.blindIndex(LAWYER_PHONE)}';`,
  ),
);
if (!Number.isInteger(lawyerId) || lawyerId <= 0) die('律师用户行不存在（先跑 seed-room.mjs）');

const head = psqlFirst(
  `SELECT version || '|' || coalesce(per_head::text, '') || '|' || coalesce(session_total::text, '')
     || '|' || coalesce(accept_min::text, '') || '|' || coalesce(accept_max::text, '')
     || '|' || coalesce(one_on_one_prices::text, '{}')
   FROM pricing.price_versions WHERE lawyer_id = ${lawyerId}
   ORDER BY version DESC LIMIT 1;`,
);
if (head === '') die(`律师 ${lawyerId} 无价格版本（先跑 seed-room.mjs 种 B3 v1）`);
const [verStr, perHead, sessionTotal, acceptMin, acceptMax, oneOnOne] = head.split('|');
const baseVersion = Number(verStr);

// 计价侧（per_head/session_total 二选一，与 head 同侧——模式变更非 C6 语义会被 409 拒）
const isPerHead = perHead !== '';
const oldMoney = isPerHead ? perHead : sessionTotal;
const dot = oldMoney.indexOf('.');
const oldCents = Number(oldMoney.slice(0, dot)) * 100 + Number(oldMoney.slice(dot + 1));
const newCents = oldCents - 1; // 单调降 1 分（恒 DOWN：在团降价恒审批档，见头注重跑论证）
if (!Number.isSafeInteger(oldCents) || oldCents <= 1)
  die(`head 价异常（${oldMoney}）——单调降策不可用`);
const newMoney = `${Math.floor(newCents / 100)}.${String(newCents % 100).padStart(2, '0')}`;

// ---- ④⑤ POST /lawyer/pricing/change（律师腿真链） ----
const draft = {
  base_version: baseVersion,
  ...(isPerHead ? { per_head: newMoney } : { session_total: newMoney }),
  ...(acceptMin !== '' ? { accept_min: Number(acceptMin), accept_max: Number(acceptMax) } : {}),
  one_on_one_prices: JSON.parse(oneOnOne),
};
const change = await httpJson(
  'POST',
  '/lawyer/pricing/change',
  { new_version_draft: draft },
  token,
);
if (!(change.status >= 200 && change.status < 300) || change.body?.result !== 'PENDING_APPROVAL') {
  die(
    `改价申请未入审批档（HTTP ${change.status}）：${change.text.slice(0, 300)}\n` +
      `（真链失败——W3-6 降级路径=seed-pricing.mjs 直插，须在任务报告记录失败原因）`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    history_id: Number(change.body.history_id),
    lawyer_id: lawyerId,
    base_version: baseVersion,
    new_version: Number(change.body.new_version),
    old_price: oldMoney,
    new_price: newMoney,
    result: change.body.result,
    approve: 'POST /pricing/change/:id/approve {approved:true, approval_id:<正整数>}（admin）',
  })}\n`,
);
