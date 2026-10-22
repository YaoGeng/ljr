/**
 * A2 实名 API（M3-W1 T3，§5 契约逐字消费）：
 *   POST /realname {name, id_no} → {status}（幂等键=user；400 E_INVALID_ID 形态错）
 *   GET  /realname/status → {status, verified_at?}（本人面；R-05 出参不含实名信息本体）
 *
 * 状态集（A2 §4）：NONE 未实名 / PENDING 核验中 / VERIFIED 已实名 / FAILED 未通过（可重提）。
 * 客户端镜像（realname.provider 形态层）：姓名 trim 后 1..64；id_no 18 位（末位可 X）。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';

export type RealnameStatus = 'NONE' | 'PENDING' | 'VERIFIED' | 'FAILED';

export interface RealnameStatusView {
  readonly status: RealnameStatus;
  readonly verified_at?: string;
}

/** 身份证形态（core ID_NO_PATTERN 客户端镜像；x 归一大写） */
const ID_NO_PATTERN = /^\d{17}[\dX]$/;

export function normalizeIdNo(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidIdNo(raw: string): boolean {
  return ID_NO_PATTERN.test(normalizeIdNo(raw));
}

export function isValidRealnameName(raw: string): boolean {
  const name = raw.trim();
  return name.length > 0 && name.length <= 64;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `实名响应形状非法：${detail}`,
  });
}

const STATUS_VALUES: ReadonlySet<string> = new Set(['NONE', 'PENDING', 'VERIFIED', 'FAILED']);

/** POST /realname：提交实名核验（dev 沙箱=MOCK 通道，校验位合法即 VERIFIED） */
export async function submitRealname(input: {
  name: string;
  id_no: string;
}): Promise<RealnameStatusView> {
  if (!isValidRealnameName(input.name)) {
    throw new AppApiError({
      code: AppClientErrorCode.BadRequest,
      copy: '请输入正确的姓名（1-64 位非空白字符）',
      serverMessage: `name 形态非法：${JSON.stringify(input.name)}`,
    });
  }
  if (!isValidIdNo(input.id_no)) {
    throw new AppApiError({
      code: AppClientErrorCode.BadRequest,
      copy: '身份证号须为 18 位（末位可为 X）',
      serverMessage: `id_no 形态非法：${JSON.stringify(input.id_no)}`,
    });
  }
  const raw = await apiFetch<unknown>('/realname', {
    method: 'POST',
    body: { name: input.name.trim(), id_no: normalizeIdNo(input.id_no) },
    auth: true,
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['status'] !== 'string' || !STATUS_VALUES.has(r['status'])) {
    throw badShape(`status 越值域：${JSON.stringify(r['status'])}`);
  }
  return { status: r['status'] as RealnameStatus };
}

/** GET /realname/status：本人实名状态（VERIFIED 附 verified_at） */
export async function fetchRealnameStatus(): Promise<RealnameStatusView> {
  const raw = await apiFetch<unknown>('/realname/status', { auth: true });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['status'] !== 'string' || !STATUS_VALUES.has(r['status'])) {
    throw badShape(`status 越值域：${JSON.stringify(r['status'])}`);
  }
  if (r['verified_at'] !== undefined && typeof r['verified_at'] !== 'string') {
    throw badShape('verified_at 形态非法');
  }
  return {
    status: r['status'] as RealnameStatus,
    ...(typeof r['verified_at'] === 'string' ? { verified_at: r['verified_at'] } : {}),
  };
}
