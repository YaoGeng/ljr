/**
 * F4 RESERVE_RECONCILE 执行器装配（M2-W2 T6；附录 A.2 目录增量第 26 项）：日终备付对平
 * ——R-05「备付台账与未兑付积分 1:1 对平」的 I2 机制承载。形态沿 POINTS_EXPIRE 周期先例
 * （B2 SLOT_REAPER 契约注记同款）：
 *   ① recheck 恒真——周期兜底 job 无业务先行语义（对平是幂等只读比较，每轮独立成立）；
 *   ② 自投解耦——执行前经独立事务注册下一日 job（注册与对平互不连坐：对平侧出箱异常 →
 *      本轮抢占事务回滚 + I2 退避重试，但下一轮 job 已落库，兜底线不断链）；
 *   ③ 首个 job 引导=进程入口 main.ts 调 ensureDailyJobScheduled（幂等注册，同款）。
 *
 * 节拍口径（A.2「每日上海 03:00 后随 POINTS_EXPIRE 同款周期形态」→ 任务裁定=上海 04:00，
 * 报告注明）：03:00 过期扫（EXPIRE_NET 落账）完成后再对平，避免同晨竞态把在途过期计成
 * 差异；refId=上海日 yyyymmdd 确定性键（一期一轮）。
 *
 * 对平结果承载（任务裁定）：不建 run 表——结果行=job DONE detail（period/两侧净额/diff
 * +悬空分成核对计数）+不平衡时 ReserveDiffFound 事件（H3 工单），recheckAnchor=
 * reserve_ledgers 最近对平轮次（period）即该记录的可回查面。
 *
 * 修复环 I-3（控制者裁定）：execute 追加悬空分成附带核对（detectDanglingAbsenceShares
 * ——判定流静默 48h 场次的应发未发兜底检出，AbsenceShareDangling→H3 工单）——挂本
 * executor 最小面，不动 RISK_PATROL 五类（架构 §7.2 面不扩，T9 终审轴敏感）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SchedulerService } from '../schedule/scheduler.service';
import { nextDailyDueAt } from './points.executors';
import { ReserveService } from './reserve.service';

/** 日终对平扫期：上海 04:00（03:00 POINTS_EXPIRE 过期扫之后——见类头注） */
export const RESERVE_RECONCILE_HOUR_LOCAL = 4;

@Injectable()
export class ReserveJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly scheduler: SchedulerService,
    private readonly pool: PgPoolService,
    private readonly reserve: ReserveService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'RESERVE_RECONCILE',
      recheck: async () => true, // 周期兜底：对平为幂等只读比较，无业务先行语义
      execute: async ({ uow }) => {
        // 自投下一日（独立事务先行，与对平成败解耦——POINTS_EXPIRE ②同款）
        const next = await this.ensureDailyJobScheduled();
        const result = await this.reserve.reconcile(uow);
        // 修复环 I-3（控制者裁定）：对平轮附带核对悬空分成（应发未发兜底检出——
        // AbsenceShareDangling 出箱→H3 工单；不动 RISK_PATROL 五类面）
        const dangling = await this.reserve.detectDanglingAbsenceShares(uow);
        return {
          period: result.period,
          balanced: result.balanced,
          points_outstanding_cents: result.points_outstanding_cents,
          reserve_net_cents: result.reserve_net_cents,
          diff_cents: result.diff_cents,
          dangling_checked_sessions: dangling.checked_sessions,
          dangling_sessions: dangling.dangling_sessions,
          next_job_id: next.jobId,
          next_due_at: nextDailyDueAt(new Date(), RESERVE_RECONCILE_HOUR_LOCAL).dueAt.toISOString(),
        };
      },
    });
  }

  /**
   * 幂等注册下一日 RESERVE_RECONCILE（首个 job 引导=main.ts 调用；后续由执行器 DONE 前自投）。
   * 同键（type+ref）在册 PENDING|RUNNING 行由 I2 部分唯一索引去重回首访。
   */
  async ensureDailyJobScheduled(
    now: Date = new Date(),
  ): Promise<{ jobId: number; registered: boolean }> {
    const { dueAt, refId } = nextDailyDueAt(now, RESERVE_RECONCILE_HOUR_LOCAL);
    return this.pool.withTransaction(async (uow: SqlExecutor) => {
      const reg = await this.scheduler.registerJob(uow, {
        jobType: 'RESERVE_RECONCILE',
        refType: 'daily',
        refId,
        dueAt,
      });
      return { jobId: reg.jobId, registered: !reg.deduplicated };
    });
  }
}
