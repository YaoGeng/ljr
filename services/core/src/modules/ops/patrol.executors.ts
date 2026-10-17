/**
 * H4 资损巡检执行器装配（RISK_PATROL，I2 目录在册执行器名；M1-W4 Task 1）。
 * B2 SLOT_REAPER/POINTS_EXPIRE 先例形态：onModuleInit 经 ScheduleExecutorRegistry.register
 * 注册（真注册执行器——与 REMIND 系列及 ROOM_OPEN 只预写不装配的 NO_EXECUTOR→FAILED 已知
 * 噪音形态（04 §8 #33）相反）。
 *
 * 契约口径（B2 评审结论同款）：recheck 恒真——周期兜底 job 无业务先行语义，幂等由
 * findings dedup + 检测只读承载；自投解耦——执行前经独立事务注册下一周期（注册与巡检
 * 互不连坐：巡检抛错 → 本轮抢占事务回滚 + I2 退避重试，但下一轮 job 已落库，兜底线不断链）；
 * 首个 job 引导=main.ts 调 PatrolService.ensureScheduled（幂等注册）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { PatrolService } from './patrol.service';

@Injectable()
export class PatrolJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly patrol: PatrolService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'RISK_PATROL',
      recheck: async () => true, // 周期兜底 job 无业务先行语义（SLOT_REAPER/POINTS_EXPIRE 同款）
      execute: async ({ job, uow }) => {
        // 自投下一周期（独立事务先行，与巡检成败解耦——B2 评审修复②同款）
        const next = await this.patrol.ensureScheduled({ excludeJobId: job.id });
        const result = await this.patrol.runOnce(uow);
        return {
          run_id: result.runId,
          status: result.status,
          finding_count: result.findingCount,
          next_job_id: next.jobId,
        };
      },
    });
  }
}
