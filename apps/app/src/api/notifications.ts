/**
 * I1 通知 API（M3-W1 T4）：GET /notifications/mine（§5 契约 + core 实文）：
 *   站内信列表 = 本用户 channel=INBOX 且 status=SENT 的通知（core listInbox：限 50 条、
 *   created_at DESC 排序）。行键为 camelCase（core InboxItem 实文：id/templateCode/channel/
 *   status/params/sentAt/createdAt）。
 *
 * ⚠契约现状（任务报告 triage）：
 *   - 无已读位/已读端点（I1 §3 notifications 表无 read 列）→ 收件箱纯展示，不发明标记已读交互；
 *   - 行无渲染文案字段（仅 templateCode+params）→ 内容渲染走 notify-copy.ts 消费侧模板目录。
 *
 * fail-visible：响应形状本层校验，非法即 CLIENT_BAD_RESPONSE。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';

/** core NotifyChannel（listInbox 恒 'INBOX'）/ NotificationStatus（恒 'SENT'）——结构层宽校验 */
export interface InboxItem {
  readonly id: number;
  readonly templateCode: string;
  readonly channel: string;
  readonly status: string;
  /** 模板渲染参数（JSON 对象；core 空参数回 {}） */
  readonly params: Readonly<Record<string, unknown>>;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `通知响应形状非法：${detail}`,
  });
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function parseInboxItem(raw: unknown): InboxItem {
  if (typeof raw !== 'object' || raw === null) throw badShape('行非对象');
  const r = raw as Record<string, unknown>;
  if (!isPosInt(r['id'])) throw badShape('id 非正整数');
  const templateCode = requireNonEmptyString(r, 'templateCode');
  const channel = requireNonEmptyString(r, 'channel');
  const status = requireNonEmptyString(r, 'status');
  const params = r['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw badShape('params 非对象');
  }
  const sentAt = r['sentAt'];
  if (sentAt !== null && !isIsoString(sentAt)) throw badShape('sentAt 形态非法');
  const createdAt = r['createdAt'];
  if (!isIsoString(createdAt)) throw badShape('createdAt 非时刻');
  return {
    id: r['id'],
    templateCode,
    channel,
    status,
    params: params as Record<string, unknown>,
    sentAt,
    createdAt,
  };
}

function requireNonEmptyString(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== 'string' || v.length === 0) throw badShape(`${key} 非非空字符串`);
  return v;
}

/** GET /notifications/mine：我的站内信（user 本人面；core LIMIT 50 无分页） */
export async function fetchMyNotifications(): Promise<InboxItem[]> {
  const raw = await apiFetch<unknown>('/notifications/mine', { auth: true });
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map(parseInboxItem);
}
