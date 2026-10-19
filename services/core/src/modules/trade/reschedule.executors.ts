/**
 * C5 调度执行器装配：RESCHEDULE_CONFIRM_TIMEOUT（I2 catalog 既注册项——producer=C5（申请）、
 * executor=C5、recheckAnchor=reschedule_requests 状态；M2-W2 T5 首次装配，NO_EXECUTOR 噪音消除）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，group-buy.executors 同形态）。
 * 执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务；recheck=false → CANCELLED 无操作
 * （R-02 幂等回查锚点=请求状态——业务先到（确认/撤回）→ false）。执行=PENDING→EXPIRED 超时
 * 回退（R-04：原报名完全不动）+I1 通知位（reschedule.service.expireRequest 头注）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { RescheduleService } from './reschedule.service';

@Injectable()
export class RescheduleJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly reschedules: RescheduleService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'RESCHEDULE_CONFIRM_TIMEOUT',
      // 回查锚点=请求仍 PENDING（catalog recheckAnchor 字面承载）：确认/撤回/并发执行先到 → false
      recheck: async ({ job, uow }) => {
        if (job.refType !== 'reschedule' || job.refId === null) return false; // 类型防御
        return (await this.reschedules.statusOf(uow, job.refId)) === 'PENDING';
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { expired: false, request_id: 0 }; // 不可达死分支（防御）
        return this.reschedules.expireRequest(uow, job.refId);
      },
    });
  }
}
