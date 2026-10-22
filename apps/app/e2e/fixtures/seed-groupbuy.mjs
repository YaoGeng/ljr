// apps/app/e2e/fixtures/seed-groupbuy.mjs —— C2B 拼团响应链种子夹具（M3-W2 T4）：
// 造两组「接单大厅可操作」数据 = ①PENDING_LAWYER 团（指定律师 1 待确认 + 2 条 PAID 参与报名
// ——confirm 的参与者契约下界）②PUBLISHED 团（公开列表可见 + 1 条 PAID 参与报名——
// convert 的迁移面），供本卡真库实证与 T7 E2E（J10 接单大厅 confirm → 我的响应可见）作数据底座。
//
// 为什么直插：W1 E2E 先例——C2B 真链发团需问题树作答+实名+发起人支付+第二人加入支付，
// dev 造数直插远省（W2-6 同款裁剪：seed-room 先例）；status 直插为 dev 造数口径（运行时
// 迁移一律走 core 状态机守卫），不改任何 core 源码/表结构。
//
// 幂等（id 稳定式重播，重跑不换 id——E2E stdout 锚不漂移）：
//   - 律师/用户行：users 按 phone_blind_idx ON CONFLICT 跳过；user_roles ON CONFLICT 跳过；
//     B3 v1 INSERT-only 守卫（在册任何版本即不插）；
//   - 团：固定 slot_start（lawyer+slot 定位，seed-sessions 同键形）——无则 INSERT、有则
//     UPDATE 回写规范态（被测试改动后重跑复位）；
//   - 报名：按 (ref_type,ref_id,user_id,PAID) 在册即保留。
//
// 列实查依据（先读迁移再写 INSERT，禁猜）：trade.group_buys=V24（八态 ck/sub_min<=sub_max/
// share_price 非负）+V33（specialty/city）；trade.enrollments=V26（price_snapshot 六键、
// price_version_id=版本号数值——seed-room 头注同源）。PENDING_LAWYER 直插带 lawyer_confirm_by
// （C2 §4：REACHED 时点+12h 锚——core confirm 只读该列做展示，守卫校验在状态机）。
import { createHash } from 'node:crypto';
import process from 'node:process';
import {
  byteaLiteral,
  coreIdentityCrypto,
  psql,
  psqlFirst,
  returningRow,
  sqlString,
} from './lib.mjs';

const LAWYER_PHONE = '13900000001'; // dev 夹具律师号（seed-sessions/seed-room 同号——幂等兼容）
const LAWYER_LICENSE = 'LJR-FIXTURE-LICENSE-0001';
const INITIATOR_PHONE = '13900000102'; // 拼团发起人（夹具号段 139000001xx，虚构）
const MEMBER_PHONE = '13900000103'; // 第二参与者（PENDING_LAWYER 的参与者契约下界 2）
const LAWYER2_PHONE = '13900000104'; // 第二律师（其 PUBLISHED 团=大厅「已指定律师」浏览行——I-1 分流实证/T7）
const LAWYER2_LICENSE = 'LJR-FIXTURE-LICENSE-0002';

// 固定 slot=幂等键成分（十二月/一月虚构日期段，与 seed-sessions/seed-room 时段互不重叠）
const PENDING_SLOT = '2026-12-28 19:00:00+08';
// deadline=虚构未来值（ENROLL_DEADLINE job 锚）；「已达线锁人→待确认」语义由直插 status 承载，
// 不由 deadline 过期驱动（评审 N-4：勿注释成「截止已过」——运行时该时刻未到）
const PENDING_DEADLINE = '2026-12-27 19:00:00+08';
const PUBLISHED_SLOT = '2027-01-08 19:00:00+08';
const PUBLISHED_DEADLINE = '2027-01-07 19:00:00+08'; // 截止未到（拼团中）
const OTHER_LAWYER_SLOT = '2027-01-09 19:00:00+08'; // 第二律师的团（律师 1 视角=非本人行）
const OTHER_LAWYER_DEADLINE = '2027-01-08 19:00:00+08';
const SNAPSHOT_AT = '2026-12-20T10:00:00+08:00'; // 快照时点（虚构确定性值）

