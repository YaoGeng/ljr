// apps/app/e2e/fixtures/seed-admin-lawyer.mjs —— H1 审核工作台 SUBMITTED 夹具（M3-W3 T2）：
// 种 1 名待审（SUBMITTED）律师档案，供 apps/admin #/lawyers 工作台对接真实 core API 联调
// 与 T7 E2E J14（SUBMITTED 可见 → audit 真链状态流转）。
//
// 用法：node apps/app/e2e/fixtures/seed-admin-lawyer.mjs
//   （需先 node scripts/db/start.mjs 起 PG、pnpm --filter @ljr/core build 出 dist——密钥装载依赖）
//
// 幂等（重跑复位规范态，对照 seed-sessions.mjs 形态）：
//   - 用户行：identity.users 按 phone_blind_idx ON CONFLICT 跳过（手机号=13700000002 稳定坐标）；
//   - 角色行：identity.user_roles（user+lawyer）ON CONFLICT DO NOTHING；
//   - 律师档案：identity.lawyer_profiles 按 user_id ON CONFLICT **DO UPDATE 复位 SUBMITTED**
//     （重跑即回到待审规范态——审核链实验后可重放；复位同时清 audited_at/auditor_id/
//     reject_reason/firm_id/city——A3b 进件回填位与城市维归位规范态，满足 CHECK
//     ck_lawyer_profiles_reject_reason：非 REJECTED 态须 NULL）；
//   - 资质材料：identity.qualification_files 按 (lawyer_id, material_version=1) 先删后插
//     （覆盖式重播，seed-sessions 场次同形）。
// 列读取对照：ops/lawyer-admin.service listWorkbench 经 A3a listSubmissions 读
//   identity.lawyer_profiles（id/user_id/audit_status/firm_name/material_version/submitted_at），
//   ORDER BY submitted_at ASC NULLS LAST, id ASC——本夹具 submitted_at=now() 即可入列。
// 纪律注记：audit_status 直插为 dev 造数口径（运行时迁移一律走 core 状态机守卫），
//   与 core 测试面/seed-sessions 直插先例同形；夹具不改任何 core 源码/表结构。
// 密钥口径：列加密/盲索引经 core dist IdentityCryptoService 运行时实例（见 lib.mjs 头注）。
import { createHash } from 'node:crypto';
import process from 'node:process';
import { byteaLiteral, coreIdentityCrypto, psql, psqlFirst, sqlString } from './lib.mjs';

const LAWYER_PHONE = '13700000002'; // E2E admin 面待审律师稳定坐标（admin 号 13700000001 之外的第二号段）
const LAWYER_LICENSE = 'LJR-FIXTURE-LICENSE-ADMIN-0002'; // 虚构执业证号（列加密+盲索引落库）
const LAWYER_FIRM = '律聚人联营律师事务所（待审夹具）';

const { crypto } = coreIdentityCrypto();

// ---- 用户行（真实列加密形态：phone_enc=AES-256-GCM 信封，盲索引=HMAC） ----
const phoneBlind = crypto.blindIndex(LAWYER_PHONE);
psql(
  `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
     VALUES (${byteaLiteral(crypto.encryptPhone(LAWYER_PHONE))}, '${phoneBlind}', 'ACTIVE', true)
   ON CONFLICT (phone_blind_idx) DO NOTHING;`,
);
const userId = Number(
  psqlFirst(`SELECT id FROM identity.users WHERE phone_blind_idx = '${phoneBlind}';`),
);
if (!Number.isInteger(userId) || userId <= 0) {
  process.stderr.write('待审律师用户行种入失败（未取得 user id）\n');
  process.exit(1);
}

// ---- 角色行（user=R-02 默认身份；lawyer=角色授予本应经 LawyerAuditPassed——dev 造数直插先例） ----
psql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES (${userId}, 'user'), (${userId}, 'lawyer')
   ON CONFLICT DO NOTHING;`,
);

// ---- 律师档案（SUBMITTED 规范态；重跑复位——DO UPDATE 满足 CHECK：非 REJECTED 态 reject_reason 置 NULL） ----
const licenseBlind = crypto.blindIndex(LAWYER_LICENSE);
const fingerprint = createHash('sha256').update(`ljr-fixture:${LAWYER_LICENSE}:v1`).digest('hex');
psql(
  `INSERT INTO identity.lawyer_profiles
     (user_id, license_no_enc, license_no_blind_idx, firm_name, material_version,
      material_fingerprint, audit_status, submitted_at, audited_at, auditor_id, reject_reason, city)
   VALUES (${userId}, ${byteaLiteral(crypto.encryptIdentityField(LAWYER_LICENSE))}, '${licenseBlind}',
           ${sqlString(LAWYER_FIRM)}, 1, '${fingerprint}', 'SUBMITTED', now(), NULL, NULL, NULL, '北京')
   ON CONFLICT (user_id) DO UPDATE SET
     license_no_enc = EXCLUDED.license_no_enc,
     license_no_blind_idx = EXCLUDED.license_no_blind_idx,
     firm_name = EXCLUDED.firm_name,
     firm_id = NULL,
     city = '北京',
     material_version = 1,
     material_fingerprint = EXCLUDED.material_fingerprint,
     audit_status = 'SUBMITTED',
     submitted_at = now(),
     audited_at = NULL,
     auditor_id = NULL,
     reject_reason = NULL;`,
);
const profileId = Number(
  psqlFirst(`SELECT id FROM identity.lawyer_profiles WHERE user_id = ${userId};`),
);
if (!Number.isInteger(profileId) || profileId <= 0) {
  process.stderr.write('待审律师档案行种入失败（未取得 profile id）\n');
  process.exit(1);
}

// ---- 资质材料 v1（审核追溯面；kind 对照 V15 注释词汇；覆盖式重播） ----
psql(
  `DELETE FROM identity.qualification_files WHERE lawyer_id = ${profileId} AND material_version = 1;`,
);
for (const [kind, ref] of [
  ['LICENSE_PHOTO', 'ljr-fixture://admin-lawyer/license-photo-v1'],
  ['FIRM_AUTHORIZATION', 'ljr-fixture://admin-lawyer/firm-authorization-v1'],
]) {
  psql(
    `INSERT INTO identity.qualification_files (lawyer_id, material_version, file_ref, kind)
       VALUES (${profileId}, 1, ${sqlString(ref)}, ${sqlString(kind)});`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    user_id: userId,
    profile_id: profileId,
    status: 'SUBMITTED',
    workbench: 'GET /admin/lawyers（缺省审核队列 SUBMITTED|IN_REVIEW，提交时间 ASC）',
    audit: 'POST /admin/lawyers/:id/audit {action: claim|approve|reject|suspend|resume}',
  })}\n`,
);
