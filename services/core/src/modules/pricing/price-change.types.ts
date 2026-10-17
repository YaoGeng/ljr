/**
 * C6 改价与补偿类型契约（施工规格 docs/modules/C-交易/C6-改价与补偿.md §3/§5 + Task 9 简报）。
 * wire=snake_case；金额 Money 字符串 / 积分 int（1 积分=1 分）；引擎纯函数在 price-change.engine。
 */
import type { PutPricingInput } from './pricing.types';

/** 改价结果三态（§5 契约 {result: EFFECTED|PENDING_APPROVAL|REJECTED, history_id?}） */
export type ChangeRequestResultState = 'EFFECTED' | 'PENDING_APPROVAL' | 'REJECTED';

/** POST /lawyer/pricing/change 出参（REJECTED 仅由 approve(false) 产生，请求路径不返回） */
export interface ChangeRequestResult {
  readonly result: Exclude<ChangeRequestResultState, 'REJECTED'>;
  readonly history_id: number;
  /** 分配的目标版本号（=请求时点当前最大 version+1） */
  readonly new_version: number;
}

/** POST /pricing/change/{id}/approve 入参（§5 {approved, approval_id}；幂等键=history） */
export interface ApproveInput {
  readonly approved: boolean;
  /** H3 工单 id（①期人工兜底=运营台传入的处置凭据 id；裸引用，H3=M2） */
  readonly approval_id: number;
}

/** POST /pricing/change/{id}/approve 出参（幂等重放返回既有终态，不翻案；直效行 approval_source=null） */
export interface ApproveResult {
  readonly history_id: number;
  readonly result: ChangeRequestResultState;
  readonly approval_source: 'MANUAL' | null;
}

/** POST /pricing/change/{id}/revoke 出参（§5 {status}；restored_version=B3 恢复落版的新版本号） */
export interface RevokeResult {
  readonly history_id: number;
  readonly status: 'REVOKED';
  readonly restored_version: number;
}

/** GET /pricing/histories?lawyer_id= 条目（§3 列面 + id 出站命名 history_id） */
export interface PriceHistoryView {
  readonly history_id: number;
  readonly lawyer_id: number;
  readonly old_version: number;
  readonly new_version: number;
  readonly direction: 'UP' | 'DOWN';
  /** numeric(6,3) 文本（审计展示位；档位判定走引擎整数精确比较） */
  readonly change_pct: string;
  readonly has_active_group: boolean;
  readonly result: ChangeRequestResultState;
  readonly approval_id: number | null;
  readonly approval_source: 'MANUAL' | null;
  readonly credit_penalty: number;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

/** pricing_histories 行读出形态 */
export interface PriceHistoryRow {
  readonly id: string;
  readonly lawyer_id: string;
  readonly old_version: number;
  readonly new_version: number;
  readonly direction: 'UP' | 'DOWN';
  readonly change_pct: string;
  readonly has_active_group: boolean;
  readonly result: ChangeRequestResultState;
  readonly approval_id: string | null;
  readonly approval_source: 'MANUAL' | null;
  readonly credit_penalty: number;
  readonly new_version_draft: PutPricingInput;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
}

/** 补偿对象（trade 导出查询返回切面；paid_full_cents=paid_amount 全额整化分=cash 分+points） */
export interface PaidActiveEnrollment {
  readonly user_id: number;
  readonly paid_full_cents: number;
}
