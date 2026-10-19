/**
 * H5 人审闭环类型契约（M2-W2 T7；施工规格 docs/modules/H-运营后台/H5-风控与敏感词管理.md
 * §4 人审流程「队列 → 处置（三分支）→ 审计」/ §5 GET /admin/risk/queue、POST
 * /admin/risk/records/{id}/review 409 DONE）。
 *
 * 队列事实源=ops.risk_records（V8 建，REVIEW 命中落行）的 reviewed_at IS NULL 面
 * （ix_risk_records_open 既有部分索引）；处置留痕列 verdict/reviewed_note=V45 增列
 * （控制者裁定列集——verdict 与 action 分列：action=机审判定时词级处置事实（V8 契约），
 * verdict=人审结论，复用会覆盖机审审计锚）。
 */

import type { DictType, WordAction } from './word-dict.types';

/** 人审处置结论三值（§4 处置三分支；V45 ck_risk_records_verdict 值域逐字） */
export const REVIEW_VERDICTS = ['CONFIRM_BLOCK', 'FALSE_POSITIVE', 'MARK_ONLY'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function isReviewVerdict(value: string): value is ReviewVerdict {
  return (REVIEW_VERDICTS as readonly string[]).includes(value);
}

/** 处置备注上限（V45 reviewed_note varchar(500) 同源；应用层校验不静默截断——审计留痕完整性） */
export const REVIEW_NOTE_MAX = 500;

/** 队列筛选面（§5 GET /admin/risk/queue?dict_type=&action=；缺省=全量待审） */
export interface RiskQueueFilter {
  readonly dictType?: string;
  readonly action?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** 待审队列行（reviewed_* 恒 null——队列即「未处置」面；word_hits 形态=V8 [{word, action, rule_version}]） */
export interface RiskQueueItem {
  readonly id: number;
  readonly message_id: number | null;
  readonly conversation_id: number | null;
  readonly dict_type: DictType;
  readonly word_hits: readonly Record<string, unknown>[];
  readonly action: WordAction;
  readonly created_at: string;
}

/** 处置入参（幂等键=record：已处置 409 DONE，不翻案不重复审计） */
export interface RiskReviewInput {
  readonly recordId: number;
  /** admin 操作者 id（claims userId——守卫面注入） */
  readonly operatorId: number;
  readonly verdict: ReviewVerdict;
  /** 处置备注（可选；1..500 非空校验） */
  readonly note?: string;
}

/** 处置出参（行内回填事实——reviewed_at=DB 钟） */
export interface RiskReviewResult {
  readonly record_id: number;
  readonly verdict: ReviewVerdict;
  readonly reviewed_by: number;
  readonly reviewed_at: string;
}
