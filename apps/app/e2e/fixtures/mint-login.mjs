// apps/app/e2e/fixtures/mint-login.mjs —— dev 取码夹具（M3-W1 T2 建/T3 扩展）：
// 对给定手机号按 identity.service 同款算法（blind=HMAC-SHA256(phone, pepper)、
// code_hash=sha256(`${code}:${blind}`)）构造验证码并直插 identity.verify_codes，
// 供本地联调/E2E 经 POST /auth/verify 换 token（core mock SMS 通道无回显面——设计决策文档 triage-1）。
//
// 用法：node apps/app/e2e/fixtures/mint-login.mjs <大陆11位手机号> [6位验证码] [--realname]
//   验证码缺省=随机生成；可重复执行（先清同号未消费夹具码再插新码=覆盖式幂等）。
//   --realname（T3 扩展，幂等）：
//     ① 确保用户行存在（identity.users 真实列加密形态 INSERT ON CONFLICT——可造第二个用户，
//        用户也会在首次 /auth/verify 时自然创建，本步让「未登录先备实名」可行）；
//     ② 直插 identity.real_name_infos VERIFIED 行（A2 沙箱过审的夹具捷径：dev 联调/E2E
//        免走 POST /realname 表单；w3-smoke 沙箱真实路径=提交校验位合法证件号由 MOCK 通道
//        即时 VERIFIED——App 端实名页走的即该真链，本夹具只服务「预置已实名用户」场景）。
// 有效期：夹具码 10 分钟（verify 仅校验 expires_at > now()；core 正常签发 TTL=60s，夹具放宽便于联调）。
// 密钥口径：pepper 经 core dist 运行时装载（见 lib.mjs 头注），秘钥值不出现在任何源码/输出。
import { createHash, randomInt } from 'node:crypto';
import process from 'node:process';
import { byteaLiteral, coreIdentityCrypto, psql, psqlFirst } from './lib.mjs';

const MAINLAND_PHONE = /^1[3-9]\d{9}$/;
const CODE_6 = /^\d{6}$/;
const FIXTURE_TTL_SEC = 600;

const args = process.argv.slice(2);
const withRealname = args.includes('--realname');
const [phoneArg, codeArg] = args.filter((a) => a !== '--realname');
if (!phoneArg || !MAINLAND_PHONE.test(phoneArg)) {
  process.stderr.write(
    '用法: node apps/app/e2e/fixtures/mint-login.mjs <大陆11位手机号> [6位验证码] [--realname]\n',
  );
  process.exit(1);
}
if (codeArg !== undefined && !CODE_6.test(codeArg)) {
  process.stderr.write('验证码须为 6 位数字（或省略由夹具随机生成）\n');
  process.exit(1);
}

const { crypto, hashCodeValue } = coreIdentityCrypto();
const blind = crypto.blindIndex(phoneArg);
const code = codeArg ?? String(randomInt(100_000, 1_000_000));
const codeHash = hashCodeValue(code, blind);

psql(
  `BEGIN;
   DELETE FROM identity.verify_codes WHERE phone_blind_idx = '${blind}' AND consumed_at IS NULL;
   INSERT INTO identity.verify_codes (phone_blind_idx, code_hash, expires_at)
     VALUES ('${blind}', '${codeHash}', now() + (${FIXTURE_TTL_SEC}::bigint * interval '1 second'));
   COMMIT;`,
);

let userId = null;
let realname = 'skipped';
if (withRealname) {
  // ① 用户行（真实列加密形态；首次 /auth/verify 也会建，此处先行备好供实名行挂靠）
  psql(
    `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
       VALUES (${byteaLiteral(crypto.encryptPhone(phoneArg))}, '${blind}', 'ACTIVE', true)
     ON CONFLICT (phone_blind_idx) DO NOTHING;`,
  );
  userId = Number(psqlFirst(`SELECT id FROM identity.users WHERE phone_blind_idx = '${blind}';`));
  if (!Number.isInteger(userId) || userId <= 0) {
    process.stderr.write('用户行种入失败（未取得 user id）\n');
    process.exit(1);
  }
  // 角色行（R-02 默认 user 身份——verify 遇无角色存量账号会 E_INTERNAL「账号无任何角色」）
  psql(
    `INSERT INTO identity.user_roles (user_id, role) VALUES (${userId}, 'user') ON CONFLICT DO NOTHING;`,
  );
  // ② 实名 VERIFIED（凭据摘要=确定性 sha256，非真实凭据；重提幂等=UNIQUE(user_id) ON CONFLICT 跳过）
  const digest = createHash('sha256').update(`ljr-fixture-realname:${phoneArg}`).digest('hex');
  const inserted = psqlFirst(
    `INSERT INTO identity.real_name_infos (user_id, verify_provider, verify_token_digest, verified_at)
       VALUES (${userId}, 'MOCK', '${digest}', now())
     ON CONFLICT (user_id) DO NOTHING
     RETURNING id;`,
  );
  realname = inserted === '' ? 'exists(kept)' : 'VERIFIED';
}

process.stdout.write(
  `${JSON.stringify({
    phone: phoneArg,
    code,
    ttl_sec: FIXTURE_TTL_SEC,
    ...(withRealname ? { user_id: userId, realname } : {}),
    verify: 'POST /auth/verify {phone, code} → {access_token, refresh_token, roles}',
  })}\n`,
);
