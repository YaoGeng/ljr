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

// ---- M3-W2 T7 律师端旅程坐标（run-e2e.mjs 注入：seed-room/seed-groupbuy 夹具 stdout） ----

/** 夹具律师号（seed-sessions/seed-room/seed-groupbuy 同号幂等；登录默认 user 态→Me 切换律师） */
export const LAWYER_PHONE = process.env.E2E_LAWYER_PHONE ?? '13900000001';
/** 律师 user id（J9/J10 API 锚 lawyer 过滤用） */
export const LAWYER_USER_ID = Number(process.env.E2E_LAWYER_USER_ID ?? 0);
/** seed-room 在场用户号（J12 用户提问腿：mint → /auth/verify 换 user token → ws 三帧） */
export const MEMBER_PHONE = process.env.E2E_MEMBER_PHONE ?? '13900000101';
/** seed-room 场次/房间/会话坐标（J11 看板直达、J12 气泡链） */
export const ROOM_SESSION_ID = Number(process.env.E2E_ROOM_SESSION_ID ?? 0);
export const ROOM_ID = Number(process.env.E2E_ROOM_ID ?? 0);
export const CONVERSATION_ID = Number(process.env.E2E_CONVERSATION_ID ?? 0);
/** core WSS 直连坐标（serve-e2e 只代理 HTTP 无 /ws upgrade——用户腿不经反代，W2-3/W2-6） */
export const CORE_WS_URL = process.env.E2E_CORE_WS_URL ?? 'ws://127.0.0.1:3000/ws';
/** J9 开团随机未来时段（编排器生成：30-300 天随机日+整点，避开夹具固定 slot——B2 锁纪律） */
export const LAWYER_SLOT_DATE = process.env.E2E_LAWYER_SLOT_DATE ?? '';
export const LAWYER_SLOT_TIME = process.env.E2E_LAWYER_SLOT_TIME ?? '';

/** 种子场次固定 slot_start（seed-sessions.mjs SESSIONS[0].slotStart，报名中 CREATED 位） */
const SEED_CREATED_SLOT_START = '2026-12-18T20:00:00+08:00';
/** seed-room 场次固定 slot_start（seed-room.mjs SLOT_START——房间 OPEN 数据底座，J11/J12 锚） */
const ROOM_SESSION_SLOT_START = '2026-12-26T20:00:00+08:00';
/** seed-groupbuy PENDING_LAWYER 团固定 slot_start（seed-groupbuy.mjs PENDING_SLOT——J10 锚） */
const PENDING_GB_SLOT_START = '2026-12-28T19:00:00+08:00';

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

/** 开场文案（utils/date formatDateTime 同形：'12-18 周五 20:00'）——卡片主标题定位锚 */
export function shanghaiSlotText(iso: string): string {
  const p = shanghaiParts(iso);
  return `${p['month']}-${p['day']} ${p['weekday'] ?? ''} ${p['hour']}:${p['minute']}`.replace(
    '  ',
    ' ',
  );
}

/** 种子场次开场文案（seed-sessions SESSIONS[0]——J2/J3/J6 卡片锚） */
export const SEED_SLOT_TEXT = shanghaiSlotText(SEED_CREATED_SLOT_START);
/** seed-room 场次开场文案（J11 看板详情头锚） */
export const ROOM_SLOT_TEXT = shanghaiSlotText(ROOM_SESSION_SLOT_START);
/** seed-groupbuy 待确认团开场文案（J10 待响应卡锚） */
export const PENDING_GB_SLOT_TEXT = shanghaiSlotText(PENDING_GB_SLOT_START);
/** 夹具固定 slot ISO（API 锚比对用；core 出参 slot_start=UTC ISO——spec 侧经 Date.parse 归一） */
export const PENDING_GB_SLOT_ISO = PENDING_GB_SLOT_START;

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

/** 断言律师四 tab 壳可见（switch-role 成功的用户可见态锚；用户专属 tab 不在场） */
export async function expectLawyerTabShell(page: Page): Promise<void> {
  for (const title of ['工作台', '场次管理', '接单大厅', '我的']) {
    await expect(page.getByRole('tab', { name: title })).toBeVisible();
  }
  await expect(page.getByRole('tab', { name: '发团' })).toHaveCount(0);
}

/**
 * 律师登录旅程（M3-W2 T7，W2-1 真链）：夹具取码 → UI 登录（默认 user 态）→ Me 页
 * 「切换为律师」→ POST /auth/switch-role 换签 → 律师四 tab 壳。
 * 返回 mint 结果（user_id 供 API 锚）。
 */
export async function loginLawyerViaUi(page: Page, code: string): Promise<MintResult> {
  const mint = mintLogin(LAWYER_PHONE, code);
  await loginViaUi(page, LAWYER_PHONE, mint.code);
  await page.getByRole('tab', { name: '我的' }).click();
  await expect(page.getByRole('button', { name: '切换为律师' })).toBeVisible();
  await page.getByRole('button', { name: '切换为律师' }).click();
  await expectLawyerTabShell(page);
  return mint;
}

/** ws 用户腿结果（ws-user.mjs stdout JSON 形状） */
export interface UserLegResult {
  readonly ok: boolean;
  readonly user_id?: number;
  readonly role?: string;
  readonly conversation_id?: number;
  readonly backfill_count?: number;
  readonly seq?: number;
  readonly msg_client_id?: string;
  readonly deduplicated?: boolean;
  readonly error?: string;
}

/**
 * 用户提问腿（W2-6 真链全贯）：Node ws 客户端直连 core /ws——auth→join conversation→
 * send 三帧（CLI 形态同夹具纪律；回帧断言+超时+teardown 在 lib/ws-user.mjs 内承载）。
 */
export function runWsUserLeg(token: string, message: string, clientId: string): UserLegResult {
  const r = spawnSync(
    process.execPath,
    [
      path.join(E2E_DIR, 'lib', 'ws-user.mjs'),
      '--ws',
      CORE_WS_URL,
      '--token',
      token,
      '--conversation',
      String(CONVERSATION_ID),
      '--message',
      message,
      '--client-id',
      clientId,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  const out = (r.stdout ?? '').trim().split(/\r?\n/).pop() ?? '{}';
  const parsed = JSON.parse(out) as UserLegResult;
  if (r.status !== 0 || parsed.ok !== true) {
    throw new Error(`ws 用户腿失败（exit=${String(r.status)}）：${out.slice(0, 300)}`);
  }
  return parsed;
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
