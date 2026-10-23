/**
 * admin E2E 旅程共用件（M3-W3 T7）：夹具调用（apps/app 夹具单源只读复用）+ UI 登录 +
 * API 锚点。断言口径对照 apps/app/e2e/helpers.ts 先例：用户可见态为主锚 + 关键位 API 终态
 * 双面锚（fetch 经同源反代 → 真实 core）；禁纯实现细节断言、禁 mock 中段。
 *
 * 纪律：
 * - 夹具是唯一造数面（mint-login/seed-admin-* 复用 apps/app/e2e/fixtures 实物 CLI，零复制公式；
 *   admin/e2e 自有夹具仅 c6-pricing-leg——编排器起服后调用，spec 不直接跑）；
 * - Playwright 转译器按 CJS 装载本文件（import.meta 不可用，app helpers 同款注记）——
 *   夹具目录以 cwd 候选探测（编排器在 apps/admin 下拉起 playwright）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { expect, type Page } from '@playwright/test';

/** app 夹具目录定位（mint-login.mjs 为标记件） */
const APP_FIXTURES = [
  path.resolve(process.cwd(), '..', 'app', 'e2e', 'fixtures'), // cwd=apps/admin（编排器口径）
  path.resolve(process.cwd(), 'apps', 'app', 'e2e', 'fixtures'), // cwd=仓库根兜底
].find((d) => existsSync(path.join(d, 'mint-login.mjs')));
if (!APP_FIXTURES)
  throw new Error('apps/app/e2e/fixtures 定位失败（期望在 apps/admin 或仓库根下运行）');

/** 编排器注入的坐标（run-admin-e2e.mjs 生成；缺省回落独立起服口径） */
export const APP_BASE = process.env.E2E_APP_BASE ?? 'http://127.0.0.1:8795';
export const API_BASE = process.env.E2E_API_BASE ?? APP_BASE;

/** E2E admin 号（mint-login --admin 幂等坐标；编排器已种，spec 侧重插=覆盖式幂等同码） */
export const ADMIN_PHONE = process.env.E2E_ADMIN_PHONE ?? '13700000001';
export const ADMIN_CODE = process.env.E2E_ADMIN_CODE ?? '222222';
/** J13 无角色拒绝腿账号（verify 自然建 user 角色账号——roles 不含 admin 即拒） */
export const NO_ADMIN_PHONE = '13800004001';

/** J14 SUBMITTED 律师坐标（seed-admin-lawyer.mjs；编排器注入） */
export const SUBMITTED_LAWYER_USER_ID = Number(process.env.E2E_SUBMITTED_LAWYER_USER_ID ?? 0);
/** J16 待处置记录坐标（seed-admin-risk.mjs；逗号分隔，编排器注入） */
export const RISK_RECORD_IDS = (process.env.E2E_RISK_RECORD_IDS ?? '')
  .split(',')
  .map((s) => Number(s))
  .filter((n) => Number.isInteger(n) && n > 0);
/** J18 C6 改价审批坐标（c6-pricing-leg.mjs 律师腿真链产物，编排器注入） */
export const PRICING_HISTORY_ID = Number(process.env.E2E_PRICING_HISTORY_ID ?? 0);
export const PRICING_LAWYER_ID = Number(process.env.E2E_PRICING_LAWYER_ID ?? 0);

/** 运行期唯一尾（J15 建单 ref/J16 新词/J17 草案版本的逐跑唯一坐标——幂等键避让） */
export const RUN_ID = Date.now().toString(36);

/** 夹具运行结果（mint-login.mjs stdout JSON 形状） */
export interface MintResult {
  readonly phone: string;
  readonly code: string;
  readonly user_id?: number;
  readonly realname?: string;
  readonly admin_role?: string;
}

/** 跑 app 夹具 CLI（apps/app/e2e/fixtures/*.mjs），失败即抛（fail-visible） */
function runFixture(script: string, args: readonly string[]): unknown {
  const r = spawnSync(process.execPath, [path.join(APP_FIXTURES, script), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`夹具 ${script} 失败：${(r.stderr ?? '').trim() || (r.stdout ?? '').trim()}`);
  }
  return JSON.parse((r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '{}');
}

/** 取码（flags 透传 --realname/--lawyer/--admin；覆盖式幂等=重跑换新码） */
export function mintLogin(phone: string, code: string, flags: readonly string[] = []): MintResult {
  return runFixture('mint-login.mjs', [phone, code, ...flags]) as MintResult;
}

/**
 * UI 登录旅程（admin 登录真链 W3-2）：手机号+验证码 → POST /auth/verify →（roles 含 admin）
 * 进壳。断言壳可见（sidebar 四组导航样本 + 顶栏退出）。
 */
export async function loginAdminViaUi(page: Page, phone: string, code: string): Promise<void> {
  await page.goto(`${APP_BASE}/`);
  await expect(page).toHaveURL(/#\/login$/); // 未登录任意 hash 收口回 login（resolveRoute 门）
  await page.getByLabel('手机号').fill(phone);
  await page.getByLabel('验证码').fill(code);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expectShell(page);
}

/** 断言 admin 壳可见（sidebar 四组导航样本 + 顶栏退出=登录成功的用户可见态锚） */
export async function expectShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: '律师与资质' })).toBeVisible();
  await expect(page.getByRole('button', { name: '风控与敏感词' })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出' })).toBeVisible();
  await expect(page).not.toHaveURL(/#\/login/); // 已进壳（登录门已过）
}

/** 侧栏导航（AppShell onNavigate → hash 路由） */
export async function navigateTo(page: Page, navTitle: string): Promise<void> {
  await page.getByRole('button', { name: navTitle, exact: true }).click();
}

/** API 锚点：夹具码换 token（经同源反代 → 真实 core；admin 会话与 UI 同链） */
export async function apiVerifyToken(phone: string, code: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  if (!res.ok) {
    throw new Error(`/auth/verify ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== 'string') throw new Error('/auth/verify 出参缺 access_token');
  return body.access_token;
}

/** API 锚点：带 token GET（JSON 出参原样返回） */
export async function apiGet<T>(pathname: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${pathname} ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
