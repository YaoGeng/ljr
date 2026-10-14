/**
 * B2 调度执行器装配：SLOT_TTL（PENDING_PAYMENT 到期处置）+ SLOT_REAPER（周期兜底扫描）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（I2 机制面；onModuleInit 装配，形态同 relay.registerHandler）。
 * 执行语义（I2 §4）：执行器业务写经 ctx.uow 与 job DONE 同事务；recheck=false → CANCELLED 无操作（R-02）。
 *
 * 契约注记（I2 评审确认）落地口径：
 *   ① registerJob 同键重注册不刷新 dueAt——SLOT_TTL 每锁新键（ref=slot_lock+lockId）不涉及；
 *      SLOT_REAPER 周期自投用递进键（下一周期 dueAt 毫秒）+ ensureReaperJob 的在册 PENDING 检查
 *      （excludeJobId 排除当前轮自见）收敛，自投经独立事务先于扫描（与执行成败解耦）。
 *   ② 取消语义=cancelJob 之外必须同时落业务终态——confirmPayment/releaseSlot 均「取消 job+守卫迁移」
 *      成对执行；TTL 执行器 recheck 以锁状态为回查锚点兜底竞态。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from './scheduler-executor.registry';
import { SlotLockService } from './slot-lock.service';

@Injectable()
export class SlotLockJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly locks: SlotLockService,
  ) {}

  onModuleInit(): void {
    // SLOT_TTL：回查锚点=锁仍 PENDING_PAYMENT（业务先行确认/释放/取消 → false → CANCELLED 无操作）
    this.registry.register({
      jobType: 'SLOT_TTL',
      recheck: async ({ job, uow }) => {
        const res = await uow.query<{ status: string }>(
          `SELECT status FROM schedule.slot_locks WHERE id = $1`,
          [job.refId],
        );
        return res.rows[0]?.status === 'PENDING_PAYMENT';
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { released: false, lock_id: 0 }; // 类型防御：SLOT_TTL 恒带 refId
        const r = await this.locks.releaseExpiredTtl(uow, job.refId);
        return { released: r.released, lock_id: r.lockId };
      },
    });

    // SLOT_REAPER：周期兜底。自投解耦（评审修复②③）：先经独立事务注册下一周期（excludeJobId
    // 排除当前轮自见——其 RUNNING 推进未提交，独立连接仍视其为 PENDING），再执行本轮扫描。
    // 注册与扫描互不连坐：扫描抛错 → 本轮抢占事务回滚 + I2 退避重试，但下一轮 job 已落库
    // （reaper 全量扫描幂等，本轮漏清由下一轮补齐），兜底线不断链；注册抛错 → execute 抛错，
    // 本轮扫描随事务回滚，由 I2 重试重入（含重试注册；advisory 锁+在册检查保多节点收敛不翻倍）。
    this.registry.register({
      jobType: 'SLOT_REAPER',
      recheck: async () => true, // 周期兜底 job 无业务先行语义，恒需执行
      execute: async ({ job, uow }) => {
        const next = await this.locks.ensureReaperScheduled({ excludeJobId: job.id });
        const result = await this.locks.reapOnce(uow);
        return {
          pending_payment_rescued: result.pendingPaymentRescued,
          stale_released: result.staleReleased,
          scanned_active: result.scannedActive,
          skipped_no_provider: result.skippedNoProvider,
          skipped_errored: result.skippedErrored,
          next_job_id: next.jobId,
        };
      },
    });
  }
}
