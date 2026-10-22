/**
 * 核心旅程 E2E（M3-W1 T5，A-5 webapp-testing 补验载体；判据=脚本+运行输出留档）：
 * 六条旅程覆盖登录→浏览→报名支付成团（PAID）→发起拼团→我的拼团/消息中心/偏好→A2 训练授权。
 *
 * 运行前提（编排器 run-e2e.mjs 一条命令备齐）：本地 core（PG 5435，双凭据 env 起服）+
 * 夹具全套（问题树/场次/用户/通知）+ `expo export --clear`（EXPO_PUBLIC_API_BASE 指向同源
 * 静态宿+core 反代，EXPO_PUBLIC_DEV_PAY_SIM=1 注入 dev 支付模拟器）+ playwright chromium。
 *
 * 断言口径：用户可见态（文案/徽标/tab 壳）为主锚；资金/状态关键位加 API 终态双面锚
 * （夹具码换 token → GET 真实 core）；禁纯实现细节断言。
 * 旅程有数据序（单 worker 串行）：J5 复用 J4 用户已发布的拼团；J6 复用 J3 报名后的场次余席。
 */
import { test, expect } from '@playwright/test';
import {
  PUBLISHER_PHONE,
  SEED_SESSION_ID,
  SEED_SLOT_TEXT,
  SLOT_DATE,
  SLOT_TIME,
  apiGet,
  apiVerifyToken,
  loginViaUi,
  mintLogin,
  seedNotifications,
} from './helpers';

/** 成团确认容忍窗：core relay 1s 轮询+级联（T3 注记 2-4s）+ EnrollmentScreen 10×700ms 轮询 */
const GROUP_CONFIRM_TIMEOUT = 20_000;

/** 固定旅程用户（可跨跑重放：报名幂等/夹具覆盖式幂等承载重跑） */
const PHONE_J1 = '13800003001';
const PHONE_J3 = '13800003002';
/**
 * J6 用户逐跑唯一：训练授权态跨跑粘滞（GRANTED/REVOKED 均非 ABSENT），固定号重跑时
 * 独立页初始态断言必红——与发团用户同款逐跑唯一口径（毫秒时钟尾 9 位，大陆号段 19 前缀）。
 */
const PHONE_J6 = `19${String(Date.now()).slice(-9)}`;

/** /enrollments/mine 行（API 终态锚用最小面） */
interface MineRow {
  readonly enrollment_id: number;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly status: string;
  readonly amounts: { readonly paid: string; readonly cash: string; readonly points: number };
}

/** 通知偏好行（API 终态锚） */
interface PrefRow {
  readonly templateCode: string;
  readonly enabled: boolean;
}

test.describe.configure({ mode: 'default' }); // 文件内按声明序（workers=1，串行语义）

test('J1 登录：手机号→夹具验证码→验证→五 tab 壳可见', async ({ page }) => {
  const { code } = mintLogin(PHONE_J1, '246801');
  await loginViaUi(page, PHONE_J1, code);
  // loginViaUi 内已断言五 tab + phone_masked；此处补首页可达的用户可见态
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible();
});

test('J2 浏览：场次 tab→列表行→详情（推栈深度=1 防双 push）', async ({ page }) => {
  const { code } = mintLogin(PHONE_J1, '246812');
  await loginViaUi(page, PHONE_J1, code);

  await page.getByRole('tab', { name: '场次' }).click();
  await expect(page.getByLabel('场次列表')).toBeVisible();
  // 种子场次卡片（固定 slot_start 的报名中场次；卡片主体=外层 Pressable）
  const card = page.getByRole('button', { name: new RegExp(`场次 ${SEED_SLOT_TEXT} 报名中`) });
  await expect(card.first()).toBeVisible();

  // 路径①：点卡片主体 → 详情可见 → 返回一次即回列表（推栈深度=1）
  await card.first().click();
  await expect(page.getByLabel('场次详情')).toBeVisible();
  await expect(page.getByText(/拼团进度 · 已报 3\/5/)).toBeVisible(); // 种子场次指纹（joined 3/capacity 5）
  await expect(page.getByRole('button', { name: '立即报名' })).toBeVisible();
  await page.getByLabel('返回').click();
  await expect(page.getByLabel('场次列表')).toBeVisible();
  await expect(page.getByLabel('场次详情')).toHaveCount(0);

  // 路径②：内层「详情」按钮（T2 评审 S8 遗留观察点：卡片与内层按钮同绑 onPress，防双 push）
  await page.getByRole('button', { name: '详情', exact: true }).first().click();
  await expect(page.getByLabel('场次详情')).toBeVisible();
  await page.getByLabel('返回').click();
  await expect(page.getByLabel('场次列表')).toBeVisible();
  await expect(page.getByLabel('场次详情')).toHaveCount(0);
});

