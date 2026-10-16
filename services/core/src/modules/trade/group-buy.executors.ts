/**
 * C2 调度执行器装配：C2B_CONFIRM_TIMEOUT（12h 确认超时自动拒；I2 §4 对照表 producer=C2/REACHED、
 * executor 注记=C4——W3 无 C4，超时执行器随 C2 本批落位，C4=M2 只承接显式拒绝；偏差在任务报告
 * 注明）。
 *
 * 经 ScheduleExecutorRegistry.register 注册（onModuleInit，SessionJobExecutors 同形态）。
 * 执行语义（I2 §4）：业务写经 ctx.uow 与 job DONE 同事务；recheck=false → CANCELLED 无操作
 * （R-02 幂等回查锚点=拼团状态，I2 目录「group_buy 状态」的字面承载=statusOf）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { GroupBuyService } from './group-buy.service';

@Injectable()
export class GroupBuyJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly groupBuys: GroupBuyService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'C2B_CONFIRM_TIMEOUT',
      // 回查锚点=status：业务先到（C4 确认/取消/终态推进）→ false → CANCELLED 无操作
      recheck: async ({ job, uow }) => {
        if (job.refId === null) return false; // 类型防御：C2B_CONFIRM_TIMEOUT 恒带 refId
        return (await this.groupBuys.statusOf(uow, job.refId)) === 'PENDING_LAWYER';
      },
      execute: async ({ job, uow }) => {
        if (job.refId === null) return { rejected: false, group_buy_id: 0 };
        return this.groupBuys.confirmTimeout(uow, job.refId);
      },
    });
  }
}
