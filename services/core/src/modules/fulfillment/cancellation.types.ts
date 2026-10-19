/**
 * D4 取消与违约处理类型契约（施工规格 docs/modules/D-履约/D4-取消与违约处理.md §4/§5/§6，
 * M2-W2 T3）。金额词汇 Money=string 禁 float（架构 §1.3），整化工具复用 room.types
 * （moneyToCents/centsToMoney 同款）。
 *
 * 无独占表（D4 §3）：判定留痕=state_transition_log（reason 携 D4 分支+规则版本）；取消
 * 矩阵参数=H7 规则中心 rule_definitions 表（rule_key='cancel.matrix'，W2-4 决策位——快照读经 H7
 * RuleCenterService，无生效版本时代码内置默认兜底）。
 */
import type { SessionCancelledPayload } from '@ljr/shared';
import type { RoomStatus } from './room.types';

/** §5 role 入参词汇（platform 不经 API——事件消费路径，D4 §4「平台取消本 API 不暴露」） */
export type CancelRole = 'user' | 'lawyer';

/** §5 用户 <2h 选择（enrollments/{id}/cancel 入参） */
export type UserLateChoice = 'refund50' | 'credit';

/** 矩阵判定档位（engine 纯函数出参词汇；与 STL reason/响应 result 一一对应） */
export type CancelBranch =
  | 'USER_FREE' // 用户 ≥2h：全退或改期一次（C5 指引）
  | 'USER_LATE' // 用户 <2h：退 50% 或扣信用（choice=报名维度）
  | 'LAWYER_NOTICE' // 律师 ≥24h：全退+信用 -10（G1 消费自判）
  | 'LAWYER_LT24H' // 律师 <24h：H3 审批 → 全退+-30+20% 违约金
  | 'PLATFORM' // 平台取消（消费路径）：任意时刻全退零信用
  | 'LAWYER_ABSENT'; // 律师缺席自动终止（消费路径）：全退+-50+50% 赔付

/** 取消矩阵参数（rule_definitions content 契约；credit/suspend 三项=G1 规则镜像信息位） */
export interface CancelMatrixParams {
  /** 用户免费取消窗（小时，含端点：距开始 ≥ 此值走 USER_FREE） */
  readonly userFreeCancelHours: number;
  /** 用户 <2h 档退款比例（%，1-100） */
  readonly userLateRefundPct: number;
  /** 律师通知取消窗（小时，含端点：≥ 此值走 LAWYER_NOTICE） */
  readonly lawyerNoticeHours: number;
  /** 律师 <24h 信用扣分（G1 credit.rules 镜像信息位，D4 不执行） */
  readonly lawyerLatePenaltyCredit: number;
  /** 律师 <24h 违约金比例（%×场次总价，F3 扣划基数） */
  readonly lawyerLatePenaltyPct: number;
  /** 律师缺席信用扣分（G1 镜像信息位） */
  readonly lawyerAbsencePenaltyCredit: number;
  /** 律师缺席赔付比例（%×场次总价，F3 扣划基数） */
  readonly lawyerAbsenceCompensationPct: number;
  /** 连续违规停接窗口（天，G1 violation.window_days 镜像信息位） */
  readonly suspendWindowDays: number;
  /** 窗口内违规次数阈值（G1 violation.threshold 镜像信息位） */
  readonly suspendCount: number;
  /** 停接天数（G1 SUSPEND_TAKE_7D.days 镜像信息位） */
  readonly suspendDays: number;
}

/** §5 POST /sessions/{id}/cancel 入参（幂等键=session+role） */
export interface SessionCancelInput {
  readonly sessionId: number;
  readonly role: CancelRole;
  /** 取消原因（自由文本 ≤200，STL 留痕截 128；缺省空串） */
  readonly reason?: string;
}

/** §5 响应 {result, approval?}（D4 §5 逐字词汇 + additive 幂等/指引位） */
export interface SessionCancelResult {
  readonly result:
    | 'CANCELLED' // 已取消（直接档：USER_FREE/LAWYER_NOTICE；或审批通过后的重放）
    | 'PENDING_APPROVAL' // LAWYER_LT24H：工单已建待审批（approval=工单锚）
    | 'APPROVAL_REJECTED'; // 工单已被驳回（终态，不可再以同 category+ref 建单）
  /** 重放幂等位（幂等键=session+role 命中既有取消） */
  readonly deduplicated?: boolean;
  /** result=CANCELLED 时的退款档（全额=CANCEL_RULE 经 F2 SessionCancelled 消费） */
  readonly refund?: 'FULL';
  /** USER_FREE：免费改期一次的 C5 指引位（D4 不代做——响应透传，客户端转 C5） */
  readonly reschedule_available?: boolean;
  /** PENDING_APPROVAL/APPROVAL_REJECTED：H3 工单锚（approval 半边） */
  readonly approval?: { readonly ticket_id: number; readonly sla_due: string };
}

/** §5 POST /enrollments/{id}/cancel 入参（幂等键=enrollment） */
export interface EnrollmentCancelInput {
  readonly enrollmentId: number;
  readonly choice: UserLateChoice;
}

/** §5 响应 {result}（词汇=additive；400 >=2H_USE_RESCHEDULE / 409 NOT_CANCELLABLE 为错误码） */
export interface EnrollmentCancelResult {
  readonly result: 'CANCELLED_REFUND50' | 'CANCELLED_CREDIT';
  readonly deduplicated?: boolean;
  /** refund50 档：退款单锚（F2 受理受理号） */
  readonly refund_id?: number;
}

/** 统一出箱点执行结果（幂等键=session）：executed=true=本次出箱；prior=true=既有取消事件
 *  短路（D3 platform 路径/先前 D4 路径——赔付指令仍需恒尝试的收敛锚）；两者皆 false=终态
 *  且无取消事件（NOT_CANCELLABLE/防御位）。 */
export interface UnifiedCancelOutcome {
  readonly executed: boolean;
  readonly prior: boolean;
  readonly branch: CancelBranch;
  readonly payload?: SessionCancelledPayload;
  /** executed=false 时既有事件/终态的现状锚 */
  readonly status?: string;
  readonly roomStatus?: RoomStatus | null;
}

/** 违约金/赔付占比分配结果（engine splitCompensationPool 出参；amount_cents 整数分） */
export interface CompensationAllocation {
  readonly user_id: number;
  readonly amount_cents: number;
}

/** 占比分配参与方（paid_cents=cash 分+points 全额口径，D19） */
export interface CompensationParticipant {
  readonly user_id: number;
  readonly paid_cents: number;
}

/** 赔付指令结果（F3 applyPenalty 出参的 D4 视图；replayed=幂等收据重放） */
export interface PenaltyInstruction {
  readonly amount: string;
  readonly replayed: boolean;
  readonly from_settlement: string;
  readonly from_deposit: string;
  readonly debt: string;
}
