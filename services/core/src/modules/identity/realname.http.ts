/**
 * A2 HTTP 面请求解析（§5 契约词汇 snake_case）：只做「形状→领域入参」的搬运与防呆，
 * 错误映射经 infrastructure 的 AppHttpExceptionFilter（G-B 做项1 全仓唯一过滤器——不再
 * 复制过滤器，T1 评审 minor-5 口径延续）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { assertRealnameIdNoFormat, assertRealnameName } from './realname.provider';

/** POST /realname 体：{name, id_no} */
export function parseRealnameBody(body: unknown): { name: string; idNo: string } {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {name, id_no}');
  }
  const raw = body as { name?: unknown; id_no?: unknown };
  return {
    name: assertRealnameName(raw.name),
    idNo: assertRealnameIdNoFormat(raw.id_no),
  };
}

/** POST /consents/training 体：{policy_version, accept} */
export function parseTrainingConsentBody(body: unknown): {
  policyVersion: string;
  accept: boolean;
} {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {policy_version, accept}');
  }
  const raw = body as { policy_version?: unknown; accept?: unknown };
  if (typeof raw.policy_version !== 'string' || raw.policy_version === '') {
    throw new AppError(ErrorCode.InvalidArgument, 'policy_version 必须为非空字符串');
  }
  if (typeof raw.accept !== 'boolean') {
    throw new AppError(ErrorCode.InvalidArgument, 'accept 必须为布尔');
  }
  return { policyVersion: raw.policy_version, accept: raw.accept };
}

export interface DecryptQuery {
  readonly userId: number;
  readonly reason: string;
  readonly approvalId: number;
}

/** GET /admin/realname/decrypt 查询参数：{user_id, reason, approval_id}（§5 入参即查询串） */
export function parseDecryptQuery(query: {
  user_id?: unknown;
  reason?: unknown;
  approval_id?: unknown;
}): DecryptQuery {
  const userId = parsePositiveInt(query.user_id, 'user_id');
  const approvalId = parsePositiveInt(query.approval_id, 'approval_id');
  if (typeof query.reason !== 'string' || query.reason.trim() === '' || query.reason.length > 256) {
    throw new AppError(ErrorCode.InvalidArgument, 'reason 必须为 1-256 位非空字符串');
  }
  return { userId, reason: query.reason, approvalId };
}

function parsePositiveInt(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 必须为正整数`);
  }
  return n;
}
