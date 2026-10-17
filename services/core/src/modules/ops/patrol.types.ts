/**
 * H4 资损巡检类型契约（架构 §7.2 五类不变量全集 + M1-W4 Task 1 简报）。
 *
 * 五类 kind 逐字对照架构 §7.2「资损不变量巡检 job（分钟级）」：
 *   ① PAID_NOT_REFUNDED   已支付但场次终态且未发起退款 >10min（终态=退款应发起语义集，见
 *                         trade 域 enrollment-patrol 头注；退款在途/已完成不算未发起）
 *   ② STALE_LOCK          活跃锁 >24h 或锁与实体状态不一致（schedule 域 slot-lock-patrol）
 *   ③ SCHED_BACKLOG       schedule 积压/逾期 >60s（消费 I2 backlog()，聚合面 ref_id=0 哨兵）
 *   ④ SPLIT_UNCONFIRMED   分账指令发出但渠道未确认（payment 域 payment-patrol；mock 通道同步
 *                         确认无窗——M2 真通道换装复核窗口语义，许可桩清单 W4 增量）
 *   ⑤ COMPENSATION_UNPAID 补偿应发未发 >24h（pricing 候选 × benefits 授予流水核对）
 * 全集纪律：五类为架构定义全集，禁第六类（发现新风险=报告记录待澄清，列 04 §8 由控制者回写）。
 */
export const PATROL_KINDS = [
  'PAID_NOT_REFUNDED',
  'STALE_LOCK',
  'SCHED_BACKLOG',
  'SPLIT_UNCONFIRMED',
  'COMPENSATION_UNPAID',
] as const;

export type PatrolKind = (typeof PATROL_KINDS)[number];

export type PatrolSeverity = 'INFO' | 'WARN' | 'CRITICAL';

/**
 * 严重度映射（⚠裁决位，报告注明）：直接资金面（①已支付未退款/④渠道资金悬置/⑤欠用户补偿）
 * =CRITICAL（dev 触发 sink 告警）；履约资源/调度健康面（②锁泄漏/③积压）=WARN（台账留痕，
 * 架构「全部接电话/工单」的电话级通道=外部对接后置 M2+，与 MockPatrolAlertSink 供应商位约定一致）。
 */
export const PATROL_KIND_SEVERITY: Readonly<Record<PatrolKind, PatrolSeverity>> = {
  PAID_NOT_REFUNDED: 'CRITICAL',
  STALE_LOCK: 'WARN',
  SCHED_BACKLOG: 'WARN',
  SPLIT_UNCONFIRMED: 'CRITICAL',
  COMPENSATION_UNPAID: 'CRITICAL',
};

/** 巡检入账候选（各检测步产出；入账与否由 PatrolService dedup 决定） */
export interface PatrolFindingCandidate {
  readonly kind: PatrolKind;
  readonly refType: string;
  readonly refId: number;
  readonly severity: PatrolSeverity;
  readonly detail: Record<string, unknown>;
}

/** 单类检测步出参（checked=扫描候选数；findings=违例判定数——含在册未处置的重复检出） */
export interface PatrolDetectionResult {
  readonly checked: number;
  readonly findings: readonly PatrolFindingCandidate[];
}

/** 单类计数（patrol_runs.checked_counts 的每 kind 形状；err=类级失败不拖垮整轮） */
export interface PatrolKindStat {
  readonly checked: number;
  readonly findings: number;
  /** 去重后新入账数（dedup 短路的重复检出不计） */
  readonly inserted: number;
  readonly err?: string;
}

/** runOnce 出参（patrol_runs 行读出口径） */
export interface PatrolRunSummary {
  readonly runId: number;
  readonly status: 'DONE' | 'FAILED';
  readonly findingCount: number;
  readonly checkedCounts: Readonly<Record<string, PatrolKindStat>>;
}
