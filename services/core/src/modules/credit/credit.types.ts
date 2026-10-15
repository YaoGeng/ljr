/**
 * G1 信用体系类型契约（施工规格 docs/modules/G-信用与评价/G1-信用体系.md §3/§5/§7 +
 * M1-W2 Task 6 简报裁决）。
 *
 * 边界（§1）：只做 CreditEvent 不可变流水 + 账户快照（唯一事实源）+ 规则表驱动限制令；
 * 不做入口拦截本体（C1/C3/A3a=W3 消费查询面）与规则公示（H7）。
 * 分值/限制映射一律 H7 `credit.rules` content jsonb 经 RuleCenterService 行为时快照取用
 * （R-W2-10 禁本地建分值表）；行为词汇表（本文件）= 生产者↔G1 的代码级契约，具体分值
 * 由规则内容配置（§11「本模块只承载机制」）。
 */
/**
 * G1 信用体系类型契约（施工规格 docs/modules/G-信用与评价/G1-信用体系.md §3/§5/§7 +
 * M1-W2 Task 6 简报裁决）。
 *
 * 边界（§1）：只做 CreditEvent 不可变流水 + 账户快照（唯一事实源）+ 规则表驱动限制令；
 * 不做入口拦截本体（C1/C3/A3a=W3 消费查询面）与规则公示（H7）。
 * 分值/限制映射一律 H7 `credit.rules` content jsonb 经 RuleCenterService 行为时快照取用
 * （R-W2-10 禁本地建分值表）；行为词汇表（本文件）= 生产者↔G1 的代码级契约，具体分值
 * 由规则内容配置（§11「本模块只承载机制」）。
 */

/** H7 规则中心分值表键（简报 R-W2-10：credit.rules，content jsonb；禁本地建分值表） */
export const CREDIT_RULES_KEY = 'credit.rules';

/** R-01 初始分（文档常量；DB DEFAULT 100 同值；GET /credit/mine 无账户行时同口径回显） */
export const CREDIT_INITIAL_SCORE = 100;

/** GET /credit/mine recent_events 返回条数（§5 未具名条数，最小口径常量，报告注明） */
export const RECENT_EVENTS_LIMIT = 20;

