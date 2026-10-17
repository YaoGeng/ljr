/**
 * C6 REST 面共用件：请求形状解析（§5 契约词汇 snake_case；域校验收敛在 B3 validate 与 C6 服务）。
 * 错误体形态：infrastructure 的 AppHttpExceptionFilter（{code, message} 全仓唯一过滤器）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import type { ApproveInput } from './price-change.types';
import type { PutPricingInput } from './pricing.types';

/** 路径参数 {id}：十进制正整数（pricing_histories.id） */
export function parseHistoryId(raw: string): number {
  return parsePositiveInt(raw, '路径参数 history id');
}

/** POST /lawyer/pricing/change 体形状：{new_version_draft}（draft 域校验=normalizePricingWrite） */
export function parseChangeBody(body: unknown): PutPricingInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {new_version_draft}');
  }
  const raw = body as Record<string, unknown>;
  const draft = raw['new_version_draft'];
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      'new_version_draft 须为对象（B3 全量配置形态：{base_version, per_head?/session_total?, one_on_one_prices, ...}）',
    );
  }
  return draft as PutPricingInput;
}

/** POST /pricing/change/{id}/approve 体形状：{approved, approval_id}（§5 逐字） */
export function parseApproveBody(body: unknown): ApproveInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {approved, approval_id}');
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw['approved'] !== 'boolean') {
    throw new AppError(ErrorCode.InvalidArgument, `approved 须为布尔：${JSON.stringify(raw['approved'])}`);
  }
  const approvalId = raw['approval_id'];
  if (typeof approvalId !== 'number' || !Number.isInteger(approvalId) || approvalId <= 0) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `approval_id 须为正整数（H3 工单 id；①期人工兜底=处置凭据 id）：${JSON.stringify(approvalId)}`,
    );
  }
  return { approved: raw['approved'], approval_id: approvalId };
}