const PENDING_GB = {
  subMin: 2,
  subMax: 4,
  sharePrice: '150.00',
  tags: ['加班费', '经济补偿金'],
  status: 'PENDING_LAWYER',
  confirmByHours: 12, // lawyer_confirm_by = now()+12h（重跑复位为满窗）
};
const PUBLISHED_GB = {
  subMin: 3,
  subMax: 6,
  sharePrice: '120.00',
  tags: ['年终奖争议'],
  status: 'PUBLISHED',
};
const OTHER_LAWYER_GB = {
  subMin: 2,
  subMax: 3,
  sharePrice: '200.00',
  tags: ['未签劳动合同'],
  status: 'PUBLISHED',
};

const { crypto } = coreIdentityCrypto();

// ---- 通用造数：用户行（真实列加密形态）+ user 角色 ----
function ensureUser(phone) {
  const blind = crypto.blindIndex(phone);
  psql(
    `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
       VALUES (${byteaLiteral(crypto.encryptPhone(phone))}, '${blind}', 'ACTIVE', true)
     ON CONFLICT (phone_blind_idx) DO NOTHING;`,
  );
  const id = Number(psqlFirst(`SELECT id FROM identity.users WHERE phone_blind_idx = '${blind}';`));
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`用户 ${phone} 种入失败（未取得 user id）\n`);
    process.exit(1);
  }
  psql(
    `INSERT INTO identity.user_roles (user_id, role) VALUES (${id}, 'user') ON CONFLICT DO NOTHING;`,
  );
  return id;
}

// ---- 律师账号（seed-sessions/seed-room 同款引导，幂等；B3 v1 为 convert 缺省价源存在前提） ----
/** 律师行（user+lawyer 角色+PASSED 档案——公开列表可见性前提；幂等兼容 seed-sessions 同号） */
function ensureLawyer(phone, license, firmName) {
  const userId = ensureUser(phone);
  psql(
    `INSERT INTO identity.user_roles (user_id, role) VALUES (${userId}, 'lawyer') ON CONFLICT DO NOTHING;`,
  );
  const licenseBlind = crypto.blindIndex(license);
  const fingerprint = createHash('sha256').update(`ljr-fixture:${license}:v1`).digest('hex');
  psql(
    `INSERT INTO identity.lawyer_profiles
       (user_id, license_no_enc, license_no_blind_idx, firm_name, material_version,
        material_fingerprint, audit_status, submitted_at, audited_at, city)
     VALUES (${userId}, ${byteaLiteral(crypto.encryptIdentityField(license))}, '${licenseBlind}',
             ${sqlString(firmName)}, 1, '${fingerprint}', 'PASSED', now(), now(), '北京')
     ON CONFLICT (user_id) DO UPDATE SET audit_status = 'PASSED';`,
  );
  return userId;
}

const lawyerId = ensureLawyer(LAWYER_PHONE, LAWYER_LICENSE, '律聚人联营律师事务所（夹具）');
// B3 价格 v1（INSERT-only 守卫）。convert 缺省价=per_head 优先/次选 session_total
// （group-buy-response.service resolveConvertPrice）——V17 ck_price_versions_pricing_mode
// XOR CHECK 决定两键互斥不可能同配（评审 N-3），本行仅 session_total 600.00 →
// convert 缺省走 session_total 分摊支（splitTotalIntoUnit 半分向上到分）
psql(
  `INSERT INTO pricing.price_versions
     (lawyer_id, version, session_total, accept_min, accept_max, one_on_one_prices)
   SELECT ${lawyerId}, 1, 600.00, 2, 6,
          '{"text":{"per_round":"80.00"},"voice":{"per_15min":"100.00"},"video":{"per_15min":"150.00"}}'::jsonb
   WHERE NOT EXISTS (SELECT 1 FROM pricing.price_versions WHERE lawyer_id = ${lawyerId});`,
);
// 第二律师（仅 PASSED 档案——其团在大厅公开面可见即可，无 B3/动作面需求）
const lawyer2Id = ensureLawyer(LAWYER2_PHONE, LAWYER2_LICENSE, '夹具第二律师事务所');

