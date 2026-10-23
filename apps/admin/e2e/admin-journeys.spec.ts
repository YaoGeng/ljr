/**
 * admin E2E 六旅程（M3-W3 T7，J13~J18——05 §7.1 W3 验收判据载体）：
 * 登录门（J13）→ H1 审核真链（J14）→ H3 工单（J15）→ H5 风控（J16）→ H7 规则（J17）→
 * C6 改价审批端到端（J18：律师腿真链造 PENDING_APPROVAL → 审批台可见 → approve → EFFECTED）。
 *
 * 运行前提（编排器 run-admin-e2e.mjs 一条命令备齐）：本地 core（PG 5435）+ 夹具全套
 * （seed-admin-lawyer/seed-admin-risk/mint --admin/seed-room/C6 腿）+ `vite build`
 * （VITE_API_BASE 指向同源静态宿+core 反代）+ playwright chromium。
 *
 * 断言口径（对照 apps/app/e2e/journeys.spec.ts 先例）：用户可见态（文案/徽标/壳/hash URL）
 * 为主锚；关键位加 API 终态双面锚（夹具码换 token → GET 真实 core）；禁迁就实现——全部
 * 打真实 core HTTP，零 mock 中段。旅程有数据序（单 worker 串行；J18 依赖 C6 腿坐标）。
 */
import { test, expect } from '@playwright/test';
import {
  ADMIN_CODE,
  ADMIN_PHONE,
  API_BASE,
  APP_BASE,
  NO_ADMIN_PHONE,
  PRICING_HISTORY_ID,
  PRICING_LAWYER_ID,
  RISK_RECORD_IDS,
  RUN_ID,
  SUBMITTED_LAWYER_USER_ID,
  apiGet,
  apiVerifyToken,
  loginAdminViaUi,
  mintLogin,
  navigateTo,
} from './helpers';

/** 行定位单源：含「精确文本」元素的表格行（#/id/标题等短坐标用 exact 防子串误配） */
function rowOf(page: import('@playwright/test').Page, exactText: string) {
  return page.locator('tr').filter({ has: page.getByText(exactText, { exact: true }) });
}

/** 每旅程现登（W1-5 同口径）：mint 覆盖式取码（固定 222222）→ UI 登录 → 壳断言 */
async function adminLogin(page: import('@playwright/test').Page): Promise<void> {
  mintLogin(ADMIN_PHONE, ADMIN_CODE, ['--admin']);
  await loginAdminViaUi(page, ADMIN_PHONE, ADMIN_CODE);
}

// ---------------------------------------------------------------------------
// J13 登录门：未登录重定向 / 无 admin 角色显式拒绝 / 13700000001 登录进壳 + 指标条
// ---------------------------------------------------------------------------

test('J13 登录门：未登录 #/lawyers 弹回 #/login；无角色账号显式拒绝；admin 号进壳+指标条', async ({
  page,
}) => {
  // ① 未登录访问 #/lawyers → resolveRoute 收口回 #/login（不进壳）
  await page.goto(`${APP_BASE}/#/lawyers`);
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByLabel('手机号')).toBeVisible();
  await expect(page.getByRole('button', { name: '律师与资质' })).toHaveCount(0); // 壳未渲染

  // ② 无 admin 角色账号：verify 成功但 roles 不含 admin → 显式无权限态（不进壳、保留已输手机号）
  //   （--realname 预置用户行：/auth/verify 对新号要求 age_declared，后台账号=DB 预置口径同源）
  mintLogin(NO_ADMIN_PHONE, '444444', ['--realname']);
  await page.getByLabel('手机号').fill(NO_ADMIN_PHONE);
  await page.getByLabel('验证码').fill('444444');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('该账号无后台（admin）权限', { exact: false })).toBeVisible();
  await expect(page.getByLabel('手机号')).toHaveValue(NO_ADMIN_PHONE); // 可更换账号重输（不进壳）
  await expect(page.getByRole('button', { name: '退出' })).toHaveCount(0);

  // ③ admin 号（13700000001+222222）登录 → 进壳（sidebar 四组 + 顶栏尾号）+ 指标条数字卡
  mintLogin(ADMIN_PHONE, ADMIN_CODE, ['--admin']);
  await page.getByLabel('手机号').fill(ADMIN_PHONE);
  await page.getByLabel('验证码').fill(ADMIN_CODE);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出' })).toBeVisible();
  await expect(page.getByText('登录尾号 0001')).toBeVisible();
  await expect(page.getByRole('button', { name: '改价审批' })).toBeVisible();
  // 首页轻量指标条（GET /admin/dashboard/metrics group=core——目录卡渲染；value 无数据时为 '—'，
  // 断言锚=目录标题如实呈现，不假装数值）
  await expect(page.getByText('拼单成团率（B2C）', { exact: true })).toBeVisible();
  await expect(page.getByText('复购率', { exact: true })).toBeVisible();
});