test('J3 报名支付成团：详情→报名→dev 模拟支付→待成团→我的报名 PAID 行', async ({ page }) => {
  const { code } = mintLogin(PHONE_J3, '135791', true); // 已实名（402 前置拦截面不走）
  await loginViaUi(page, PHONE_J3, code);

  await page.getByRole('tab', { name: '场次' }).click();
  await page
    .getByRole('button', { name: new RegExp(`场次 ${SEED_SLOT_TEXT} 报名中`) })
    .first()
    .click();
  await expect(page.getByLabel('场次详情')).toBeVisible();
  await page.getByRole('button', { name: '立即报名' }).click();
  await expect(page.getByLabel('报名支付页')).toBeVisible();
  await expect(page.getByText('报名确认')).toBeVisible();

  // dev 模拟支付：点支付即签名回调 → core relay 推进 PAID → 成团态轮询（10×700ms）
  await page.getByRole('button', { name: '确认报名并支付（dev 模拟）' }).click();
  await expect(page.getByText('报名成功 · 待成团')).toBeVisible({ timeout: GROUP_CONFIRM_TIMEOUT });
  await expect(page.getByText('已报 4/5')).toBeVisible(); // joined 3→4（待成团态如实断言）
  await expect(page.getByText('¥199.00').first()).toBeVisible(); // 实付（价格快照 ¥199.00）

  // 我的报名出现 PAID 行（用户可见态）
  await page.getByRole('button', { name: '查看我的报名（我的 tab）' }).click();
  await page.getByRole('button', { name: '我的报名' }).click();
  await expect(page.getByLabel('我的报名')).toBeVisible();
  await expect(page.getByText('已支付').first()).toBeVisible(); // PAID 徽标文案（trade-copy 单源）

  // API 终态双面锚：/enrollments/mine 含本场次 PAID 行（金额/积分数值核对）
  const token = await apiVerifyToken(PHONE_J3, mintLogin(PHONE_J3, '135792').code);
  const mine = await apiGet<MineRow[]>('/enrollments/mine', token);
  const row = mine.find((e) => e.ref_type === 'session' && e.ref_id === SEED_SESSION_ID);
  expect(row, `mine 应含场次 ${SEED_SESSION_ID} 的报名行`).toBeTruthy();
  expect(row!.status).toBe('PAID');
  expect(row!.amounts.paid).toBe('199.00');
  expect(row!.amounts.points).toBe(0);
});