const initiatorId = ensureUser(INITIATOR_PHONE);
const memberId = ensureUser(MEMBER_PHONE);

// ---- 团行（固定 slot 定位：无则 INSERT、有则 UPDATE 回写规范态——重跑 id 稳定） ----
function seedGroupBuy({
  lawyerId: ownerLawyerId,
  slotStart,
  deadline,
  subMin,
  subMax,
  sharePrice,
  tags,
  status,
  confirmBy,
}) {
  const tagJson = JSON.stringify(tags);
  const confirmByExpr =
    confirmBy === null ? 'NULL' : `now() + (${confirmBy}::bigint * interval '1 hour')`;
  const inserted = returningRow(
    psqlFirst(
      `INSERT INTO trade.group_buys
         (initiator_id, lawyer_id, specialty, city, slot_start, sub_min, sub_max,
          share_price, question_tags, deadline, status, lawyer_confirm_by)
       SELECT ${initiatorId}, ${ownerLawyerId}, 'labor_arbitration', '北京', ${sqlString(slotStart)},
              ${subMin}, ${subMax}, ${sqlString(sharePrice)}, ${sqlString(tagJson)}::jsonb,
              ${sqlString(deadline)}, ${sqlString(status)}, ${confirmByExpr}
       WHERE NOT EXISTS (
         SELECT 1 FROM trade.group_buys WHERE lawyer_id = ${ownerLawyerId} AND slot_start = ${sqlString(slotStart)}
       )
       RETURNING id;`,
    ),
  );
  const id =
    inserted !== ''
      ? Number(inserted)
      : Number(
          psqlFirst(
            `SELECT id FROM trade.group_buys
              WHERE lawyer_id = ${ownerLawyerId} AND slot_start = ${sqlString(slotStart)};`,
          ),
        );
  if (!Number.isInteger(id) || id <= 0) {
    process.stderr.write(`团种入失败（${slotStart}）\n`);
    process.exit(1);
  }
  // 规范态回写（status/lawyer_confirm_by/session_id 清回链——被 confirm/convert 消费后重跑复位）
  psql(
    `UPDATE trade.group_buys SET
       status = ${sqlString(status)}, status_since = now(), session_id = NULL,
       lawyer_confirm_by = ${confirmByExpr}, deadline = ${sqlString(deadline)},
       sub_min = ${subMin}, sub_max = ${subMax}, share_price = ${sqlString(sharePrice)},
       question_tags = ${sqlString(tagJson)}::jsonb
     WHERE id = ${id};`,
  );
  return id;
}

// ---- 参与报名（在册即保留；price_snapshot 六键=V26 头注⑦同源，groupbuy 行 share_price 语义键在值） ----
function seedEnrollment(gbId, userId, sharePrice) {
  const existing = psqlFirst(
    `SELECT id FROM trade.enrollments
      WHERE ref_type = 'groupbuy' AND ref_id = ${gbId} AND user_id = ${userId}
        AND pay_status = 'PAID';`,
  );
  if (existing !== '') return { id: Number(existing), state: 'exists(kept)' };
  const priceSnapshot = JSON.stringify({
    price_mode: 'per_head',
    unit_price: sharePrice,
    share_price: sharePrice, // C2B 语义键（B2C 场次行恒 null——V26 头注⑦对照）
    session_total: sharePrice,
    price_version: 1,
    snapshot_at: SNAPSHOT_AT,
  });
  const id = Number(
    returningRow(
      psqlFirst(
        `INSERT INTO trade.enrollments
           (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount,
            cash_amount, points_amount, price_version_id, pay_status, credit_used)
         VALUES ('groupbuy', ${gbId}, ${userId}, ${sqlString(priceSnapshot)}::jsonb,
                 ${sqlString(sharePrice)}, ${sqlString(sharePrice)},
                 ${sqlString(sharePrice)}, 0, 1, 'PAID', 0)
         RETURNING id;`,
      ),
    ),
  );
  return { id, state: 'PAID(seeded)' };
}

