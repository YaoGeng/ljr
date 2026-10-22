// apps/app/e2e/fixtures/seed-room.mjs —— 房间在场种子夹具（M3-W2 T1，W2-6 决策）：
// 造一组「房间进行中可入房」数据 = ①场次（OPEN）②room OPEN ③一条 PAID enrollment
// ④room 型 conversation，供 E2E 气泡链（J11 场次看板 / J12 草稿气泡端到端——用户 WSS
// 提问腿的 join/send 成员门与房间 OPEN 门）作数据底座。
//
// 为什么直插：房间 OPEN 由 ROOM_OPEN job 内部驱动（room.service openRoomForSession——
// job 内部路径不走 HTTP，无 dev 造数 HTTP 面），夹具直插是唯一 dev 造数路径（W2-6）。
//
// 幂等（id 稳定式重播，重跑不换 id——E2E stdout 锚不漂移）：
//   - 律师/用户行：users 按 phone_blind_idx ON CONFLICT 跳过；user_roles ON CONFLICT 跳过；
//   - 场次：固定 slot_start（lawyer+slot 定位，seed-sessions 同键形）——无则 INSERT、
//     有则 UPDATE 回写规范态（status/joined 等被测试改动后重跑复位）；
//   - 房间：ux_rooms_session(session_id) 定位——无则 INSERT、有则 UPDATE 回写 OPEN 规范态；
//   - 报名：按 (ref_type,ref_id,user_id,PAID) 在册即保留；
//   - 会话：UNIQUE(type,ref_id) ON CONFLICT DO NOTHING（conversation.service ensure 形态）。
//
// 列实查依据（先读迁移再写 INSERT，禁猜）：
//   - trade.sessions：V23（十态 ck/CHECK joined<=capacity/capacity 2..50）+ V33（specialty/city）；
//     status='OPEN'=已开房态（session.machine CONFIRMED→OPEN；进行中可入房——room OPEN 对齐）；
//   - fulfillment.rooms：V35——grace_end NOT NULL=scheduled_start+5min（R-01 应用层锚定，
//     本夹具直插同锚）；mode ck 三值（=场次 room_mode 透传）；
//   - trade.enrollments：V26——price_snapshot 六键 {price_mode,unit_price,share_price,
//     session_total,price_version,snapshot_at}（enrollment.service L283 同形；B2C 场次行
//     share_price=null）；price_version_id=**版本号数值**（enrollment INSERT 传
//     snapshot.price_version——非 price_versions.id）；
//   - fulfillment.conversations：V37——type='room'，ref_id=rooms.id，UNIQUE(type,ref_id)。
//
// 纪律注记：status 直插为 dev 造数口径（运行时迁移一律走 core 状态机守卫），与
// seed-sessions/trade-fixture 直插先例同形；夹具不改任何 core 源码/表结构。
// 密钥口径：列加密/盲索引经 core dist IdentityCryptoService 运行时实例（见 lib.mjs 头注）。
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

const LAWYER_PHONE = '13900000001'; // dev 夹具律师号（seed-sessions 同号——幂等兼容）
const LAWYER_LICENSE = 'LJR-FIXTURE-LICENSE-0001';
const MEMBER_PHONE = '13900000101'; // 房间在场用户（夹具号段 139000001xx，虚构）

// 固定 slot_start=幂等键成分（seed-sessions 十二月虚构日期段同款未来时刻）
const SLOT_START = '2026-12-26 20:00:00+08';
const ENROLL_DEADLINE = '2026-12-25 20:00:00+08';
const GRACE_END = '2026-12-26 20:05:00+08'; // = SLOT_START+5min（R-01 锚定口径直插）
const SNAPSHOT_AT = '2026-12-20T10:00:00+08:00'; // 快照时点（虚构确定性值）

const SESSION = {
  capacity: 5,
  joined: 1, // 与下方单条 PAID enrollment 一致（CHECK joined<=capacity）
  unitPrice: '99.00', // per_head 单价；session_total=99×5
  sessionTotal: '495.00',
  roomMode: 'text', // 气泡链=图文房间
  status: 'OPEN', // 进行中可入房态（WSS join 门=房间 OPEN；场次开房态对齐）
};

const { crypto } = coreIdentityCrypto();

