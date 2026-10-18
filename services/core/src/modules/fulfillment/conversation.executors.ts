/**
 * D5 调度执行器装配（M2-W1 T3）：COLD_ARCHIVE——I2 目录唯一增量（附录 A.2 裁定：producer/
 * executor=D5——messages 冷存扫描属 fulfillment 自持，**禁 I3 基座直连 fulfillment.messages**
 * （schema-refs 纪律）；写 artifacts 经 I3 PUT_ARTIFACT 统一入口，主库清理限本域表）。
 * recheckAnchor=messages 冷存水位（last_archived_created_at——水位=扫描时刻，进程内+
 * job detail 承载，表列不加禁自发明）。
 *
 * RETENTION_PURGE 同款自投形态（M1-W4 T1 先例）：onModuleInit 经 ScheduleExecutorRegistry.register
 * 真注册；周期=24h 日扫。契约口径：recheck 恒真——周期兜底 job 无业务先行语义，幂等由
 * 「created_at<水位」扫描面承载（已冷存行已删，重入零动作）；自投解耦——执行前经独立事务
 * 注册下一周期（注册与冷存互不连坐，兜底线不断链）；首个 job 引导=main.ts 调
 * ensureColdArchiveScheduled。
 *
 * 处置事务语义：逐会话独立事务（archiveColdMessages 内承载，单会话失败 warn+failed 计数
 * 不连坐），与 job DONE 解耦——扫描面故障（pool 级）抛错 → 本轮抢占事务回滚 + I2 退避重试。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SchedulerService } from '../schedule/scheduler.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { ConversationService } from './conversation.service';

/** 日扫周期（24h；messages 冷存节拍，RETENTION_PURGE 同款） */
export const COLD_ARCHIVE_INTERVAL_MS = 86_400_000;

/** COLD_ARCHIVE 自投的注册表键半边（refId=下一周期 dueAt 毫秒，递进键——RISK_PATROL 同款） */
const COLD_ARCHIVE_JOB_REF_TYPE = 'global';

/** 冷存引导锁键（advisory 锁串行化「查在册 PENDING→注册」，RETENTION_PURGE 同款） */
const COLD_ARCHIVE_SCHED_LOCK = 'ljr:cold_archive_sched';

@Injectable()
export class ConversationJobExecutors implements OnModuleInit {
  /** 冷存水位（进程内承载：最近一轮扫描时刻；job detail=durable 承载） */
  private lastScanAt: Date | null = null;

  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly scheduler: SchedulerService,
    private readonly pool: PgPoolService,
    private readonly conversations: ConversationService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'COLD_ARCHIVE',
      recheck: async () => true, // 周期兜底（幂等=created_at<水位扫描面，已冷存行已删）
      execute: async ({ job }) => {
        // 自投下一周期（独立事务先行，与冷存成败解耦——B2 评审修复②同款）
        const next = await this.ensureColdArchiveScheduled({ excludeJobId: job.id });
        const result = await this.conversations.archiveColdMessages(); // 逐会话独立事务，不经 job uow
        this.lastScanAt = new Date(result.scanned_at); // 水位=扫描时刻（recheckAnchor 的字面承载）
        return {
          conversations: result.conversations,
          messages: result.messages,
          failed: result.failed,
          cutoff: result.cutoff,
          last_archived_created_at: result.scanned_at, // job detail durable 水位（附录 A.2 词汇）
          next_job_id: next.jobId,
        };
      },
    });
  }

  /** 最近一轮扫描时刻（水位观测面；null=尚无轮次） */
  get lastScan(): Date | null {
    return this.lastScanAt;
  }

  /**
   * 幂等注册下一周期 COLD_ARCHIVE（全局 advisory 锁串行化「查在册 PENDING→注册」防多节点
   * 分叉翻倍；已注册则幂等跳过）。excludeJobId：执行器自投时排除当前轮（其 RUNNING 推进
   * 未提交，独立事务仍视其为 PENDING——不排除会误判已注册而断链）。
   */
  async ensureColdArchiveScheduled(options?: {
    readonly now?: Date;
    readonly excludeJobId?: number;
  }): Promise<{ jobId: number; registered: boolean }> {
    const now = options?.now ?? new Date();
    const dueAt = new Date(now.getTime() + COLD_ARCHIVE_INTERVAL_MS);
    return this.pool.withTransaction((uow) =>
      this.ensureScheduledInTx(uow, dueAt, options?.excludeJobId),
    );
  }

  private async ensureScheduledInTx(
    uow: SqlExecutor,
    dueAt: Date,
    excludeJobId?: number,
  ): Promise<{ jobId: number; registered: boolean }> {
    await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [COLD_ARCHIVE_SCHED_LOCK]);
    const existing = await this.scheduler.findPendingJobId(uow, 'COLD_ARCHIVE', excludeJobId);
    if (existing !== null) return { jobId: existing, registered: false };
    const reg = await this.scheduler.registerJob(uow, {
      jobType: 'COLD_ARCHIVE',
      refType: COLD_ARCHIVE_JOB_REF_TYPE,
      refId: dueAt.getTime(),
      dueAt,
    });
    return { jobId: reg.jobId, registered: !reg.deduplicated };
  }
}
