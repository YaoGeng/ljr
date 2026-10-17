/**
 * 执行器注册表（job_type → 回查+执行回调；I2 §2「job 类型全集注册」的机制面）。
 *
 * I2 只做机制不做业务：默认空表，真实执行器由各业务模块经 register() 注册（形态同
 * OutboxRelayService.registerHandler——模块 onModuleInit 注册，如 demo 消费者）：
 *   constructor(registry: ScheduleExecutorRegistry) {
 *     onModuleInit(): void { this.registry.register({ jobType: 'SLOT_TTL', recheck, execute }); }
 *   }
 * 重复注册同一类型即抛（配置错误不静默吞）；到期 job 无注册执行器 → 直接 FAILED+告警
 * （确定性配置错误不烧重试，notify「模板缺失不重试」同款先例；修复后可经 log 重放）。
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import type { ScheduleJobType } from './scheduler.catalog';
import type { JobExecutor } from './scheduler.types';

@Injectable()
export class ScheduleExecutorRegistry {
  private readonly byType = new Map<ScheduleJobType, JobExecutor>();

  register(executor: JobExecutor): this {
    if (this.byType.has(executor.jobType)) {
      throw new AppError(ErrorCode.ConfigInvalid, `调度执行器重复注册：${executor.jobType}`);
    }
    this.byType.set(executor.jobType, executor);
    return this;
  }

  /** 无注册执行器返回 null（由调度器按 NO_EXECUTOR 处置，不在注册表层抛） */
  get(jobType: ScheduleJobType): JobExecutor | null {
    return this.byType.get(jobType) ?? null;
  }

  has(jobType: ScheduleJobType): boolean {
    return this.byType.has(jobType);
  }
}
