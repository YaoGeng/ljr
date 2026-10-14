/**
 * I2 调度中心类型契约（施工规格 docs/modules/I-平台支撑/I2-调度中心.md §3/§4/§5/§6）。
 *
 * 机制职责（ADR-0003）：schedule_jobs 事实源 + FOR UPDATE SKIP LOCKED 抢占 + 执行器幂等回查
 * + 重试退避 + ROOM_OPEN 高优先级通道 + schedule_job_log 可重放。I2 只做机制不做业务——
 * 业务效果在各执行模块的 JobExecutor 里（Task3 SLOT_*、Task4 RULE_EFFECTIVE 等后续注册）。
 */
import type { SqlExecutor } from '../../infrastructure/sql';
import type { ScheduleJobType } from './scheduler.catalog';

/** job 状态（§3：PENDING|RUNNING|DONE|CANCELLED|FAILED；迁移经 infrastructure/state-machine 守卫） */
export type ScheduleJobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'CANCELLED' | 'FAILED';

/** 扫描通道：normal=常规（10-15s 周期）；priority=ROOM_OPEN 独立高优先级（≤5s，§4/§8） */
export type SchedulerChannel = 'normal' | 'priority';

/** 被抢占 job 的快照（version=抢占时刻的行版本，执行器可作回查比对锚点） */
export interface ClaimedJob {
  readonly id: number;
  readonly jobType: ScheduleJobType;
  readonly refType: string | null;
  readonly refId: number | null;
  readonly version: number;
  readonly retryCount: number;
  readonly dueAt: Date;
}

/** 执行器上下文：uow=抢占事务的 client——执行器的业务写、状态推进与 log/outbox 同事务 */
export interface JobContext {
  readonly job: ClaimedJob;
  readonly uow: SqlExecutor;
}

/**
 * 执行器（§4：回查 + 执行两段）：
 *   recheck  — R-02 幂等回查：业务当前状态是否仍需要该 job（人工/业务先到 → false，CANCELLED 无操作）；
 *   execute  — 业务效果；返回值序列化进 schedule_job_log.detail（重放/追溯用）；异常 = 失败进退避重试。
 * 执行语义 at-least-once：效果与 DONE 标记同事务提交（崩溃窗口整体回滚，不产生半执行）。
 */
export interface JobExecutor {
  readonly jobType: ScheduleJobType;
  recheck(ctx: JobContext): Promise<boolean>;
  execute(ctx: JobContext): Promise<Record<string, unknown> | void>;
}

/** REGISTER_JOB 入参（§5：与业务同事务，幂等键=type+ref） */
export interface RegisterJobInput {
  readonly jobType: ScheduleJobType;
  /** 幂等键 ref 半边（业务实体类型，≤16 字符；经本 API 注册时必填） */
  readonly refType: string;
  /** 幂等键 ref 另半边（业务实体 id，正整数） */
  readonly refId: number;
  /** 业务锚定时刻（宽限期/缺席判定锚定约定开始时刻，架构 §4.5）；可传过去时刻（misfire 自愈） */
  readonly dueAt: Date;
}

export interface RegisterJobResult {
  readonly jobId: number;
  /** true=同键（type+ref）已有在册 job，返回首访行（§5 幂等） */
  readonly deduplicated: boolean;
}

/** CANCEL_JOB 入参（§5：与业务同事务）；expectedVersion 缺省=作废任意在册（PENDING）行 */
export interface CancelJobInput {
  readonly jobType: ScheduleJobType;
  readonly refType: string;
  readonly refId: number;
  /** 期望 version（§3「业务作废靠 version 比对」）：不符即 stale（job 已被并发推进，调用方转业务态回查兜底） */
  readonly expectedVersion?: number;
}

export interface CancelJobResult {
  /** null=无同键 job（含历史终态行不存在） */
  readonly jobId: number | null;
  /** true=本次调用完成作废（PENDING→CANCELLED，守卫留痕） */
  readonly cancelled: boolean;
  /** true=version 比对不符（job 已被并发推进/作废过），本次未生效 */
  readonly stale: boolean;
}

/** 单轮扫描结果（tick） */
export interface SchedulerTickResult {
  readonly channel: SchedulerChannel;
  /** 执行成功（DONE） */
  readonly done: number;
  /** 回查判定过期/业务先取消 → CANCELLED 无操作 */
  readonly cancelled: number;
  /** 失败进退避重试（仍 PENDING） */
  readonly retried: number;
  /** 重试耗尽或无执行器 → FAILED（终态+告警） */
  readonly failed: number;
}

/** 积压监控（§5：积压 >60s 告警，H4 巡检联动的数据位） */
export interface SchedulerBacklogStats {
  /** PENDING 且 due_at 逾期超过阈值（默认 60s）的 job 数 */
  readonly overdueJobs: number;
  /** 最老逾期 job 的逾期秒数；无逾期为 null */
  readonly oldestOverdueSeconds: number | null;
}

/** 运维视图行（§5 GET /admin/scheduler/jobs） */
export interface ScheduleJobView {
  readonly id: number;
  readonly jobType: ScheduleJobType;
  readonly refType: string | null;
  readonly refId: number | null;
  readonly dueAt: Date;
  readonly status: ScheduleJobStatus;
  readonly version: number;
  readonly retryCount: number;
  readonly nextRetryAt: Date;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly firedAt: Date | null;
}
