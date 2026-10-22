/**
 * A2 训练授权 API（M3-W1 T3，§5 契约逐字消费）：
 *   POST /consents/training {policy_version, accept} → {status}（409 E_VERSION_MISMATCH；
 *        幂等键=user+policy_version；accept=false 不落行不留痕——R-02 拒绝不降级）
 *   POST /consents/training/revoke → {status, revoked_at?}（R-03 撤回链路起点）
 *   GET  /consents/training → {status, policy_version?, granted_at?, revoked_at?}（当前同意视图）
 *
 * policy_version 事实源在 core 配置（LJR_CONSENT_TRAINING_POLICY_VERSION，默认 v1.0.0）——
 * 前端取值口径：GET 现行视图的 policy_version（有授权/撤回史时回读）；无历史行（ABSENT）时
 * 用 core 代码默认 'v1.0.0'（dev 对齐值）；409 VERSION_MISMATCH → 刷新重试（fail-visible）。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';

export type TrainingConsentStatus = 'ABSENT' | 'GRANTED' | 'REVOKED';

export interface TrainingConsentView {
  readonly status: TrainingConsentStatus;
  readonly policy_version?: string;
  readonly granted_at?: string;
  readonly revoked_at?: string;
}

/** core CONSENT_DEFAULT_CONFIG 默认值（非密钥；GET 无历史行时的提交版本锚点） */
export const DEFAULT_TRAINING_POLICY_VERSION = 'v1.0.0';

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `授权响应形状非法：${detail}`,
  });
}

const STATUS_VALUES: ReadonlySet<string> = new Set(['ABSENT', 'GRANTED', 'REVOKED']);

function parseView(raw: unknown): TrainingConsentView {
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (typeof r['status'] !== 'string' || !STATUS_VALUES.has(r['status'])) {
    throw badShape(`status 越值域：${JSON.stringify(r['status'])}`);
  }
  const optional = (key: 'policy_version' | 'granted_at' | 'revoked_at'): string | undefined => {
    const v = r[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0) throw badShape(`${key} 形态非法`);
    return v;
  };
  const policyVersion = optional('policy_version');
  const grantedAt = optional('granted_at');
  const revokedAt = optional('revoked_at');
  return {
    status: r['status'] as TrainingConsentStatus,
    ...(policyVersion !== undefined ? { policy_version: policyVersion } : {}),
    ...(grantedAt !== undefined ? { granted_at: grantedAt } : {}),
    ...(revokedAt !== undefined ? { revoked_at: revokedAt } : {}),
  };
}

/** GET /consents/training：现行授权状态（授权页状态位与「同版本不重复弹」事实源） */
export async function fetchTrainingConsent(): Promise<TrainingConsentView> {
  const raw = await apiFetch<unknown>('/consents/training', { auth: true });
  return parseView(raw);
}

/** POST /consents/training：授权（accept=true；R-02 独立同意——调用方保证非捆绑勾选场景） */
export async function grantTrainingConsent(policyVersion: string): Promise<TrainingConsentView> {
  if (typeof policyVersion !== 'string' || policyVersion.length === 0) {
    throw new AppApiError({
      code: AppClientErrorCode.BadRequest,
      copy: '请求参数有误，请返回重试',
      serverMessage: `policy_version 非非空字符串：${String(policyVersion)}`,
    });
  }
  const raw = await apiFetch<unknown>('/consents/training', {
    method: 'POST',
    body: { policy_version: policyVersion, accept: true },
    auth: true,
  });
  return parseView(raw);
}

/** POST /consents/training/revoke：撤回（撤回链=未训练样本按 source_msg_id 删除的起点，R-03） */
export async function revokeTrainingConsent(): Promise<
  TrainingConsentView & { revoked_at?: string }
> {
  const raw = await apiFetch<unknown>('/consents/training/revoke', { method: 'POST', auth: true });
  const view = parseView(raw);
  if (view.status !== 'REVOKED') {
    throw badShape(`撤回后状态非 REVOKED：${JSON.stringify(view.status)}`);
  }
  return view;
}