// ---- ① PENDING_LAWYER 团 + 2 条 PAID（参与者契约下界——confirm 建面容量=参与者数） ----
const pendingGbId = seedGroupBuy({
  lawyerId,
  slotStart: PENDING_SLOT,
  deadline: PENDING_DEADLINE,
  ...PENDING_GB,
  confirmBy: PENDING_GB.confirmByHours,
});
const e1 = seedEnrollment(pendingGbId, initiatorId, PENDING_GB.sharePrice);
const e2 = seedEnrollment(pendingGbId, memberId, PENDING_GB.sharePrice);

// ---- ② PUBLISHED 团（指定律师 1）+ 1 条 PAID（公开列表可见；convert 迁移面） ----
const publishedGbId = seedGroupBuy({
  lawyerId,
  slotStart: PUBLISHED_SLOT,
  deadline: PUBLISHED_DEADLINE,
  ...PUBLISHED_GB,
  confirmBy: null,
});
const e3 = seedEnrollment(publishedGbId, initiatorId, PUBLISHED_GB.sharePrice);

// ---- ③ 第二律师的 PUBLISHED 团（律师 1 视角=大厅「已指定律师」浏览行——I-1 分流/T7） ----
const otherLawyerGbId = seedGroupBuy({
  lawyerId: lawyer2Id,
  slotStart: OTHER_LAWYER_SLOT,
  deadline: OTHER_LAWYER_DEADLINE,
  ...OTHER_LAWYER_GB,
  confirmBy: null,
});
const e4 = seedEnrollment(otherLawyerGbId, initiatorId, OTHER_LAWYER_GB.sharePrice);

// ---- 自验（状态+参与者计数+公开面可见性前提回显） ----
const verify = psql(
  `SELECT
     (SELECT status FROM trade.group_buys WHERE id = ${pendingGbId}) AS pending_status,
     (SELECT count(*) FROM trade.enrollments
       WHERE ref_type = 'groupbuy' AND ref_id = ${pendingGbId} AND pay_status = 'PAID') AS pending_paid,
     (SELECT status FROM trade.group_buys WHERE id = ${publishedGbId}) AS published_status,
     (SELECT status FROM trade.group_buys WHERE id = ${otherLawyerGbId}) AS other_lawyer_status,
     (SELECT audit_status FROM identity.lawyer_profiles WHERE user_id = ${lawyerId}) AS lawyer_audit;`,
);

process.stdout.write(
  `${JSON.stringify({
    lawyer_user_id: lawyerId,
    lawyer2_user_id: lawyer2Id,
    initiator_user_id: initiatorId,
    member_user_id: memberId,
    pending_gb_id: pendingGbId,
    pending_enrollment_ids: [e1.id, e2.id],
    published_gb_id: publishedGbId,
    published_enrollment_id: e3.id,
    other_lawyer_gb_id: otherLawyerGbId,
    other_lawyer_enrollment_id: e4.id,
    pending_slot: PENDING_SLOT,
    published_slot: PUBLISHED_SLOT,
    other_lawyer_slot: OTHER_LAWYER_SLOT,
    verify: verify.split(/\r?\n/)[0] ?? '',
    hall: `GET /lawyer/group-buys（Bearer 律师）→ 指定律师待确认；GET /group-buys → PUBLISHED 公开面（含他人律师团=已指定律师浏览行）`,
  })}\n`,
);
