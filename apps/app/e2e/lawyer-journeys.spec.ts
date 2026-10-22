/**
 * 律师端旅程 E2E（M3-W2 T7；判据=脚本+运行输出留档）：六条旅程覆盖律师登录切角色
 * →工作台统计+时间表读写→开团（B2 锁随机 slot）→接单大厅 C2B confirm→场次看板聚合
 * →草稿气泡端到端（用户 WSS 提问→管线出稿→律师审查动作→会话消息真链）。
 *
 * 运行前提同 journeys.spec.ts（编排器一条命令备齐）；增量坐标（律师/用户号、seed-room
 * session/room/conversation、seed-groupbuy 团号、ws 直连地址、J9 随机 slot）经编排器
 * env 注入（E2E_LAWYER_* / E2E_ROOM_* / E2E_CORE_WS_URL 等）。
 *
 * 断言口径（W1 同款）：用户可见态（文案/徽标/tab 壳/横幅）为主锚+API 终态双面锚
 * （GET 经同源反代 → 真实 core；ws 用户腿=Node ws 直连 core /ws 真链，禁 mock 中段——
 * W2-3/W2-6）。J12 出稿等待=UI 20s 轮询承载（DRAFT_POLL_INTERVAL_MS）+waitFor 30s
 * 超时（relay 1s+管线 ~百 ms+轮询节拍 20s+余量）。
 * 旅程数据序（单 worker 串行）：J9 开团后场次管理列表可见（列表累计跨跑幂等——断言仅
 * 「本场可见」）；J10 消费 seed-groupbuy 待确认团（夹具重播复位规范态）。
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  CONVERSATION_ID,
  LAWYER_PHONE,
  LAWYER_SLOT_DATE,
  LAWYER_SLOT_TIME,
  LAWYER_USER_ID,
  MEMBER_PHONE,
  PENDING_GB_SLOT_ISO,
  PENDING_GB_SLOT_TEXT,
  ROOM_ID,
  ROOM_SESSION_ID,
  ROOM_SLOT_TEXT,
  apiGet,
  apiVerifyToken,
  loginLawyerViaUi,
  mintLogin,
  runWsUserLeg,
  shanghaiSlotText,
} from './helpers';

/** 出稿等待容忍窗：core relay 1s 轮询+管线（~百 ms 量级）+UI 20s interval 重拉+余量 */
const DRAFT_APPEAR_TIMEOUT = 30_000;

/** 律师 token（API 终态锚用——mint 覆盖式取码现换） */
async function lawyerApiToken(code: string): Promise<string> {
  return apiVerifyToken(LAWYER_PHONE, mintLogin(LAWYER_PHONE, code).code);
}

/** /sessions 行（API 锚最小面；joined/capacity=J10 满员成团断言面——core toView 实文） */
interface SessionRow {
  readonly id: number;
  readonly mode: string;
  readonly slot_start: string;
  readonly status: string;
  readonly joined: number;
  readonly capacity: number;
}

/** /conversations/:id/messages 行（J12「律师发送」真链断言面） */
interface ConvMessageRow {
  readonly message_id: number;
  readonly seq: number;
  readonly sender_role: string;
  readonly content: string;
}

/** seed-room 场次看板直达（J11/J12 共用入口）：场次管理 → 按 ID 直达看板 */
async function openBoardDirect(page: Page): Promise<void> {
  await page.getByRole('tab', { name: '场次管理' }).click();
  await expect(page.getByLabel('场次管理')).toBeVisible();
  await page.getByLabel('场次号输入').fill(String(ROOM_SESSION_ID));
  await page.getByRole('button', { name: '直达看板' }).click();
  await expect(page.getByLabel(`场次看板 ${ROOM_SESSION_ID}`)).toBeVisible();
}

test.describe.configure({ mode: 'default' }); // 文件内按声明序（workers=1，串行语义）

