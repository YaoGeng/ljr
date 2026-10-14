/**
 * B2 调度执行器装配：SLOT_TTL（PENDING_PAYMENT 到期处置）+ SLOT_REAPER（周期兜底扫描）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（I2 机制面；onModuleInit 装配，形态同 relay.registerHandler）。
 * 执行语义（I2 §4）：执行器业务写经 ctx.uow 与 job DONE 同事务；recheck=false → CANCELLED 无操作（R-02）。
 *
 * 契约注记（I2 评审确认）落地口径：
 *   ① registerJob 同键重注册不刷新 dueAt——SLOT_TTL 每锁新键（ref=slot_lock+lockId）不涉及；
 *      SLOT_REAPER 周期自投用递进键（下一周期 dueAt 毫秒）+ ensureReaperJob 的在册 PENDING 检查收敛。
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

    // SLOT_REAPER：周期兜底（执行 DONE 后同事务自投下一周期；在册 PENDING 已存在则幂等跳过）
    this.registry.register({
      jobType: 'SLOT_REAPER',
      recheck: async () => true, // 周期兜底 job 无业务先行语义，恒需执行
      execute: async ({ uow }) => {
        const result = await this.locks.reapOnce(uow);
        const next = await this.locks.ensureReaperJob(
          uow,
          new Date(Date.now() + this.locks.config.reaperIntervalMs),
        );
        return {
          pending_payment_rescued: result.pendingPaymentRescued,
          stale_released: result.staleReleased,
          scanned_active: result.scannedActive,
          next_job_id: next.jobId,
        };
      },
    });
  }
}
