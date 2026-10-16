/**
 * F4 POINTS_EXPIRE 执行器装配（I2 目录在册执行器名，Task 2 简报「你注册」；B2 SLOT_REAPER
 * 先例形态）：经 ScheduleExecutorRegistry.register 注册（onModuleInit，形态同 relay.registerHandler）。
 *
 * 契约注记落地口径（B2 评审结论同款）：
 *   ① recheck 恒真——周期兜底 job 无业务先行语义（POINTS_EXPIRE 的回查锚点 expires_at 由
 *      expireAll 的扣减条件本身承载：未处理额为 0 即无操作，天然幂等）；
 *   ② 自投解耦——执行前经独立事务注册下一日 job（注册与扫描互不连坐：扫描抛错 → 本轮抢占
 *      事务回滚 + I2 退避重试，但下一轮 job 已落库，兜底线不断链；同键（type+ref）在册去重
 *      由 I2 部分唯一索引承担，多节点/重放不翻倍）；
 *   ③ 首个 job 引导=进程入口 main.ts 调 ensureDailyJobScheduled（幂等注册，SLOT_REAPER 同款）。
 *
 * 节拍口径：每日 03:00 Asia/Shanghai（上海日切后扫全量过期；refId=上海日 yyyymmdd 确定性键）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SchedulerService } from '../schedule/scheduler.service';
import { PointsService } from './points.service';

/** Asia/Shanghai 固定 +08:00（无夏令时） */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** 每日扫期：上海 03:00（日切后低峰；§4「每日 job」的节拍锚点，报告注明） */
const DAILY_HOUR_LOCAL = 3;

export interface EnsureDailyJobResult {
  readonly jobId: number;
  /** true=本次新注册；false=同键在册（PENDING|RUNNING）去重回首访（I2 §5 幂等） */
  readonly registered: boolean;
}

/** 下一日扫期（上海 03:00，严格晚于 now）：入参与 refId 同源（refId=该时刻的上海日 yyyymmdd） */
export function nextDailyDueAt(now: Date): { dueAt: Date; refId: number } {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  let dueLocalMs = Date.UTC(
    shanghai.getUTCFullYear(),
    shanghai.getUTCMonth(),
    shanghai.getUTCDate(),
    DAILY_HOUR_LOCAL,
    0,
    0,
  );
  if (dueLocalMs <= shanghai.getTime()) {
    dueLocalMs += DAY_MS;
  }
  const dueLocal = new Date(dueLocalMs);
  const refId =
    dueLocal.getUTCFullYear() * 10_000 + (dueLocal.getUTCMonth() + 1) * 100 + dueLocal.getUTCDate();
  return { dueAt: new Date(dueLocalMs - SHANGHAI_OFFSET_MS), refId };
}

@Injectable()
export class PointsJobExecutors implements OnModuleInit {
  constructor(
    private readonly registry: ScheduleExecutorRegistry,
    private readonly scheduler: SchedulerService,
    private readonly pool: PgPoolService,
    private readonly points: PointsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      jobType: 'POINTS_EXPIRE',
      recheck: async () => true, // 周期兜底：幂等由 expireAll 的扣减条件承载（无未处理额即无操作）
      execute: async ({ uow }) => {
        // 自投下一日（独立事务先行，与扫描成败解耦——B2 评审修复②同款）
        const next = await this.ensureDailyJobScheduled();
        const result = await this.points.expireAll(uow);
        return {
          ...result,
          next_job_id: next.jobId,
          next_due_at: nextDailyDueAt(new Date()).dueAt.toISOString(),
        };
      },
    });
  }

  /**
   * 幂等注册下一日 POINTS_EXPIRE（首个 job 引导=main.ts 调用；后续由执行器 DONE 前自投）。
   * 同键（type+ref）在册 PENDING|RUNNING 行由 I2 部分唯一索引去重回首访。
   */
  async ensureDailyJobScheduled(now: Date = new Date()): Promise<EnsureDailyJobResult> {
    const { dueAt, refId } = nextDailyDueAt(now);
    return this.pool.withTransaction(async (uow: SqlExecutor) => {
      const reg = await this.scheduler.registerJob(uow, {
        jobType: 'POINTS_EXPIRE',
        refType: 'daily',
        refId,
        dueAt,
      });
      return { jobId: reg.jobId, registered: !reg.deduplicated };
    });
  }
}
