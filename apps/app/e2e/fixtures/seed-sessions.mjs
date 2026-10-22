// apps/app/e2e/fixtures/seed-sessions.mjs —— 场次种子夹具（M3-W1 T2）：
// 种 1 名审核 PASSED 律师 + 3 个场次（报名中/已成团/进行中各一），供首页/列表/详情三视图
// 对接真实 core API 联调与 T5 E2E。
//
// 幂等（覆盖式重播）：
//   - 律师：users 按 phone_blind_idx ON CONFLICT 跳过；lawyer_profiles 按 user_id ON CONFLICT
//     并强制 audit_status='PASSED'（GET /sessions 仅展示 PASSED 律师的场次——session.service.list）；
//   - 场次：按（lawyer_id, 固定 slot_start 集合）先 DELETE 再 INSERT——重跑换新 id。
// 纪律注记：audit_status/status 直插为 dev 造数口径（运行时迁移一律走 core 状态机守卫），
// 与 core 测试面 trade-fixture.ts 直插先例同形；夹具不改任何 core 源码/表结构。
// 密钥口径：列加密/盲索引经 core dist IdentityCryptoService 运行时实例（见 lib.mjs 头注）。
import { createHash } from 'node:crypto';
import process from 'node:process';
import { byteaLiteral, coreIdentityCrypto, psql, psqlFirst, sqlString } from './lib.mjs';

const LAWYER_PHONE = '13900000001'; // dev 夹具律师号（大陆 11 位；明文仅存于本夹具与请求入参）
const LAWYER_LICENSE = 'LJR-FIXTURE-LICENSE-0001'; // 虚构执业证号（列加密+盲索引落库）

/** 三场次（固定 slot_start=幂等键成分；金额 NUMERIC 两位小数字符串语义，CHECK joined<=capacity） */
const SESSIONS = [
  {
    status: 'CREATED', // 报名中（公开列表可见位）
    slotStart: '2026-12-18 20:00:00+08',
    deadline: '2026-12-17 20:00:00+08',
    priceMode: 'per_head',
    unitPrice: '199.00',
    total: '995.00',
    capacity: 5,
    joined: 3,
    roomMode: 'video',
  },
  {
    status: 'FULL', // 已成团 · 锁人（详情可见；公开列表不出——core W3-12）
    slotStart: '2026-11-20 19:30:00+08',
    deadline: '2026-11-19 19:30:00+08',
    priceMode: 'per_head',
    unitPrice: '159.00',
    total: '795.00',
    capacity: 5,
    joined: 5,
    roomMode: 'voice',
  },
  {
    status: 'IN_SERVICE', // 进行中（详情可见）
    slotStart: '2026-10-30 20:00:00+08',
    deadline: '2026-10-29 20:00:00+08',
    priceMode: 'session_total',
    unitPrice: '150.00', // 总价 1200 ÷ 8 恰整除的分摊快照
    total: '1200.00',
    capacity: 8,
    joined: 8,
    roomMode: 'text',
  },
];

const { crypto } = coreIdentityCrypto();

// ---- 律师账号（真实列加密形态：phone_enc=AES-256-GCM 信封，盲索引=HMAC） ----
const phoneBlind = crypto.blindIndex(LAWYER_PHONE);
psql(
  `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
     VALUES (${byteaLiteral(crypto.encryptPhone(LAWYER_PHONE))}, '${phoneBlind}', 'ACTIVE', true)
   ON CONFLICT (phone_blind_idx) DO NOTHING;`,
);
const lawyerId = Number(
  psqlFirst(`SELECT id FROM identity.users WHERE phone_blind_idx = '${phoneBlind}';`),
);
if (!Number.isInteger(lawyerId) || lawyerId <= 0) {
  process.stderr.write('律师账号种入失败（未取得 user id）\n');
  process.exit(1);
}

psql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES (${lawyerId}, 'user'), (${lawyerId}, 'lawyer')
   ON CONFLICT DO NOTHING;`,
);

// ---- 律师档案（PASSED——GET /sessions 的展示闸；材料指纹=确定性 sha256，非真实材料集） ----
const licenseBlind = crypto.blindIndex(LAWYER_LICENSE);
const fingerprint = createHash('sha256').update(`ljr-fixture:${LAWYER_LICENSE}:v1`).digest('hex');
psql(
  `INSERT INTO identity.lawyer_profiles
     (user_id, license_no_enc, license_no_blind_idx, firm_name, material_version,
      material_fingerprint, audit_status, submitted_at, audited_at, city)
   VALUES (${lawyerId}, ${byteaLiteral(crypto.encryptIdentityField(LAWYER_LICENSE))}, '${licenseBlind}',
           ${sqlString('律聚人联营律师事务所（夹具）')}, 1, '${fingerprint}', 'PASSED', now(), now(), '北京')
   ON CONFLICT (user_id) DO UPDATE SET audit_status = 'PASSED';`,
);

// ---- B3 价格配置（M3-W1 T3 增量：发团流 resolvePublishPlan 依赖——session_total 模式 +
//      accept 范围 2..6 + 1对1 三通道区间合法；INSERT-only 守卫无版本行才插=幂等） ----
const pricingInserted = psqlFirst(
  `INSERT INTO pricing.price_versions
     (lawyer_id, version, session_total, accept_min, accept_max, one_on_one_prices)
   SELECT ${lawyerId}, 1, 600.00, 2, 6,
          '{"text":{"per_round":"80.00"},"voice":{"per_15min":"100.00"},"video":{"per_15min":"150.00"}}'::jsonb
   WHERE NOT EXISTS (SELECT 1 FROM pricing.price_versions WHERE lawyer_id = ${lawyerId})
   RETURNING id;`,
);
const pricing = pricingInserted === '' ? 'exists(kept)' : 'v1(600.00, 2..6)';

// ---- 场次（覆盖式重播：固定 slot_start 集合先删后插） ----
const slotList = SESSIONS.map((s) => sqlString(s.slotStart)).join(', ');
psql(`DELETE FROM trade.sessions WHERE lawyer_id = ${lawyerId} AND slot_start IN (${slotList});`);

const ids = [];
for (const s of SESSIONS) {
  const id = psqlFirst(
    `INSERT INTO trade.sessions
       (lawyer_id, mode, specialty, city, slot_start, price_mode, unit_price, session_total,
        capacity, joined, enroll_deadline, room_mode, status)
     VALUES (${lawyerId}, 'B2C', 'labor_arbitration', '北京', ${sqlString(s.slotStart)},
             ${sqlString(s.priceMode)}, ${sqlString(s.unitPrice)}, ${sqlString(s.total)},
             ${s.capacity}, ${s.joined}, ${sqlString(s.deadline)}, ${sqlString(s.roomMode)},
             ${sqlString(s.status)})
     RETURNING id;`,
  );
  ids.push(Number(id));
}

process.stdout.write(
  `${JSON.stringify({
    lawyer_user_id: lawyerId,
    pricing,
    sessions: SESSIONS.map((s, i) => ({
      id: ids[i],
      status: s.status,
      slot_start: s.slotStart,
    })),
  })}\n`,
);
