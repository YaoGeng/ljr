/**
 * 旅程共用件（M3-W1 T5）：夹具调用（node 子进程）+ UI 登录 + API 锚点 + 日期口径镜像。
 *
 * 纪律：
 * - 夹具是唯一造数面（mint-login/seed-notifications 直接复用 T2~T4 实物 CLI，零复制公式）；
 * - 断言双面锚=用户可见态（Playwright UI）+ API 终态（GET 经同源反代 → 真实 core）；
 * - 日期格式化镜像 apps/app/src/utils/date.ts 的 shanghaiParts（zh-CN 短周 + h23 + 上海时区），
 *   供定位种子场次卡片文案（"12-18 周五 20:00 开场"）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { expect, type Page } from '@playwright/test';

/**
 * e2e 目录定位：Playwright 转译器按 CJS 装载本文件（import.meta 不可用），
 * 以 cwd 候选探测（编排器/CLI 统一在 apps/app 下拉起 playwright；仓库根兜底）。
 */
const E2E_DIR = [
  path.resolve(process.cwd(), 'e2e'),
  path.resolve(process.cwd(), 'apps', 'app', 'e2e'),
].find((d) => existsSync(path.join(d, 'fixtures', 'mint-login.mjs')));
if (!E2E_DIR) throw new Error('e2e 目录定位失败（期望在 apps/app 或仓库根下运行）');

/** 编排器注入的坐标与运行期数据（run-e2e.mjs 生成；缺省回落 CLI 独立起服口径） */
export const APP_BASE = process.env.E2E_APP_BASE ?? 'http://127.0.0.1:8792';
export const API_BASE = process.env.E2E_API_BASE ?? APP_BASE;
export const SEED_SESSION_ID = Number(process.env.E2E_SESSION_ID ?? 0);

/** 运行期生成的发团用户与咨询时段（B2 R-03 per-user-per-lawyer PENDING_PAYMENT ≤1 → 发团用户逐跑唯一） */
export const PUBLISHER_PHONE = process.env.E2E_PHONE_PUBLISHER ?? '';
export const SLOT_DATE = process.env.E2E_SLOT_DATE ?? '';
export const SLOT_TIME = process.env.E2E_SLOT_TIME ?? '';

/** 种子场次固定 slot_start（seed-sessions.mjs SESSIONS[0].slotStart，报名中 CREATED 位） */
const SEED_CREATED_SLOT_START = '2026-12-18T20:00:00+08:00';

/** utils/date.ts shanghaiParts 同款（zh-CN 短周 + h23 + Asia/Shanghai） */
function shanghaiParts(iso: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(iso))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

/** 种子场次开场文案（formatDateTime 同形：'12-18 周五 20:00'）——卡片主标题定位锚 */
export const SEED_SLOT_TEXT = (() => {
  const p = shanghaiParts(SEED_CREATED_SLOT_START);
  return `${p['month']}-${p['day']} ${p['weekday'] ?? ''} ${p['hour']}:${p['minute']}`.replace(
    '  ',
    ' ',
  );
})();

/** 夹具运行结果（mint-login.mjs stdout JSON） */
export interface MintResult {
  readonly phone: string;
  readonly code: string;
  readonly user_id?: number;
  readonly realname?: string;
}

/** 跑夹具 CLI（apps/app/e2e/fixtures/*.mjs），失败即抛（fail-visible） */
function runFixture(script: string, args: readonly string[]): unknown {
  const r = spawnSync(process.execPath, [path.join(E2E_DIR, 'fixtures', script), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`夹具 ${script} 失败：${(r.stderr ?? '').trim() || (r.stdout ?? '').trim()}`);
  }
  return JSON.parse((r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '{}');
}

/** 取码（可选 --realname 预置已实名用户；覆盖式幂等=重跑换新码） */
export function mintLogin(phone: string, code: string, realname = false): MintResult {
  const out = runFixture('mint-login.mjs', realname ? [phone, code, '--realname'] : [phone, code]);
  return out as MintResult;
}

/** 预置 2 条 SENT INBOX 站内信（需先 mint-login 造用户行） */
export function seedNotifications(phone: string): { inserted: number } {
  return runFixture('seed-notifications.mjs', [phone]) as { inserted: number };
}

/** UI 登录旅程（W1-5：每用例现登）：手机号+夹具码+年龄声明 → 验证 → 五 tab 壳 */
export async function loginViaUi(page: Page, phone: string, code: string): Promise<void> {
  await page.goto(APP_BASE);
  await page.getByLabel('手机号输入框').fill(phone);
  await page.getByLabel('验证码输入框').fill(code);
  await page.getByRole('checkbox', { name: /我已年满 14 周岁/ }).click();
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await expectTabShell(page, phone);
}

/** 断言五 tab 壳可见（登录成功的用户可见态锚） */
export async function expectTabShell(page: Page, phone: string): Promise<void> {
  for (const title of ['首页', '场次', '发团', '消息', '我的']) {
    await expect(page.getByRole('tab', { name: title })).toBeVisible();
  }
  const masked = `${phone.slice(0, 3)}****${phone.slice(7)}`;
  await expect(page.getByText(masked)).toBeVisible();
}

/** API 锚点：夹具码换 token（经同源反代 → 真实 core） */
export async function apiVerifyToken(phone: string, code: string): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, age_declared: true }),
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
