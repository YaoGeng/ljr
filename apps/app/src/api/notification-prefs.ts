/**
 * I1 通知偏好 API（M3-W1 T4，§5 契约 + core 实文）：
 *   GET /notification-prefs → NotificationPref[]（camelCase：templateCode/enabled/updatedAt；
 *     仅返回已有偏好行——无记录=默认投递，且无模板目录枚举端点 → 偏好页条目面=
 *     已有行 ∪ 收件箱出现过的 templateCode，全新用户空态，见任务报告 triage）
 *   PUT /notification-prefs 体 {prefs: [{template_code, enabled}]}（snake_case，core
 *     parsePrefsBody 实文）→ 同 GET 回读形态；错误 404 E_NOT_FOUND（模板不存在）/
 *     400 E_INVALID_ARGUMENT（关键类不可关）
 *
 * fail-visible：出入参形状本层校验，非法即 CLIENT_BAD_RESPONSE。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';

/** GET /notification-prefs 行（core NotificationPref 实文逐键） */
export interface NotificationPrefView {
  readonly templateCode: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** PUT 单项（§5 词汇 snake_case：template_code/enabled） */
export interface PrefPutItem {
  readonly template_code: string;
  readonly enabled: boolean;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `通知偏好响应形状非法：${detail}`,
  });
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function parsePref(raw: unknown): NotificationPrefView {
  if (typeof raw !== 'object' || raw === null) throw badShape('行非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['templateCode'] !== 'string' || r['templateCode'].length === 0) {
    throw badShape('templateCode 非非空字符串');
  }
  if (typeof r['enabled'] !== 'boolean') throw badShape('enabled 非布尔');
  if (!isIsoString(r['updatedAt'])) throw badShape('updatedAt 非时刻');
  return {
    templateCode: r['templateCode'],
    enabled: r['enabled'],
    updatedAt: r['updatedAt'],
  };
}

/** GET /notification-prefs：我的通知偏好（user 本人面） */
export async function fetchNotificationPrefs(): Promise<NotificationPrefView[]> {
  const raw = await apiFetch<unknown>('/notification-prefs', { auth: true });
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map(parsePref);
}

/** PUT /notification-prefs：批量设置（逐项 upsert；同事务回读最新偏好集） */
export async function putNotificationPrefs(
  items: readonly PrefPutItem[],
): Promise<NotificationPrefView[]> {
  for (const item of items) {
    if (typeof item.template_code !== 'string' || item.template_code.length === 0) {
      throw new AppApiError({
        code: AppClientErrorCode.BadRequest,
        copy: '请求参数有误，请返回重试',
        serverMessage: `prefs 项 template_code 非非空字符串：${JSON.stringify(item.template_code)}`,
      });
    }
    if (typeof item.enabled !== 'boolean') {
      throw new AppApiError({
        code: AppClientErrorCode.BadRequest,
        copy: '请求参数有误，请返回重试',
        serverMessage: `prefs 项 enabled 非布尔：${JSON.stringify(item.enabled)}`,
      });
    }
  }
  const raw = await apiFetch<unknown>('/notification-prefs', {
    method: 'PUT',
    body: { prefs: items.map((i) => ({ template_code: i.template_code, enabled: i.enabled })) },
    auth: true,
  });
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map(parsePref);
}

/** 偏好页条目行（合并产物：偏好行权威态 + 收件箱补充位） */
export interface PrefRow {
  readonly code: string;
  readonly enabled: boolean;
  /** true=来自已有偏好行（权威态）；false=收件箱出现过的类别（无偏好行=默认投递） */
  readonly fromPrefRow: boolean;
}

/**
 * 偏好页条目面合并（纯函数）：GET 偏好行优先（权威 enabled），收件箱出现过的 templateCode
 * 补充（无偏好行=默认投递 true）；按 code 排序稳定呈现。——契约现状：无模板目录枚举端点，
 * 条目面只能来自两处真实 API 数据（见文件头 triage 注记），全新用户两处皆空。
 */
export function mergePrefRows(
  prefs: ReadonlyArray<{ readonly templateCode: string; readonly enabled: boolean }>,
  inboxCodes: readonly string[],
): PrefRow[] {
  const rows = new Map<string, PrefRow>();
  for (const p of prefs) {
    rows.set(p.templateCode, { code: p.templateCode, enabled: p.enabled, fromPrefRow: true });
  }
  for (const code of inboxCodes) {
    if (!rows.has(code)) rows.set(code, { code, enabled: true, fromPrefRow: false });
  }
  return [...rows.values()].sort((a, b) => a.code.localeCompare(b.code));
}