// ---- 律师账号（seed-sessions 同款引导，幂等；独立可跑不依赖先跑 seed-sessions） ----
const lawyerBlind = crypto.blindIndex(LAWYER_PHONE);
psql(
  `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
     VALUES (${byteaLiteral(crypto.encryptPhone(LAWYER_PHONE))}, '${lawyerBlind}', 'ACTIVE', true)
   ON CONFLICT (phone_blind_idx) DO NOTHING;`,
);
const lawyerId = Number(
  psqlFirst(`SELECT id FROM identity.users WHERE phone_blind_idx = '${lawyerBlind}';`),
);
if (!Number.isInteger(lawyerId) || lawyerId <= 0) {
  process.stderr.write('律师账号种入失败（未取得 user id）\n');
  process.exit(1);
}
psql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES (${lawyerId}, 'user'), (${lawyerId}, 'lawyer')
   ON CONFLICT DO NOTHING;`,
);
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
// B3 价格 v1（INSERT-only 守卫；enrollment.price_version_id=版本号 1 的存在前提）
psql(
  `INSERT INTO pricing.price_versions
     (lawyer_id, version, session_total, accept_min, accept_max, one_on_one_prices)
   SELECT ${lawyerId}, 1, 600.00, 2, 6,
          '{"text":{"per_round":"80.00"},"voice":{"per_15min":"100.00"},"video":{"per_15min":"150.00"}}'::jsonb
   WHERE NOT EXISTS (SELECT 1 FROM pricing.price_versions WHERE lawyer_id = ${lawyerId});`,
);

// ---- 在场用户（seed-sessions 用户造数先例：真实列加密形态 + 默认 user 角色） ----
const memberBlind = crypto.blindIndex(MEMBER_PHONE);
psql(
  `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
     VALUES (${byteaLiteral(crypto.encryptPhone(MEMBER_PHONE))}, '${memberBlind}', 'ACTIVE', true)
   ON CONFLICT (phone_blind_idx) DO NOTHING;`,
);
const memberId = Number(
  psqlFirst(`SELECT id FROM identity.users WHERE phone_blind_idx = '${memberBlind}';`),
);
if (!Number.isInteger(memberId) || memberId <= 0) {
  process.stderr.write('在场用户种入失败（未取得 user id）\n');
  process.exit(1);
}
psql(
  `INSERT INTO identity.user_roles (user_id, role) VALUES (${memberId}, 'user') ON CONFLICT DO NOTHING;`,
);

// ---- ① 场次（固定 slot 定位：无则 INSERT、有则 UPDATE 回写规范态——重跑 id 稳定） ----
const sessionInserted = returningRow(
  psqlFirst(
    `INSERT INTO trade.sessions
       (lawyer_id, mode, specialty, city, slot_start, price_mode, unit_price, session_total,
        capacity, joined, enroll_deadline, room_mode, status)
     SELECT ${lawyerId}, 'B2C', 'labor_arbitration', ${sqlString('北京')}, ${sqlString(SLOT_START)},
            'per_head', ${sqlString(SESSION.unitPrice)}, ${sqlString(SESSION.sessionTotal)},
            ${SESSION.capacity}, ${SESSION.joined}, ${sqlString(ENROLL_DEADLINE)},
            ${sqlString(SESSION.roomMode)}, ${sqlString(SESSION.status)}
     WHERE NOT EXISTS (
       SELECT 1 FROM trade.sessions WHERE lawyer_id = ${lawyerId} AND slot_start = ${sqlString(SLOT_START)}
     )
     RETURNING id;`,
  ),
);
const sessionId =
  sessionInserted !== ''
    ? Number(sessionInserted)
    : Number(
        psqlFirst(
          `SELECT id FROM trade.sessions
            WHERE lawyer_id = ${lawyerId} AND slot_start = ${sqlString(SLOT_START)};`,
        ),
      );
if (!Number.isInteger(sessionId) || sessionId <= 0) {
  process.stderr.write('场次种入失败（未取得 session id）\n');
  process.exit(1);
}
psql(
  `UPDATE trade.sessions SET
     status = ${sqlString(SESSION.status)}, status_since = now(),
     capacity = ${SESSION.capacity}, joined = ${SESSION.joined},
     unit_price = ${sqlString(SESSION.unitPrice)}, session_total = ${sqlString(SESSION.sessionTotal)},
     room_mode = ${sqlString(SESSION.roomMode)}
   WHERE id = ${sessionId};`,
);

// ---- ② 房间（ux_rooms_session 定位：无则 INSERT、有则 UPDATE 回写 OPEN 规范态） ----
const roomInserted = returningRow(
  psqlFirst(
    `INSERT INTO fulfillment.rooms
       (session_id, mode, scheduled_start, opened_at, grace_end, status)
     SELECT ${sessionId}, ${sqlString(SESSION.roomMode)}, ${sqlString(SLOT_START)}, now(),
            ${sqlString(GRACE_END)}, 'OPEN'
     WHERE NOT EXISTS (SELECT 1 FROM fulfillment.rooms WHERE session_id = ${sessionId})
     RETURNING id;`,
  ),
);
const roomId =
  roomInserted !== ''
    ? Number(roomInserted)
    : Number(psqlFirst(`SELECT id FROM fulfillment.rooms WHERE session_id = ${sessionId};`));
if (!Number.isInteger(roomId) || roomId <= 0) {
  process.stderr.write('房间种入失败（未取得 room id）\n');
  process.exit(1);
}
psql(
  `UPDATE fulfillment.rooms SET
     status = 'OPEN', opened_at = now(), closed_at = NULL, open_fail_reason = NULL,
     mode = ${sqlString(SESSION.roomMode)}, scheduled_start = ${sqlString(SLOT_START)},
     grace_end = ${sqlString(GRACE_END)}
   WHERE id = ${roomId};`,
);

// ---- ③ PAID 报名（在册即保留；price_snapshot 六键=V26 头注⑦/enrollment.service 同形） ----
let enrollmentId = Number(
  psqlFirst(
    `SELECT id FROM trade.enrollments
      WHERE ref_type = 'session' AND ref_id = ${sessionId} AND user_id = ${memberId}
        AND pay_status = 'PAID';`,
  ),
);
let enrollmentState = 'exists(kept)';
if (!Number.isInteger(enrollmentId) || enrollmentId <= 0) {
  const priceSnapshot = JSON.stringify({
    price_mode: 'per_head',
    unit_price: SESSION.unitPrice,
    share_price: null, // 分摊额是 C2B 语义——B2C 场次报名行恒 null（V26 头注⑦）
    session_total: SESSION.sessionTotal,
    price_version: 1, // = price_version_id 同值（版本号数值，非 price_versions.id）
    snapshot_at: SNAPSHOT_AT,
  });
  enrollmentId = Number(
    psqlFirst(
      `INSERT INTO trade.enrollments
         (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount,
          cash_amount, points_amount, price_version_id, pay_status, credit_used)
       VALUES ('session', ${sessionId}, ${memberId}, ${sqlString(priceSnapshot)}::jsonb,
               ${sqlString(SESSION.unitPrice)}, ${sqlString(SESSION.unitPrice)},
               ${sqlString(SESSION.unitPrice)}, 0, 1, 'PAID', 0)
       RETURNING id;`,
    ),
  );
  enrollmentState = 'PAID(seeded)';
}

// ---- ④ room 型会话（conversation.service ensureConversation 同款幂等形态） ----
psql(
  `INSERT INTO fulfillment.conversations (type, ref_id)
   VALUES ('room', ${roomId})
   ON CONFLICT (type, ref_id) DO NOTHING;`,
);
const conversationId = Number(
  psqlFirst(`SELECT id FROM fulfillment.conversations WHERE type = 'room' AND ref_id = ${roomId};`),
);
if (!Number.isInteger(conversationId) || conversationId <= 0) {
  process.stderr.write('会话种入失败（未取得 conversation id）\n');
  process.exit(1);
}

// ---- 自验（行数+状态回显 stdout——直插后单查复核） ----
const verify = psql(
  `SELECT
     (SELECT status FROM trade.sessions WHERE id = ${sessionId}) AS session_status,
     (SELECT status FROM fulfillment.rooms WHERE id = ${roomId}) AS room_status,
     (SELECT count(*) FROM trade.enrollments
       WHERE ref_type = 'session' AND ref_id = ${sessionId} AND user_id = ${memberId}
         AND pay_status = 'PAID') AS paid_enrollments,
     (SELECT next_seq FROM fulfillment.conversations WHERE id = ${conversationId}) AS conv_next_seq;`,
);

process.stdout.write(
  `${JSON.stringify({
    lawyer_user_id: lawyerId,
    member_user_id: memberId,
    session_id: sessionId,
    room_id: roomId,
    conversation_id: conversationId,
    enrollment_id: enrollmentId,
    enrollment: enrollmentState,
    slot_start: SLOT_START,
    grace_end: GRACE_END,
    verify: verify.split(/\r?\n/)[0] ?? '',
    wss: `join {conversation_id:${conversationId}} → send（成员门=PAID 报名/场次律师；房间须 OPEN）`,
  })}\n`,
);
