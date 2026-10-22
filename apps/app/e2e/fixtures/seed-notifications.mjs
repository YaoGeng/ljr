// apps/app/e2e/fixtures/seed-notifications.mjs —— T4 消息中心夹具（M3-W1）：
// 给定手机号（须已存在用户行——先跑 mint-login.mjs [--realname]）直插两条 SENT INBOX
// 站内信（SESSION_REMIND 带渲染参数 / PRICE_DOWN_COMP 静态话术），供本地联调/T5 E2E 验证
// GET /notifications/mine 列表渲染与通知偏好条目面。
//
// 为什么需要夹具（任务报告 triage 事实源）：core 通知生产方=场次提醒调度（REMIND_24H/1H/… 到点
// 触发）/C6 三档改价/C5 改期超时——报名/支付/成团链无通知生产方，纯报名链后 inbox 恒空；
// E2E 无法在容忍窗内自然产出通知，故按夹具纪律（只 INSERT 数据，先例=seed-sessions 直插场次）
// 预置等价 SENT 行（channel=INBOX/status=SENT=listInbox 的取数谓词）。
//
// 附带：SESSION_REMIND 模板行自愈 seed（reminder.service 惰性自愈同款 INSERT——REMIND 调度
// 未触发过的 dev 库模板行缺失，通知偏好 PUT 该 code 会 404 E_NOT_FOUND，T4 实证）；
// code/缺省话术常量经 core dist 导出装载，零复制。
//
// 用法：node apps/app/e2e/fixtures/seed-notifications.mjs <大陆11位手机号>
// 幂等：idempotency_key UNIQUE ON CONFLICT DO NOTHING——重跑零新增；模板行同 ON CONFLICT 幂等。
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { coreIdentityCrypto, psqlFirst, sqlString } from './lib.mjs';

const CORE_DIST = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'services',
  'core',
  'dist',
);
const reminderMod = await import(
  pathToFileURL(path.join(CORE_DIST, 'modules', 'notify', 'reminder.service.js')).href
);

const MAINLAND_PHONE = /^1[3-9]\d{9}$/;

const args = process.argv.slice(2);
const phone = args[0];
if (!phone || !MAINLAND_PHONE.test(phone)) {
  process.stderr.write(
    '用法: node apps/app/e2e/fixtures/seed-notifications.mjs <大陆11位手机号>\n',
  );
  process.exit(1);
}

const { crypto } = coreIdentityCrypto();
const blind = crypto.blindIndex(phone);
const userId = Number(
  psqlFirst(`SELECT id FROM identity.users WHERE phone_blind_idx = '${blind}';`),
);
if (!Number.isInteger(userId) || userId <= 0) {
  process.stderr.write(
    `用户行不存在（${phone}）——先运行: node apps/app/e2e/fixtures/mint-login.mjs ${phone} --realname\n`,
  );
  process.exit(1);
}

// ① SESSION_REMIND 模板行自愈（reminder.service ensureSessionRemindTemplate 同款语句）
psqlFirst(
  `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
   VALUES (${sqlString(reminderMod.SESSION_REMIND_TEMPLATE_CODE)}, 'INBOX',
           ${sqlString(reminderMod.DEFAULT_SESSION_REMIND_TEMPLATE_CONTENT)}, 1, false)
   ON CONFLICT (code) DO NOTHING
   RETURNING code;`,
);

// ② 两条 SENT INBOX 通知（SESSION_REMIND 参数对齐 reminder.service 实文四键：
// session_id/kind/slot_start/kind_label；slot_start 取未来 7 天——渲染展示位有值即可）
const slotStart = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const rows = [
  {
    key: `fixture/notify/${phone}/sremind`,
    template: reminderMod.SESSION_REMIND_TEMPLATE_CODE,
    params: { session_id: 0, kind: 'REMIND_24H', slot_start: slotStart, kind_label: '24 小时前' },
  },
  {
    key: `fixture/notify/${phone}/price-down`,
    template: 'PRICE_DOWN_COMP',
    params: {},
  },
];

let inserted = 0;
for (const r of rows) {
  const out = psqlFirst(
    `INSERT INTO notify.notifications (user_id, channel, template_code, params, status, sent_at, idempotency_key)
     VALUES (${userId}, 'INBOX', ${sqlString(r.template)}, ${sqlString(JSON.stringify(r.params))}::jsonb,
             'SENT', now(), ${sqlString(r.key)})
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id;`,
  );
  // DO NOTHING 冲突时 psql 无 RETURNING 行、首行=命令标签「INSERT 0 0」——以标签形态判未插入
  if (out !== '' && !out.startsWith('INSERT')) inserted += 1;
}

process.stdout.write(
  `${JSON.stringify({
    phone,
    user_id: userId,
    inserted,
    idempotent: inserted === 2 ? 'seeded' : `exists(kept, inserted=${inserted})`,
    template: 'SESSION_REMIND ensured',
    verify: 'GET /notifications/mine（Bearer）→ 2 行 SENT INBOX',
  })}\n`,
);