test('J4 发起拼团：发团 tab→问题树作答→表单→发布→成功页（share_price 可见）', async ({ page }) => {
  test.skip(
    !PUBLISHER_PHONE || !SLOT_DATE || !SLOT_TIME,
    '编排器未注入发团坐标（E2E_PHONE_PUBLISHER/E2E_SLOT_*）',
  );
  const { code, user_id: publisherId } = mintLogin(PUBLISHER_PHONE, '246813', true);
  expect(publisherId).toBeGreaterThan(0);
  await loginViaUi(page, PUBLISHER_PHONE, code);

  // 问题树引导（E3）：根题干可见 → 多选一问
  await page.getByRole('tab', { name: '发团' }).click();
  await expect(page.getByLabel('发起拼团引导页')).toBeVisible();
  await expect(page.getByText('你的劳动争议属于哪一类？')).toBeVisible();
  await page.getByRole('checkbox', { name: '拖欠工资' }).click();
  await expect(page.getByText(/已选 1\s*项/)).toBeVisible();
  await page.getByRole('button', { name: '下一步 · 填写拼团信息' }).click();

  // 表单：律师（报名中场次执业律师）+ 时段（运行期唯一，避开 B2 锁）+ 人数缺省 2-4
  await expect(page.getByLabel('发起拼团表单页')).toBeVisible();
  await page
    .getByRole('checkbox', { name: /律师 #\d+ · 北京/ })
    .first()
    .click();
  await page.getByLabel('咨询日期输入框').fill(SLOT_DATE);
  await page.getByLabel('咨询时间输入框').fill(SLOT_TIME);
  await page.getByRole('button', { name: '发布拼团' }).click();

  // 成功页：拼团已发布 + share_price（¥300.00 = 600.00 ÷ 2 人）+ 标签随行
  await expect(page.getByLabel('发起拼团成功页')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('拼团已发布')).toBeVisible();
  await expect(page.getByText('¥300.00').first()).toBeVisible();
  await expect(page.getByText(/2-4 人（2 人成团）/)).toBeVisible();
  await expect(page.getByText(/拖欠工资/).first()).toBeVisible();
});

test('J5 我的拼团+消息中心：发起的团可见（PUBLISHED 窗口）+夹具通知+偏好「已保存」', async ({
  page,
}) => {
  test.skip(!PUBLISHER_PHONE, '编排器未注入发团用户（依赖 J4 发布）');
  const seeded = seedNotifications(PUBLISHER_PHONE); // 用户行已由 J4 mint --realname 备好
  expect(seeded.inserted).toBeGreaterThanOrEqual(0); // 幂等：首跑=2，重跑=0（均合法）

  const { code } = mintLogin(PUBLISHER_PHONE, '246814');
  await loginViaUi(page, PUBLISHER_PHONE, code);

  // 我的拼团：我发起的（公开列表 initiator 过滤，断言止于 PUBLISHED 窗口——T4 triage-3）
  await page.getByRole('tab', { name: '我的' }).click();
  await page.getByRole('button', { name: '我的拼团' }).click();
  await expect(page.getByLabel('我的拼团')).toBeVisible();
  await expect(page.getByText('拼团中').first()).toBeVisible(); // PUBLISHED 徽标文案
  await expect(page.getByText('/人 分摊').first()).toBeVisible();

  // 消息中心：夹具通知可见（报名链无通知生产方——T4 triage-4，夹具承载）
  await page.getByRole('tab', { name: '消息' }).click();
  await expect(page.getByLabel('消息中心')).toBeVisible();
  await expect(page.getByLabel('通知类型 场次提醒').first()).toBeVisible();
  await expect(page.getByText(/场次提醒：您报名的场次将于/).first()).toBeVisible();
  await expect(page.getByLabel('通知类型 价格下调 · 积分补偿').first()).toBeVisible();

  // 通知偏好：开关翻转 → 保存 → 「已保存」
  await page.getByRole('tab', { name: '我的' }).click();
  await page.getByRole('button', { name: '通知偏好' }).click();
  await expect(page.getByLabel('通知偏好')).toBeVisible();
  await page.getByLabel('通知类别 场次提醒').click(); // 翻转开关（默认投递 → 关闭）
  await page.getByRole('button', { name: '保存偏好' }).click();
  await expect(page.getByText('已保存')).toBeVisible();

  // API 终态双面锚：GET /notification-prefs 回读 SESSION_REMIND=false
  const token = await apiVerifyToken(PUBLISHER_PHONE, mintLogin(PUBLISHER_PHONE, '246815').code);
  const prefs = await apiGet<PrefRow[]>('/notification-prefs', token);
  const remind = prefs.find((p) => p.templateCode === 'SESSION_REMIND');
  expect(remind, '偏好面应含 SESSION_REMIND 行').toBeTruthy();
  expect(remind!.enabled).toBe(false);
});

test('J6 A2 训练授权独立页：报名成功页入口→独立页→授权→Me 页徽标变化', async ({ page }) => {
  const { code } = mintLogin(PHONE_J6, '246816', true);
  await loginViaUi(page, PHONE_J6, code);

  // 报名支付（J3 后 joined=4，本次 +1=5 → 满员成团；成团/待成团两态如实断言）
  await page.getByRole('tab', { name: '场次' }).click();
  await page
    .getByRole('button', { name: new RegExp(`场次 ${SEED_SLOT_TEXT} 报名中`) })
    .first()
    .click();
  await expect(page.getByLabel('场次详情')).toBeVisible();
  await page.getByRole('button', { name: '立即报名' }).click();
  await page.getByRole('button', { name: '确认报名并支付（dev 模拟）' }).click();
  await expect(page.getByText(/报名成功 · (已成团|待成团)/)).toBeVisible({
    timeout: GROUP_CONFIRM_TIMEOUT,
  });

  // 报名成功页入口 → A2 训练授权独立页（非捆绑勾选）
  await page.getByRole('button', { name: 'AI 训练数据授权（独立设置）' }).click();
  await expect(page.getByLabel('训练数据授权页')).toBeVisible();
  await expect(page.getByText('未授权')).toBeVisible(); // 独立页初始态（ABSENT）
  await expect(page.getByText(/目的限定/).first()).toBeVisible(); // 目的限定文案口径（架构 §5.2）

  // 勾选 + 提交授权 → GRANTED 态（撤回入口出现=授权成功的用户可见态）
  await page.getByRole('checkbox', { name: /我已阅读并理解上述目的限定/ }).click();
  await page.getByRole('button', { name: '提交授权' }).click();
  await expect(page.getByText('已授权').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '撤回授权' })).toBeVisible();

  // Me 页徽标变化：AI 训练数据授权入口徽标 未授权 → 已授权
  await page.getByRole('tab', { name: '我的' }).click();
  const consentEntry = page.getByRole('button', { name: 'AI 训练数据授权' });
  await expect(consentEntry).toBeVisible();
  await expect(consentEntry.getByText('已授权')).toBeVisible();

  // API 终态双面锚：GET /consents/training → GRANTED
  const token = await apiVerifyToken(PHONE_J6, mintLogin(PHONE_J6, '246817').code);
  const consent = await apiGet<{ status?: string }>('/consents/training', token);
  expect(consent.status).toBe('GRANTED');
});