/** owner_type 值域（§3 varchar(8)：'user'|'lawyer'；DB CHECK 同字面） */
export const OWNER_TYPES = ['user', 'lawyer'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export function isOwnerType(value: string): value is OwnerType {
  return (OWNER_TYPES as readonly string[]).includes(value);
}

/** 限制令 kind 值域（§3 varchar(24) 四值；DB CHECK 同字面） */
export const RESTRICTION_KINDS = [
  'BAN_JOIN',
  'BAN_PUBLISH',
  'SUSPEND_TAKE_3D',
  'SUSPEND_TAKE_7D',
] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

/**
 * 行为动作词汇表（PRD §8.8 全表 15 行 + 机制扩展 2 行；值=credit_events.action，DB varchar(32)）。
 * 分值语义：种子值见 credit.spec 测试夹具（RULES_SEED），生产值由 H7 运营配置——本模块只承载机制。
 *   用户：正常参与 +分 ｜ 提前取消 轻微扣 ｜ 2h 内取消 扣 ｜ 缺席 重扣 ｜ 多次缺席→限制拼单（窗口触发）
 *   律师：正常履约 +分 ｜ 取消≥24h -10 ｜ 取消<24h -30 ｜ 缺席 -50 ｜ 拒绝/超时 C2B -5 ｜
 *         连续 2 次取消/缺席→停接 7 天（窗口触发）｜ 涨价(在团) -5 ｜ 降价≤10% -15 ｜
 *         降价>10% -30+停接 3 天 ｜ 恶意频繁改价 -20+停接（严重者口径）
 *   机制扩展：user_slot_abuse（B2 SlotAbuseDetected，§8.8 无行——规则表驱动，报告标注）｜
 *             review_received（G2 ReviewSubmitted「正向加分」，§8.8 无行——同上）
 */
export const CREDIT_ACTIONS = [
  'user_participated',
  'user_cancel_early',
  'user_cancel_late',
  'user_absent',
  'user_slot_abuse',
  'lawyer_participated',
  'lawyer_cancel_24h_plus',
  'lawyer_cancel_under_24h',
  'lawyer_absent',
  'lawyer_reject_timeout',
  'lawyer_price_up',
  'lawyer_price_down_le10',
  'lawyer_price_down_gt10',
  'lawyer_price_abuse',
  'review_received',
] as const;
export type CreditAction = (typeof CREDIT_ACTIONS)[number];

export function isCreditAction(value: string): value is CreditAction {
  return (CREDIT_ACTIONS as readonly string[]).includes(value);
}

/** 限制令规格（规则内容内嵌：kind + 天数；until=消费时 now()+days，DB 时钟） */
export interface RestrictionSpec {
  readonly kind: RestrictionKind;
  readonly days: number;
}

/** 单行为规则（credit.rules content 的 actions.<action> 项） */
export interface ActionRule {
  /** 分值增量（正加负减；R-01 账户下限钳 0 不改流水记录值） */
  readonly delta: number;
  /** 达该行为即发限制令（可选；如降价>10%→SUSPEND_TAKE_3D） */
  readonly restriction?: RestrictionSpec;
  /** 计入连续违规 30 天窗口计数（可选；取消/缺席类） */
  readonly violation?: boolean;
}

/**
 * credit.rules content jsonb 结构（本模块定义，供 H7 运营配置对齐——简报裁决「结构自定，报告给出」）：
 * {
 *   "violation": {                       // 连续违规窗口（G1 §4：30 天窗口取消/缺席 ≥2 → SUSPEND_TAKE_7D）
 *     "window_days": 30,                 // 窗口长度（天）
 *     "threshold": 2,                    // 触发阈值（≥N 次；含本次）
 *     "restriction_by_owner": {          // 按 owner_type 的窗口触发限制令（PRD §8.8：律师→停接 7 天、
 *       "user":   { "kind": "BAN_JOIN",        "days": 7 },   // 用户多次缺席→限制拼单；天数未定义文档，运营配置）
 *       "lawyer": { "kind": "SUSPEND_TAKE_7D", "days": 7 }
 *     }
 *   },
 *   "actions": {
 *     "<action>": { "delta": -30,                          // 必填：分值增量
 *                   "restriction": { "kind": "...", "days": 3 },  // 可选：达该行为即发限制令
 *                   "violation": true }                     // 可选：计入窗口计数
 *   }
 * }
 */
export interface CreditRulesContent {
  readonly violation: {
    readonly window_days: number;
    readonly threshold: number;
    readonly restriction_by_owner: {
      readonly user: RestrictionSpec;
      readonly lawyer: RestrictionSpec;
    };
  };
  readonly actions: Readonly<Record<string, ActionRule>>;
}

/** credit_events 流水视图（GET /credit/mine recent_events 条目；snake_case 出站口径） */
export interface CreditEventView {
  readonly id: number;
  readonly action: string;
  readonly delta: number;
  readonly rule_version: number;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly created_at: string;
}

/** 活跃限制令视图（GET /credit/mine 与 /credit/restrictions 条目） */
export interface RestrictionView {
  readonly id: number;
  readonly kind: RestrictionKind;
  /** ISO 8601（timestamptz 出站序列化口径） */
  readonly until: string;
  readonly reason: string;
  readonly created_at: string;
}

/** GET /credit/mine 出参（§5：{score, recent_events, restrictions[]}；JWT 本人） */
export interface CreditMineView {
  readonly score: number;
  readonly recent_events: readonly CreditEventView[];
  readonly restrictions: readonly RestrictionView[];
}

/** EMIT_CREDIT_EVENT 内部接口入参（§5：{owner, action, ref}；幂等键=ref+action） */
export interface EmitCreditEventInput {
  readonly owner_type: OwnerType;
  readonly owner_id: number;
  readonly action: CreditAction;
  /** 幂等引用（多态：session/price_change/attendance/review/group/outbox_event…） */
  readonly ref_type: string;
  readonly ref_id: number;
}

/** EMIT_CREDIT_EVENT 出参（deduplicated=true=at-least-once 重放短路：分数不变、无新事件） */
export interface EmitCreditEventResult {
  readonly deduplicated: boolean;
  /** 新流水行 id（重放短路不回读既有流水，恒为 null——报告口径） */
  readonly event_id: number | null;
  /** 本次生效 delta（重放短路时 null） */
  readonly delta: number | null;
  /** 出参时点账户分（含钳制） */
  readonly score: number;
  /** 本次新发行的限制令（重复发放同 kind 未到期=幂等跳过，不在列） */
  readonly restrictions_issued: readonly RestrictionView[];
}