test('J7 律师登录+切换角色：双角色账号登录→Me 切换为律师→律师四 tab 壳', async ({ page }) => {
  await loginLawyerViaUi(page, '246820'); // helper 内已断言：登录五 tab 壳→切换→律师四 tab 壳
  //（切换成功后导航回角色根=工作台——router.applyRole 收口；Me 页角色面须先切 tab 再断言）

  // Me 页角色面：当前端别=律师端 + 回切入口恒在（lawyer 账号默认具备 user 身份）
  await page.getByRole('tab', { name: '我的' }).click();
  await expect(page.getByText('当前 · 律师端')).toBeVisible();
  await expect(page.getByRole('button', { name: '切换为用户' })).toBeVisible();

  // API 锚：/me roles 含 lawyer（switch 前置=夹具律师行；登录本身返回 roles 双角色）
  const token = await lawyerApiToken('246820');
  const me = await apiGet<{ roles?: string[] }>('/me', token);
  expect(me.roles, '/me roles 应含 user+lawyer（双角色同账号 A1 R-02）').toEqual(
    expect.arrayContaining(['user', 'lawyer']),
  );
});

test('J8 工作台+时间表：四率统计面可见（空数据如实）→时间表模板改一处→保存→回显', async ({
  page,
}) => {
  await loginLawyerViaUi(page, '246821');

  // 工作台：标识行 + AI 辅助正常条 + 四率焦点卡（空数据态如实断言：本周窗无场次 → 缺数据）
  await expect(page.getByLabel('律师工作台')).toBeVisible();
  await expect(page.getByText('AI 辅助正常')).toBeVisible();
  await expect(page.getByText('本周场次四率')).toBeVisible();
  for (const label of ['报名率', '成团率', '到场率', '1对1转化']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('「—」=窗口内暂无数据（缺数据语义，非 0%）')).toBeVisible();
  await expect(page.getByText('0 次判定样本')).toBeVisible(); // 出席聚合空窗（判定样本恒 0）

  // 时间表：主按钮入页（B1 读面）
  await page.getByRole('button', { name: '发起开团 · 从时间表选时段' }).click();
  await expect(page.getByLabel('时间表管理')).toBeVisible();
  await expect(page.getByText('可约时段模板', { exact: true })).toBeVisible();

  // 改一处模板：有行=翻转启停；无行=新增一段（两轮跑/夹具幂等下两分支均合法——写入即回显）。
  // 先等 B1 读面就绪（空表提示或首行任一可见——加载态行数为 0 不可作分支依据）
  await expect(
    page
      .getByText('尚未配置可约时段——用下方表单添加第一段')
      .or(page.getByLabel(/，点按(停用|启用)$/))
      .first(),
  ).toBeVisible({ timeout: 10_000 });
  const enabledToggle = page.getByLabel('已启用，点按停用');
  const disabledToggle = page.getByLabel('已停用，点按启用');
  const hasRows = (await enabledToggle.count()) + (await disabledToggle.count()) > 0;
  if (hasRows) {
    const wasEnabled = (await enabledToggle.count()) > 0;
    await (wasEnabled ? enabledToggle : disabledToggle).first().click();
    await page.getByRole('button', { name: '保存全部' }).click();
    await expect(page.getByText(/^已保存 · 版本 \d+$/)).toBeVisible();
    // 回显：该行翻转到对侧态
    await expect((wasEnabled ? disabledToggle : enabledToggle).first()).toBeVisible();
  } else {
    await page.getByLabel('新增开始时刻').fill('19:00');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.getByLabel('星期 周一，点按轮换').first()).toBeVisible();
    await page.getByRole('button', { name: '保存全部' }).click();
    await expect(page.getByText(/^已保存 · 版本 \d+$/)).toBeVisible();
    await expect(page.getByLabel('开始时刻').first()).toHaveValue('19:00'); // 回显
  }
});

