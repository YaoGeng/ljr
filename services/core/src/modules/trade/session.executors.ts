/**
 * C1 调度执行器装配：ENROLL_DEADLINE（截止流标判定，I2 §4 对照表 producer=C1/executor=C1）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，SlotLockJobExecutors 同形态）。
 * 执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务；recheck=false → CANCELLED 无操作
 * （R-02 幂等回查锚点=场次状态，I2 目录「场次状态是否仍有效」的字面承载=statusOf）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SessionService } from './session.service';

@Injectable()
export class SessionJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly sessions: SessionService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'ENROLL_DEADLINE',
      // 回查锚点=status：业务先到（成团推进 FULL/人工处置/终态）→ false → CANCELLED 无操作
      recheck: async ({ job, uow }) => {
        if (job.refId === null) return false; // 类型防御：ENROLL_DEADLINE 恒带 refId
        return (await this.sessions.statusOf(uow, job.refId)) === 'CREATED';
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { failed: false, session_id: 0 };
        return this.sessions.failOnDeadline(uow, job.refId);
      },
    });
  }
}