// ---------------------------------------------------------------------------
// J14 H1 审核真链：SUBMITTED 可见 → claim（SUBMITTED→IN_REVIEW）→ approve（→PASSED）
// → 状态流转（筛选位移动）+ API 终态锚
// ---------------------------------------------------------------------------

test('J14 H1 审核真链：SUBMITTED 行可见 → 领取审核 → 审核通过 → 状态流转 PASSED', async ({
  page,
}) => {
  test.skip(SUBMITTED_LAWYER_USER_ID <= 0, '编排器未注入 SUBMITTED 律师坐标（seed-admin-lawyer）');
  await adminLogin(page);
  await navigateTo(page, '律师与资质');
  await expect(page.getByText('律师与资质审核', { exact: true })).toBeVisible();

  // 夹具行可见（缺省筛选=审核队列 SUBMITTED|IN_REVIEW；状态标签=映射表「待审核」）
  const row = rowOf(page, `用户 ${SUBMITTED_LAWYER_USER_ID}`);
  await expect(row).toBeVisible();
  await expect(row.getByText('待审核', { exact: true })).toBeVisible();

  // 审核动作一：领取审核（A3a 状态机 SUBMITTED→IN_REVIEW——approve 仅从 IN_REVIEW 合法）
  await row.getByRole('button', { name: '审核', exact: true }).click();
  const auditModal = page.getByRole('dialog', { name: /资质审核 档案 #/ });
  await expect(auditModal).toBeVisible();
  await auditModal.getByRole('radio', { name: /领取审核/ }).click();
  await auditModal.getByRole('button', { name: '领取审核', exact: true }).click();
  await expect(page.getByText('已执行「领取审核」')).toBeVisible();
  await expect(row.getByText('审核中', { exact: true })).toBeVisible(); // 刷新后列表对齐服务端

  // 审核动作二：审核通过（IN_REVIEW→PASSED；发 LawyerAuditPassed）
  await row.getByRole('button', { name: '审核', exact: true }).click();
  await expect(auditModal).toBeVisible();
  await auditModal.getByRole('radio', { name: /审核通过/ }).click();
  await auditModal.getByRole('button', { name: '审核通过', exact: true }).click();
  await expect(page.getByText('已执行「审核通过」')).toBeVisible();

  // 状态流转（列表刷新后）：该行移出「待审核」筛选、在「已通过」筛选下状态标签=已通过
  await page.getByRole('button', { name: '待审核', exact: true }).click();
  await expect(rowOf(page, `用户 ${SUBMITTED_LAWYER_USER_ID}`)).toHaveCount(0);
  await page.getByRole('button', { name: '已通过', exact: true }).click();
  const passedRow = rowOf(page, `用户 ${SUBMITTED_LAWYER_USER_ID}`);
  await expect(passedRow).toBeVisible();
  await expect(passedRow.getByText('已通过', { exact: true })).toBeVisible();

  // API 终态双面锚：GET /admin/lawyers?status=PASSED 含该档案且 audit_status=PASSED
  const token = await apiVerifyToken(ADMIN_PHONE, mintLogin(ADMIN_PHONE, '222541').code);
  const passed = await apiGet<{
    items: readonly { lawyer_user_id: number; audit_status: string }[];
  }>('/admin/lawyers?status=PASSED', token);
  const item = passed.items.find((i) => i.lawyer_user_id === SUBMITTED_LAWYER_USER_ID);
  expect(item, `PASSED 列表应含律师用户 ${SUBMITTED_LAWYER_USER_ID}`).toBeTruthy();
  expect(item!.audit_status).toBe('PASSED');
});

// ---------------------------------------------------------------------------
// J15 H3 工单：人工建单（幂等键=category+ref）→ 列表可见 → 详情抽屉 → resolve approved
// → RESOLVED
// ---------------------------------------------------------------------------

test('J15 H3 工单：人工建单 → 列表/详情抽屉 → 同意办结 → RESOLVED', async ({ page }) => {
  await adminLogin(page);
  await navigateTo(page, '纠纷工单');
  await expect(page.getByText('纠纷工单', { exact: true })).toBeVisible();

  // 人工建单（必填：类目/标题/正文；ref 逐跑唯一=幂等键避让，重放不误读旧单）
  const title = `E2E-J15-纠纷申诉-${RUN_ID}`;
  const refId = Date.now() % 1_000_000_000;
  await page.getByRole('button', { name: '人工建单' }).click();
  const createModal = page.getByRole('dialog', { name: '人工建单' });
  await createModal.getByLabel(/标题（必填/).fill(title);
  await createModal
    .getByLabel(/工单正文（必填/)
    .fill('M3-W3 J15 E2E：人工建单旅程正文（虚构样例，无 PII）。');
  await createModal.getByLabel(/关联类型 ref_type/).fill('session');
  await createModal.getByLabel(/关联 ID ref_id/).fill(String(refId));
  await createModal.getByRole('button', { name: '创建工单（OPEN）' }).click();
  const createdBanner = page.getByRole('status').filter({ hasText: /工单 #\d+ 已创建/ });
  await expect(createdBanner).toBeVisible();
  const bannerText = await createdBanner.innerText();
  const ticketId = Number(/工单 #(\d+) 已创建/.exec(bannerText)?.[1] ?? 0);
  expect(ticketId, `建单横幅应含工单号（实得：${bannerText.slice(0, 80)}）`).toBeGreaterThan(0);

  // 列表可见新单（OPEN=待处理）
  const row = rowOf(page, title);
  await expect(row).toBeVisible();
  await expect(row.getByText('待处理', { exact: true })).toBeVisible();

  // 详情抽屉（GET /admin/tickets/:id：正文 + 处置审计空态如实）
  await row.click();
  const drawer = page.getByRole('dialog', { name: `工单详情 #${ticketId}` });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('处置审计（ticket_actions）')).toBeVisible();
  await expect(drawer.getByText('暂无处置记录', { exact: false })).toBeVisible();

  // resolve approved（drawer 内「处置该工单」→ 处置弹层：同意办结不带回调 → RESOLVED）
  await drawer.getByRole('button', { name: '处置该工单' }).click();
  const resolveModal = page.getByRole('dialog', { name: `工单处置 #${ticketId}` });
  await expect(resolveModal).toBeVisible();
  await expect(resolveModal.getByRole('radio', { name: /同意办结/ })).toBeChecked();
  await resolveModal.getByRole('button', { name: '同意办结', exact: true }).click();
  // 横幅文案=TicketsPage 实码（statusLabel 映射表 RESOLVED=「已办结」自带前缀——T8 已删
  // 页面侧叠写「已」，现无叠字；断言与页面文案联动）
  await expect(page.getByText(`工单 #${ticketId} 已办结（终态不可再处置）`)).toBeVisible();
  await expect(row.getByText('已办结', { exact: true })).toBeVisible(); // 终态徽标（列表对齐）
  await expect(row.getByRole('button', { name: '处置', exact: true })).toHaveCount(0); // 终态无处置入口

  // API 终态双面锚：GET /admin/tickets?status=RESOLVED 按 ref 幂等键定位该单
  const token = await apiVerifyToken(ADMIN_PHONE, mintLogin(ADMIN_PHONE, '222542').code);
  const resolved = await apiGet<{
    items: readonly { id: number; ref_id: number | null; status: string }[];
  }>('/admin/tickets?category=dispute&status=RESOLVED&limit=100', token);
  const t = resolved.items.find((i) => i.ref_id === refId);
  expect(t, `RESOLVED 列表应含 ref_id=${refId} 的单`).toBeTruthy();
  expect(t!.status).toBe('RESOLVED');
});

// ---------------------------------------------------------------------------
// J16 H5 风控：词库提交新版本（版本+1）+ 人审队列夹具记录可见 → CONFIRM_BLOCK 处置 → 跌出
// ---------------------------------------------------------------------------

test('J16 H5 风控：词库加词提交 v+1 → 人审 CONFIRM_BLOCK 处置 → 行跌出队列', async ({ page }) => {
  test.skip(RISK_RECORD_IDS.length === 0, '编排器未注入风控记录坐标（seed-admin-risk）');
  await adminLogin(page);
  await navigateTo(page, '风控与敏感词');
  await expect(page.getByText('风控与敏感词', { exact: true })).toBeVisible();

  // 词库段：选「行业话术」库 → 记当前生效版本 → 编辑加一词（逐跑唯一词，词集必变=必新版本）
  await page.getByRole('button', { name: /行业违规话术（legal_industry）/ }).click();
  const dictCard = page.locator('.glass-card').filter({ hasText: 'wordlist.legal_industry' });
  await expect(dictCard).toBeVisible();
  const beforeText = await dictCard.getByText(/当前生效 v\d+/).innerText();
  const beforeVersion = Number(/v(\d+)/.exec(beforeText)?.[1] ?? -1);
  expect(beforeVersion).toBeGreaterThanOrEqual(0);
  await dictCard.getByRole('button', { name: '编辑词库' }).click();
  const word = `e2ej16${RUN_ID}`;
  await page.getByLabel('新增词条').fill(word);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByText('新增 1', { exact: true })).toBeVisible(); // 版本 diff 面板
  await page.getByRole('button', { name: new RegExp(`^提交 v${beforeVersion + 1}`) }).click();
  await expect(
    page.getByText(`词库已提交：wordlist.legal_industry v${beforeVersion + 1}`),
  ).toBeVisible(); // created 提示（逐跑新词=非幂等重放）
  await expect(
    dictCard.getByText(`当前生效 v${beforeVersion + 1}`, { exact: false }),
  ).toBeVisible();

  // 人审段：夹具记录可见（word_hits 命中词入列）→ verdict=CONFIRM_BLOCK（危险值二段确认）
  const recordId = RISK_RECORD_IDS[0]!;
  const row = rowOf(page, `#${recordId}`);
  await expect(row).toBeVisible();
  await expect(row.getByText('转人审', { exact: true })).toBeVisible(); // 机审处置级（W1 只落 REVIEW 行）
  await row.getByRole('button', { name: '处置', exact: true }).click();
  const reviewModal = page.getByRole('dialog', { name: `人审处置 #${recordId}` });
  await expect(reviewModal).toBeVisible();
  await reviewModal.getByRole('radio', { name: /确认拦截/ }).click();
  await reviewModal.getByRole('button', { name: '提交处置（确认拦截）' }).click(); // 一段：进入 armed
  await reviewModal.getByRole('button', { name: /再次点击提交/ }).click(); // 二段：确认提交
  await expect(page.getByText(`记录 #${recordId} 已处置（确认拦截`)).toBeVisible();

  // 处置后行跌出队列（reviewed_at 回填 → 列表刷新不再返回）
  await expect(rowOf(page, `#${recordId}`)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// J17 H7 规则：创建草案（合法 key+逐跑唯一 version+合法 JSON）→ 列表 DRAFT → publish
// 二段确认 → PUBLISHED
// ---------------------------------------------------------------------------

test('J17 H7 规则：创建草案 DRAFT 可见 → 提交公示二段确认 → PUBLISHED', async ({ page }) => {
  await adminLogin(page);
  await navigateTo(page, '规则中心');
  await expect(page.getByText('规则中心', { exact: true })).toBeVisible();

  // 创建草案（key 合法词法非 wordlist.*；version 逐跑唯一=幂等键避让，重放不误读旧行；
  // content=合法 JSON 对象——parseCreateRuleBody 同规则）
  const ruleKey = 'e2e_w3_rule';
  const version = Math.floor(Date.now() / 1000);
  await page.getByRole('button', { name: '创建草案' }).click();
  const createModal = page.getByRole('dialog', { name: '创建规则草案' });
  await createModal.getByLabel(/规则 key（必填/).fill(ruleKey);
  await createModal.getByLabel(/版本 version（必填/).fill(String(version));
  await createModal
    .getByLabel(/内容 content（必填/)
    .fill('{"purpose":"m3-w3-j17-e2e","note":"fixture-draft"}');
  await createModal.getByRole('button', { name: '创建草案（DRAFT）' }).click();
  await expect(page.getByText(`草案已创建：${ruleKey} v${version}（DRAFT）`)).toBeVisible();

  // 列表 DRAFT 可见（状态标签=映射表「草案」）
  const row = page
    .locator('tr')
    .filter({ hasText: ruleKey })
    .filter({ hasText: `v${version}` });
  await expect(row).toBeVisible();
  await expect(row.getByText('草案', { exact: true })).toBeVisible();

  // 提交公示（影响全平台规则的危险动作——二段确认门）
  await row.getByRole('button', { name: '提交公示', exact: true }).click();
  const publishModal = page.getByRole('dialog', { name: `提交公示 ${ruleKey} v${version}` });
  await expect(publishModal.getByText('影响全平台规则的危险动作。')).toBeVisible();
  await publishModal.getByRole('button', { name: '提交公示', exact: true }).click(); // 一段：armed
  await expect(publishModal.getByRole('button', { name: /再次点击提交/ })).toBeVisible();
  await publishModal.getByRole('button', { name: /再次点击提交/ }).click(); // 二段：提交
  await expect(page.getByText(`已提交公示：${ruleKey} v${version}`)).toBeVisible();
  await expect(row.getByText('公示中', { exact: true })).toBeVisible(); // PUBLISHED 状态断言

  // API 终态双面锚：GET /admin/rules?rule_key= 该版本 publishStatus=PUBLISHED
  const token = await apiVerifyToken(ADMIN_PHONE, mintLogin(ADMIN_PHONE, '222547').code);
  const rules = await apiGet<
    readonly {
      ruleKey: string;
      version: number;
      publishStatus: string;
      publishedAt: string | null;
    }[]
  >(`/admin/rules?rule_key=${ruleKey}`, token);
  const r = rules.find((x) => x.version === version);
  expect(r, `规则 ${ruleKey} v${version} 应在册`).toBeTruthy();
  expect(r!.publishStatus).toBe('PUBLISHED');
  expect(r!.publishedAt).not.toBeNull();
});

// ---------------------------------------------------------------------------
// J18 C6 改价审批端到端（验收判据）：C6 腿 PENDING_APPROVAL → 审批台可见 → approve true
// → EFFECTED（页面终态 + API histories 复核）
// ---------------------------------------------------------------------------

test('J18 C6 改价审批端到端：PENDING 焦点卡可见 → 通过 → EFFECTED', async ({ page }) => {
  test.skip(
    PRICING_HISTORY_ID <= 0 || PRICING_LAWYER_ID <= 0,
    '编排器未注入 C6 坐标（c6-pricing-leg 律师腿真链产物）',
  );
  await adminLogin(page);
  await navigateTo(page, '改价审批');
  await expect(page.getByText('改价审批台', { exact: true })).toBeVisible();

  // lawyer_id 直达查询（W3-4：lawyer_id 必填如实承载——无跨律师待审批列表面）
  await page.getByLabel(/律师 id（必填/).fill(String(PRICING_LAWYER_ID));
  await page.getByRole('button', { name: '查询记录' }).click();

  // PENDING_APPROVAL 焦点卡可见（置顶；C6 腿坐标命中——卡内坐标文案「#id · 发起 …」为子串定位）
  const card = page.locator('.glass-card').filter({
    hasText: `#${PRICING_HISTORY_ID} · 发起`,
  });
  await expect(card).toBeVisible();
  await expect(card.getByText('待审批', { exact: true })).toBeVisible();

  // approve true（approval_id 必填正整数=处置凭据 id；页面防呆接受任意正整数——①期人工兜底，
  // H3 工单 id ②期接入）
  await page.locator(`#approval-id-${PRICING_HISTORY_ID}`).fill('1001');
  await card.getByRole('button', { name: '通过（EFFECTED）' }).click();
  await expect(page.getByText(`审批通过：改价 #${PRICING_HISTORY_ID} 已生效`)).toBeVisible();

  // 行流转：焦点卡消失（PENDING 空集提示）→ 已决表该行=已生效（EFFECTED）
  await expect(page.getByText('当前律师无待审批行', { exact: false })).toBeVisible();
  const decidedRow = rowOf(page, `#${PRICING_HISTORY_ID}`);
  await expect(decidedRow).toBeVisible();
  await expect(decidedRow.getByText('已生效', { exact: true })).toBeVisible();

  // API 终态双面锚：GET /pricing/histories 复核 DB 侧 result=EFFECTED + 审批归源 MANUAL
  const histories = await fetch(
    `${API_BASE}/pricing/histories?lawyer_id=${PRICING_LAWYER_ID}`,
  ).then((res) => {
    if (!res.ok) throw new Error(`GET /pricing/histories ${res.status}`);
    return res.json() as Promise<
      readonly { history_id: number; result: string; approval_source: string | null }[]
    >;
  });
  const h = histories.find((x) => x.history_id === PRICING_HISTORY_ID);
  expect(h, `改价历史 ${PRICING_HISTORY_ID} 应在册`).toBeTruthy();
  expect(h!.result).toBe('EFFECTED');
  expect(h!.approval_source).toBe('MANUAL');
});