test('J9 开团：随机未来 slot 表单→提交→成功跳场次详情→场次管理列表可见该场', async ({ page }) => {
  test.skip(!LAWYER_SLOT_DATE || !LAWYER_SLOT_TIME, '编排器未注入开团坐标（E2E_LAWYER_SLOT_*）');
  await loginLawyerViaUi(page, '246822');

  // 工作台快捷入口 → 开团配置（QuickEntry 可达名=主标签「开团」（note 不并入 name——
  // 与主按钮「发起开团 · 从时间表选时段」以 exact 区分）；B3 默认价预填——等预填落地再填）
  await page.getByRole('button', { name: '开团', exact: true }).click();
  await expect(page.getByLabel('开团配置')).toBeVisible();
  const priceField = page.getByLabel(/^(本次人头价|本次场次总价)$/);
  await expect(priceField).not.toHaveValue(''); // B3 默认价预填完成（模式随现值二选一）

  await page.getByLabel('开始日期输入框').fill(LAWYER_SLOT_DATE);
  await page.getByLabel('开始时刻输入框').fill(LAWYER_SLOT_TIME);
  await page.getByLabel('开团人数输入框').fill('4');
  await page.getByRole('button', { name: '创建场次 · 锁定时间段' }).click();

  // 成功=push 场次详情（W1 详情页复用）：开场文案 + 报名中态 CTA
  const slotIso = `${LAWYER_SLOT_DATE}T${LAWYER_SLOT_TIME}:00+08:00`;
  const slotText = shanghaiSlotText(slotIso);
  await expect(page.getByLabel('场次详情')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${slotText} 开场`)).toBeVisible();
  await expect(page.getByRole('button', { name: '立即报名' })).toBeVisible();

  // 场次管理（tab 直切——开团表单 pop 拦截不拦 tab 切换）：CREATED 公开列表可见本场
  await page.getByRole('tab', { name: '场次管理' }).click();
  await expect(page.getByRole('button', { name: `场次 ${slotText} 报名中，打开看板` })).toBeVisible(
    { timeout: 10_000 },
  );

  // API 终态双面锚：公开列表含本场（slot 归一 UTC ISO 比对；mode=B2C/status=CREATED）
  const token = await lawyerApiToken('246823');
  const rows = await apiGet<SessionRow[]>(`/sessions?lawyer=${LAWYER_USER_ID}`, token);
  const expectedUtc = new Date(Date.parse(slotIso)).toISOString();
  const row = rows.find((s) => s.slot_start === expectedUtc);
  expect(row, `律师 ${LAWYER_USER_ID} 公开列表应含 slot=${expectedUtc} 场次`).toBeTruthy();
  expect(row!.mode).toBe('B2C');
  expect(row!.status).toBe('CREATED');
});

test('J10 接单大厅 C2B 响应：seed 待确认团→确认接单→卡片离列+结果横幅+履约场次真链', async ({
  page,
}) => {
  await loginLawyerViaUi(page, '246824');

  // 待响应面（GET /lawyer/group-buys?status=PENDING_LAWYER）：seed-groupbuy 指定我的团
  await page.getByRole('tab', { name: '接单大厅' }).click();
  await expect(page.getByLabel('接单大厅')).toBeVisible();
  const pendingHeadline = page.getByText(`${PENDING_GB_SLOT_TEXT} 开场`);
  await expect(pendingHeadline).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('C2B 指定你接单')).toBeVisible();
  await expect(page.getByText('已加入 2 人（成团线 2）')).toBeVisible(); // 参与者契约下界 2

  // 确认接单（幂等键=gb）→ 结果横幅 + 待响应卡片离列（列表刷新对齐 CONFIRMED 态）。
  // 场次号在横幅存活期内先取（推开团详情页后大厅卸载、横幅随之销毁——首跑实证）
  await page.getByRole('button', { name: '确认接单' }).click();
  const banner = page.getByText(/已接单 · 履约场次 #\d+ 已生成，时间段已锁定/);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  const sessionId = Number((await banner.textContent())?.match(/#(\d+)/)?.[1] ?? 0);
  expect(sessionId).toBeGreaterThan(0);
  await expect(pendingHeadline).toHaveCount(0); // 卡片离列
  await expect(page.getByText('暂无待响应的拼团——用户发起的拼团成团后将出现在这里')).toBeVisible();

  // 横幅直达履约场次（详情任意态可达）
  await page.getByRole('button', { name: '查看履约场次' }).click();
  await expect(page.getByLabel('场次详情')).toBeVisible();
  await expect(page.getByText(`${PENDING_GB_SLOT_TEXT} 开场`)).toBeVisible();

  // API 终态双面锚：confirm 建面 session（mode=C2B 满员闭环，slot=团 slot）
  const token = await lawyerApiToken('246825');
  const detail = await apiGet<SessionRow>(`/sessions/${sessionId}`, token);
  expect(detail.mode).toBe('C2B');
  expect(detail.slot_start).toBe(new Date(Date.parse(PENDING_GB_SLOT_ISO)).toISOString());
  // confirm 链=建场（CREATED）→markFull（joined==capacity 满员即成团）→终态 FULL
  expect(detail.status).toBe('FULL');
  expect(detail.joined).toBe(detail.capacity);
});

test('J11 场次看板：seed-room 场次按 ID 直达→详情头+出席段（room）+消息段（conversation）', async ({
  page,
}) => {
  await loginLawyerViaUi(page, '246826');
  await openBoardDirect(page);

  // 详情头（GET /sessions/:id 任意态）：场次号 + OPEN 徽标 + 固定 slot 开场文案
  await expect(page.getByText(`场次 #${ROOM_SESSION_ID}`, { exact: true })).toBeVisible();
  await expect(page.getByText('已开房 · 待开场')).toBeVisible();
  await expect(page.getByText(`${ROOM_SLOT_TEXT} 开场`)).toBeVisible();

  // 房间段：房间号直达 → 出席/须知聚合渲染（出席判定面可见=聚合调用成功——404/403 走空态替代）
  await page.getByLabel('房间号输入').fill(String(ROOM_ID));
  await page.getByRole('button', { name: '聚合出席/须知' }).click();
  await expect(page.getByText(`出席判定（房间 #${ROOM_ID}）`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/判定口径：宽限 5 分钟内进入=正常/)).toBeVisible();

  // 消息段：会话号直达 → 只读消息渲染（seed/T6 留存量 >0；<50 条 → 「已到最新」收尾）
  await page.getByLabel('会话号输入').fill(String(CONVERSATION_ID));
  await page.getByRole('button', { name: '拉取消息' }).click();
  await expect(page.getByText(/#\d+ · (用户|律师|系统) · /).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/已到最新消息（序号 #\d+ 止）/)).toBeVisible();
});

test('J12 草稿气泡端到端：用户提问（ws 真链）→气泡可见→律师编辑发送→会话含律师消息→丢弃留痕', async ({
  page,
}) => {
  test.setTimeout(150_000); // 两段出稿等待（各 ≤30s）+登录/动作/API 锚余量
  test.skip(!CONVERSATION_ID || !ROOM_ID, '编排器未注入气泡链坐标（E2E_ROOM_*）');

  // ① 用户腿（真 WSS 直连 core /ws——禁 mock 中段）：member token → auth→join→send
  const memberMint = mintLogin(MEMBER_PHONE, '246827');
  const memberToken = await apiVerifyToken(MEMBER_PHONE, memberMint.code);
  const marker1 = `E2E${String(Date.now()).slice(-6)}`;
  const marker2 = `E2E${String(Date.now()).slice(-5)}X`;
  const leg1 = runWsUserLeg(
    memberToken,
    `公司拖欠三个月工资，经济补偿金应该按什么标准计算？（标记 ${marker1}）`,
    randomUUID(),
  );
  expect(leg1.seq, '用户提问应落库回 seq（ws sent ack）').toBeGreaterThan(0);
  expect(leg1.deduplicated).toBe(false);
  expect(leg1.role).toBe('user');

  // ② 律师 UI：看板 →（房间号聚合后）AI 草稿审查入口携带 room_id → 气泡页
  await loginLawyerViaUi(page, '246828');
  await openBoardDirect(page);
  await page.getByLabel('房间号输入').fill(String(ROOM_ID));
  await page.getByRole('button', { name: '聚合出席/须知' }).click();
  await expect(page.getByText(`出席判定（房间 #${ROOM_ID}）`)).toBeVisible();
  await page.getByRole('button', { name: 'AI 草稿审查' }).click();
  await expect(page.getByLabel('AI 草稿审查')).toBeVisible();
  await expect(page.getByText('草稿气泡 · 仅你可见')).toBeVisible();
  await expect(page.getByText(`当前=房间 #${ROOM_ID} 的草稿`)).toBeVisible(); // 房间过滤带入

  // 新草稿出现（管线真出稿：relay 1s+管线+UI 20s 轮询——waitFor 超时按周期+余量）
  const card1 = pendingCard(page, marker1);
  await expect(card1).toBeVisible({ timeout: DRAFT_APPEAR_TIMEOUT });
  await expect(card1.getByText('【AI 辅助，仅供参考】')).toBeVisible(); // R-04 标记原样在场

  // ③ 律师动作 edit_send：改一版文本（保留 R-04 标记）→ EDITED_SENT 态
  const edit1 = `【AI 辅助，仅供参考】修改稿（${marker1}）：请先固定劳动合同与工资流水证据，再按工作年限主张经济补偿。`;
  await card1.getByRole('button', { name: '修改后发送' }).click();
  await card1.getByLabel('修改草稿正文').fill(edit1);
  await card1.getByRole('button', { name: '发送修改稿' }).click();
  await expect(page.getByText(/修改后发送（EDITED_SENT）/)).toBeVisible({ timeout: 10_000 });
  await expect(statusCard(page, '修改后发送', marker1)).toBeVisible({ timeout: 10_000 });

  // ④ 「律师发送」真链断言：HTTP 会话消息含该条（content=编辑稿全文，含 R-04 标记）
  const lawyerToken = await lawyerApiToken('246829');
  const messages = await apiGet<ConvMessageRow[]>(
    `/conversations/${CONVERSATION_ID}/messages`,
    lawyerToken,
  );
  const sent = messages.find(
    (m) => m.sender_role === 'lawyer' && m.content.includes(`修改稿（${marker1}）`),
  );
  expect(sent, `会话 ${CONVERSATION_ID} 应含律师消息（标记 ${marker1}）`).toBeTruthy();
  expect(sent!.content).toBe(edit1);
  expect(sent!.seq).toBeGreaterThan(leg1.seq!);

  // ⑤ discard 腿：ws 再发一问 → 新草稿 → 丢弃 → DISCARDED 留痕态
  const leg2 = runWsUserLeg(
    memberToken,
    `仲裁申请需要准备哪些材料？（标记 ${marker2}）`,
    randomUUID(),
  );
  expect(leg2.seq!).toBeGreaterThan(leg1.seq!);
  const card2 = pendingCard(page, marker2);
  await expect(card2).toBeVisible({ timeout: DRAFT_APPEAR_TIMEOUT });
  await card2.getByRole('button', { name: '丢弃' }).click();
  await expect(page.getByText(/草稿已丢弃（DISCARDED）/)).toBeVisible({ timeout: 10_000 });
  await expect(statusCard(page, '已丢弃', marker2)).toBeVisible({ timeout: 10_000 });
});

/** PENDING 草稿卡定位（a11y 标签=草稿卡 {id} 待审查；hasText 过滤问题摘要标记） */
function pendingCard(page: Page, marker: string): Locator {
  return page.getByLabel(/^草稿卡 \d+ 待审查$/).filter({ hasText: marker });
}

/** 指定终态草稿卡定位（五态文案经 agentDraftStatusCopy 单源——状态徽标词入 a11y 标签） */
function statusCard(page: Page, statusCopy: string, marker: string): Locator {
  return page.getByLabel(new RegExp(`^草稿卡 \\d+ ${statusCopy}$`)).filter({ hasText: marker });
}
