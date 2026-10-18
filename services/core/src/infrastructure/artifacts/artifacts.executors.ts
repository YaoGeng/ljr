/**
 * I3 RETENTION_PURGE 执行器装配（I2 目录在册：producer/executor=I3 周期 job；M2-W1 T2）。
 * RISK_PATROL 同款自投形态（M1-W4 T1 先例）：onModuleInit 经 ScheduleExecutorRegistry.register
 * 真注册；周期=24h 日扫（§4 到期 job 日扫；配置化后置——patrol.config 阈值演进同款路径）。
 *
 * 契约口径（B2/H4 评审结论同款）：recheck 恒真——周期兜底 job 无业务先行语义，幂等由
 * purged_at 判重承载（重入不重复处置不重复出箱）；自投解耦——执行前经独立事务注册下一周期
 * （注册与处置互不连坐，兜底线不断链）；首个 job 引导=main.ts 调 ensurePurgeScheduled。
 *
 * 处置事务语义（评审 I-3 变更）：处置=逐行独立事务（单行失败 warn+failed 计数不连坐），与
 * job DONE 解耦——job DONE 只承载本轮调度完成；未处置行下轮重扫收敛（purged_at 判重兜底）。
 * 仅扫描面故障（pool 级）抛错 → 本轮抢占事务回滚 + I2 退避重试。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../../modules/schedule/scheduler-executor.registry';
import { SchedulerService } from '../../modules/schedule/scheduler.service';
import type { SqlExecutor } from '../sql';
import { PgPoolService } from '../sql';
import { ArtifactsService } from './artifacts.service';

/** 日扫周期（24h；§4 到期处置 job 节拍） */
export const RETENTION_PURGE_INTERVAL_MS = 86_400_000;

/** RETENTION_PURGE 自投的注册表键半边（refId=下一周期 dueAt 毫秒，递进键——RISK_PATROL 同款） */
const RETENTION_PURGE_JOB_REF_TYPE = 'global';

@Injectable()
export class ArtifactsJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly scheduler: SchedulerService,
    private readonly pool: PgPoolService,
    private readonly artifacts: ArtifactsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'RETENTION_PURGE',
      recheck: async () => true, // 周期兜底（处置幂等=purged_at 判重，SLOT_REAPER/POINTS_EXPIRE 同款）
      execute: async ({ job }) => {
        // 自投下一周期（独立事务先行，与处置成败解耦——B2 评审修复②同款）
        const next = await this.ensurePurgeScheduled({ excludeJobId: job.id });
        const result = await this.artifacts.purgeDue(); // 逐行独立事务（评审 I-3），不经 job uow
        return { purged: result.purged, failed: result.failed, next_job_id: next.jobId };
      },
    });
  }

  /**
   * 幂等注册下一周期 RETENTION_PURGE（全局 advisory 锁串行化「查在册 PENDING→注册」防多节点
   * 分叉翻倍；已注册则幂等跳过）。excludeJobId：执行器自投时排除当前轮（其 RUNNING 推进
   * 未提交，独立事务仍视其为 PENDING——不排除会误判已注册而断链）。
   */
  async ensurePurgeScheduled(options?: {
    readonly now?: Date;
    readonly excludeJobId?: number;
  }): Promise<{ jobId: number; registered: boolean }> {
    const now = options?.now ?? new Date();
    const dueAt = new Date(now.getTime() + RETENTION_PURGE_INTERVAL_MS);
    return this.pool.withTransaction((uow) =>
      this.ensurePurgeScheduledInTx(uow, dueAt, options?.excludeJobId),
    );
  }

  private async ensurePurgeScheduledInTx(
    uow: SqlExecutor,
    dueAt: Date,
    excludeJobId?: number,
  ): Promise<{ jobId: number; registered: boolean }> {
    await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ljr:retention_purge_sched']);
    const existing = await this.scheduler.findPendingJobId(uow, 'RETENTION_PURGE', excludeJobId);
    if (existing !== null) return { jobId: existing, registered: false };
    const reg = await this.scheduler.registerJob(uow, {
      jobType: 'RETENTION_PURGE',
      refType: RETENTION_PURGE_JOB_REF_TYPE,
      refId: dueAt.getTime(),
      dueAt,
    });
    return { jobId: reg.jobId, registered: !reg.deduplicated };
  }
}
