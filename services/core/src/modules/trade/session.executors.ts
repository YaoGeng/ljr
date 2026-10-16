/**
 * C1/C2 调度执行器装配：ENROLL_DEADLINE（截止判定，I2 §4 对照表 producer=C1/C2、executor=本模块）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，SlotLockJobExecutors 同形态）。
 * **按 ref_type 分流**（I2 注册表单执行器约束：同 jobType 重复注册即抛——session= C1 B2C 场次流标、
 * groupbuy= C2 C2B 拼团流标共用 ENROLL_DEADLINE 类型，报告注明）。
 * 执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务；recheck=false → CANCELLED 无操作
 * （R-02 幂等回查锚点=实体状态；I2 目录「场次状态是否仍有效」的字面承载=statusOf 双实现）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { GroupBuyService } from './group-buy.service';
import { SessionService } from './session.service';

@Injectable()
export class SessionJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly sessions: SessionService,
    private readonly groupBuys: GroupBuyService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'ENROLL_DEADLINE',
      // 回查锚点=status 分流：业务先到（成团推进/人工处置/终态）→ false → CANCELLED 无操作
      recheck: async ({ job, uow }) => {
        if (job.refId === null) return false; // 类型防御：ENROLL_DEADLINE 恒带 refId
        if (job.refType === 'groupbuy') {
          return (await this.groupBuys.statusOf(uow, job.refId)) === 'PUBLISHED';
        }
        return (await this.sessions.statusOf(uow, job.refId)) === 'CREATED';
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { failed: false, session_id: 0 };
        if (job.refType === 'groupbuy') {
          return this.groupBuys.expireOnDeadline(uow, job.refId);
        }
        return this.sessions.failOnDeadline(uow, job.refId);
      },
    });
  }
}
