/**
 * I2 调度服务（机制核心）：REGISTER_JOB / CANCEL_JOB（与业务同事务，§5 幂等键=type+ref）、
 * tick 抢占执行（FOR UPDATE SKIP LOCKED 多节点安全 + 执行器幂等回查 R-02）、log 重放、
 * 运维视图查询（§5 GET /admin/scheduler/jobs 数据面）、积压监控判定（H4 联动前置）。
 *
 * 执行流（§4）：抢占 → 回查业务当前状态（recheck=false → CANCELLED 无操作）→ 执行 → DONE；
 *   抢占/回查/执行/状态推进/log/ScheduleJobFired 同一事务（效果与 DONE 原子，崩溃整体回滚回
 *   PENDING——无悬挂 RUNNING，重启后逾期任务自然被捞取，misfire 自愈）；
 *   执行器异常 → 抢占事务回滚，独立事务排定退避重试（retry_count+1、next_retry_at=now()+backoff），
 *   退避重试 3 次后 FAILED+告警（§4）；FAILED 不自动重试，由运维 replayJob 同 job_id 重新入队；
 *   类型无注册执行器 → 确定性配置错误，直接 FAILED+告警（不烧重试；notify「模板缺失不重试」先例）。
 *
 * 驱动：测试/嵌入场景手动 tick()；生产节拍=SchedulerWorker interval（仅进程入口启动，ADR-0003：
 * 节拍器仅内存态非事实源，正确性不依赖它）。
 */
import { Injectable, Optional } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { isScheduleJobType, type ScheduleJobType } from './scheduler.catalog';
import { defaultBackoffMs, schedulerConfigFromEnv, type SchedulerConfig } from './scheduler.config';
import { SCHEDULE_JOB_MACHINE } from './scheduler.machine';
// 注意：ScheduleExecutorRegistry/SchedulerAlertService 必须 value import（DI 元数据按构造参数类型解析，
// type-only import 会被擦成 Object 导致 Nest 无法解析依赖）
import { ScheduleExecutorRegistry } from './scheduler-executor.registry';
import { SchedulerAlertService } from './scheduler-alerts';
import type {
  CancelJobInput,
  CancelJobResult,
  ClaimedJob,
  RegisterJobInput,
  RegisterJobResult,
  SchedulerBacklogStats,
  SchedulerChannel,
  SchedulerTickResult,
  ScheduleJobStatus,
  ScheduleJobView,
} from './scheduler.types';

/** I2 生产事件（§6）：ScheduleJobFired{job_id, type, ref}（→执行模块） */
export const SCHEDULE_JOB_FIRED_TOPIC = 'schedule.job.fired';

export interface SchedulerServiceOptions {
  /** 单轮 tick 至多处理条数（默认 25；§8 抢占吞吐 ≥500 job/s 由多节点+batch 扩展） */
  readonly batch?: number;
  /** 配置覆盖（缺省经 env 装载） */
  readonly config?: SchedulerConfig;
  /** 退避函数覆盖（第 n 次重试毫秒；测试注入零退避使耗尽确定到达） */
  readonly backoffMs?: (retryCount: number) => number;
}

type TickOutcome = 'done' | 'cancelled' | 'retried' | 'failed';

type LogResult = 'DONE' | 'CANCELLED' | 'RETRY' | 'FAILED' | 'NO_EXECUTOR';

interface ClaimedRow {
  readonly id: string;
  readonly job_type: string;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly version: number;
  readonly retry_count: number;
  readonly due_at: Date;
}

interface JobTableRow {
  readonly id: string;
  readonly job_type: string;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly due_at: Date;
  readonly status: ScheduleJobStatus;
  readonly version: number;
  readonly retry_count: number;
  readonly next_retry_at: Date;
  readonly last_error: string | null;
  readonly created_at: Date;
  readonly fired_at: Date | null;
}

@Injectable()
export class SchedulerService {
  private readonly config: SchedulerConfig;
  private readonly batch: number;
  private readonly backoffMs: (retryCount: number) => number;

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly executors: ScheduleExecutorRegistry,
    private readonly alerts: SchedulerAlertService,
    @Optional() options?: SchedulerServiceOptions,
  ) {
    this.config = options?.config ?? schedulerConfigFromEnv();
    this.batch = options?.batch ?? 25;
    this.backoffMs = options?.backoffMs ?? defaultBackoffMs(this.config);
  }

  // ---------- REGISTER_JOB / CANCEL_JOB（§5：与业务同事务——调用方在其业务事务内以 uow 调用） ----------

  /** REGISTER_JOB：幂等键=type+ref（§5）；同键在册（PENDING|RUNNING）行去重回首访（DB 部分唯一索引兜底） */
  async registerJob(uow: SqlExecutor, input: RegisterJobInput): Promise<RegisterJobResult> {
    this.assertJobRef(input.jobType, input.refType, input.refId);
    if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime())) {
      throw new AppError(ErrorCode.InvalidArgument, `dueAt 须为有效 Date：${String(input.dueAt)}`);
    }
    // 至多两趟：并发同键注册在唯一索引败退后，若冲突事务回滚（在册行消失）则重试插入一次
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claim = await uow.query<{ id: string }>(
        `INSERT INTO schedule.schedule_jobs (job_type, ref_type, ref_id, due_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_type, ref_type, ref_id) WHERE status IN ('PENDING', 'RUNNING') DO NOTHING
         RETURNING id`,
        [input.jobType, input.refType, input.refId, input.dueAt],
      );
      if ((claim.rowCount ?? 0) > 0) {
        return { jobId: Number(claim.rows[0]?.id), deduplicated: false };
      }
      const prev = await uow.query<{ id: string }>(
        `SELECT id FROM schedule.schedule_jobs
          WHERE job_type = $1 AND ref_type = $2 AND ref_id = $3
            AND status IN ('PENDING', 'RUNNING')`,
        [input.jobType, input.refType, input.refId],
      );
      const row = prev.rows[0];
      if (row) return { jobId: Number(row.id), deduplicated: true };
    }
    throw new AppError(ErrorCode.InternalError, 'REGISTER_JOB 幂等竞态未收敛（不应触达）');
  }

  /**
   * CANCEL_JOB：作废在册 PENDING 行（守卫迁移 PENDING→CANCELLED，与业务同事务回滚）。
   * expectedVersion（§3「业务作废靠 version 比对」）：行版本不符 → stale=true 不生效——
   * job 已被并发推进（重试/重放/作废过），调用方应以业务态回查兜底（R-02）后重试作废。
   */
  async cancelJob(uow: SqlExecutor, input: CancelJobInput): Promise<CancelJobResult> {
    this.assertJobRef(input.jobType, input.refType, input.refId);
    const live = await uow.query<{ id: string; version: number }>(
      `SELECT id, version FROM schedule.schedule_jobs
        WHERE job_type = $1 AND ref_type = $2 AND ref_id = $3 AND status = 'PENDING'
        FOR UPDATE`,
      [input.jobType, input.refType, input.refId],
    );
    const liveRow = live.rows[0];
    if (!liveRow) {
      // 无在册 PENDING 行：区分「从未在册」与「终态/并发推进后终态」
      const any = await uow.query<{ id: string; version: number }>(
        `SELECT id, version FROM schedule.schedule_jobs
          WHERE job_type = $1 AND ref_type = $2 AND ref_id = $3
          ORDER BY id DESC LIMIT 1`,
        [input.jobType, input.refType, input.refId],
      );
      const row = any.rows[0];
      if (!row) return { jobId: null, cancelled: false, stale: false };
      return {
        jobId: Number(row.id),
        cancelled: false,
        stale: input.expectedVersion !== undefined && row.version !== input.expectedVersion,
      };
    }
    const jobId = Number(liveRow.id);
    if (input.expectedVersion !== undefined && liveRow.version !== input.expectedVersion) {
      return { jobId, cancelled: false, stale: true };
    }
    await this.transition(uow, jobId, 'PENDING', 'CANCELLED', 'cancel_job');
    return { jobId, cancelled: true, stale: false };
  }

  /** log 重放（§4 FAILED 处置）：同 job_id 重新入队（FAILED→PENDING，retry_count 归零），幂等回查兜底安全 */
  async replayJob(jobId: number): Promise<{ replayed: boolean }> {
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `jobId 须为正整数：${String(jobId)}`);
    }
    return this.pool.withTransaction(async (uow) => {
      const row = await uow.query<{ id: string }>(
        `SELECT id FROM schedule.schedule_jobs WHERE id = $1 AND status = 'FAILED' FOR UPDATE`,
        [jobId],
      );
      if (!row.rows[0]) return { replayed: false };
      await this.transition(uow, jobId, 'FAILED', 'PENDING', 'log_replay');
      await uow.query(
        `UPDATE schedule.schedule_jobs
            SET retry_count = 0, next_retry_at = now(), last_error = NULL
          WHERE id = $1`,
        [jobId],
      );
      return { replayed: true };
    });
  }

  // ---------- 扫描执行（tick；生产节拍由 SchedulerWorker 驱动） ----------

  /**
   * 单轮扫描：逐条抢占执行至多 batch 条（priority 通道只扫 ROOM_OPEN，normal 只扫其余——§4 双通道）。
   * 拾取条件：PENDING 且 due_at 到期且退避门槛已到；SKIP LOCKED 保证多节点恰一抢占（§8）。
   */
  async tick(
    channel: SchedulerChannel = 'normal',
    batchLimit?: number,
  ): Promise<SchedulerTickResult> {
    const batch = batchLimit ?? this.batch;
    const result = { channel, done: 0, cancelled: 0, retried: 0, failed: 0 };
    const pendingAlerts: Array<() => Promise<void>> = [];
    // 单调已尝试集：本轮内已处理过的 job（含失败退避的）不再重复拾取——
    // 「一个 tick 对一个 job 至多尝试一次」，零退避配置下也不会同轮热循环烧 batch（relay 游标同款思路）
    const attempted: number[] = [];
    for (let i = 0; i < batch; i += 1) {
      const { claimed, outcome } = await this.runOne(channel, attempted, pendingAlerts);
      if (!claimed) break; // 空轮/均被抢占
      if (outcome === 'done') result.done += 1;
      else if (outcome === 'cancelled') result.cancelled += 1;
      else if (outcome === 'retried') result.retried += 1;
      else if (outcome === 'failed') result.failed += 1;
    }
    // 告警在事务提交后触发：不阻塞/不回滚调度主流程；sink 失败不影响调度结果
    for (const fire of pendingAlerts) {
      await fire().catch(() => undefined);
    }
    return result;
  }

  /** 抢占并执行一条；返回 claimed=false 表示本轮无到期可拾取 job */
  private async runOne(
    channel: SchedulerChannel,
    attempted: number[],
    pendingAlerts: Array<() => Promise<void>>,
  ): Promise<{ claimed: boolean; outcome: TickOutcome | null }> {
    const holder: { job: ClaimedJob | null } = { job: null };
    try {
      const outcome = await this.pool.withTransaction(async (uow) => {
        const job = await this.claimOne(uow, channel, attempted);
        if (!job) return null;
        holder.job = job;
        attempted.push(job.id);
        return this.runClaimed(uow, job, pendingAlerts);
      });
      return { claimed: holder.job !== null, outcome };
    } catch (e) {
      const job = holder.job;
      if (!job) throw e; // 非执行器异常（连接级等）原样上抛，由调用方决定终止或忽略
      // 执行器/回查异常：抢占事务已回滚（效果与 RUNNING 标记一并消失）→ 独立事务排定重试或 FAILED。
      // 竞态窗口：回滚释放行锁后，另一节点可能已再抢占/推进该 job——scheduleRetryOrFail 行锁重读，
      // 非 PENDING 即放弃善后（不写 log、不计数、不迁移；null 不打断本轮其余 job 的计数与告警）
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const outcome = await this.scheduleRetryOrFail(job, message);
      if (outcome === 'failed') {
        pendingAlerts.push(async () => {
          await this.alerts.alertJobFailed(job.jobType, job.id, message);
        });
      }
      return { claimed: true, outcome };
    }
  }

  /** 抢占事务内执行一条已锁定的 job（抛错=执行器失败，随事务回滚） */
  private async runClaimed(
    uow: SqlExecutor,
    job: ClaimedJob,
    pendingAlerts: Array<() => Promise<void>>,
  ): Promise<TickOutcome> {
    const startedAt = Date.now();
    const executor = this.executors.get(job.jobType);
    if (!executor) {
      const message = `job 类型无注册执行器：${job.jobType}（全集在册但执行器未装配；修复后可经 log 重放）`;
      await this.transition(uow, job.id, 'PENDING', 'FAILED', 'no_executor');
      await uow.query(
        `UPDATE schedule.schedule_jobs SET last_error = $2, fired_at = COALESCE(fired_at, now())
          WHERE id = $1`,
        [job.id, message],
      );
      await this.writeLog(uow, job, 'NO_EXECUTOR', message, Date.now() - startedAt);
      pendingAlerts.push(async () => {
        await this.alerts.alertJobFailed(job.jobType, job.id, message);
      });
      return 'failed';
    }

    // R-02 幂等回查：业务/人工先到 → 过期 → CANCELLED 无操作
    const alive = await executor.recheck({ job, uow });
    if (!alive) {
      await this.transition(uow, job.id, 'PENDING', 'CANCELLED', 'recheck_superseded');
      await this.writeLog(uow, job, 'CANCELLED', null, Date.now() - startedAt);
      return 'cancelled';
    }

    await this.transition(uow, job.id, 'PENDING', 'RUNNING', 'claim', true);
    const ret = await executor.execute({ job, uow });
    await this.transition(uow, job.id, 'RUNNING', 'DONE', 'execute_done');
    await this.writeLog(uow, job, 'DONE', serializeResult(ret), Date.now() - startedAt);
    // §6：ScheduleJobFired 与执行同事务（业务回滚则事件不出）
    await this.outbox.recordOutbox(uow, {
      type: SCHEDULE_JOB_FIRED_TOPIC,
      payload: { job_id: job.id, type: job.jobType, ref_type: job.refType, ref_id: job.refId },
    });
    if (job.jobType === 'ROOM_OPEN') {
      // R-03：准点保障——开房触发延迟 >30s 电话告警（事务提交后触发，见 tick）
      pendingAlerts.push(async () => {
        await this.alerts.alertRoomOpenDelay(job.id, job.dueAt);
      });
    }
    return 'done';
  }

  /**
   * 执行失败的善后（独立事务）：先 FOR UPDATE 行锁重读行态——抢占事务回滚到本事务之间，
   * 另一节点可能已再抢占/推进该 job；非 PENDING 即放弃善后返回 null（R-04 log 只记真实发生的
   * 重试，且 FAILED 迁移不得以 StateStaleEntity 打断整轮 tick）；仍 PENDING 才排定退避重试
   * （retry_count+1、next_retry_at=now()+backoff）或重试耗尽 → FAILED 终态。
   */
  private async scheduleRetryOrFail(job: ClaimedJob, message: string): Promise<TickOutcome | null> {
    const startedAt = Date.now();
    const newRetry = job.retryCount + 1;
    const exhausted = newRetry > this.config.maxRetries;
    return this.pool.withTransaction(async (uow) => {
      const current = await uow.query<{ status: ScheduleJobStatus }>(
        `SELECT status FROM schedule.schedule_jobs WHERE id = $1 FOR UPDATE`,
        [job.id],
      );
      const rowStatus = current.rows[0]?.status;
      if (rowStatus !== 'PENDING') return null; // 已被并发推进（RUNNING/DONE/CANCELLED/FAILED）或行不存在
      if (exhausted) {
        await this.transition(uow, job.id, 'PENDING', 'FAILED', 'retries_exhausted');
        await uow.query(
          `UPDATE schedule.schedule_jobs SET last_error = $2, fired_at = COALESCE(fired_at, now())
            WHERE id = $1`,
          [job.id, message],
        );
      } else {
        await uow.query(
          `UPDATE schedule.schedule_jobs
              SET retry_count = $2,
                  next_retry_at = now() + ($3::bigint * interval '1 millisecond'),
                  version = version + 1,
                  last_error = $4,
                  fired_at = COALESCE(fired_at, now())
            WHERE id = $1 AND status = 'PENDING'`,
          [job.id, newRetry, this.backoffMs(newRetry), message],
        );
      }
      await this.writeLog(
        uow,
        job,
        exhausted ? 'FAILED' : 'RETRY',
        message,
        Date.now() - startedAt,
      );
      return exhausted ? 'failed' : 'retried';
    });
  }

  // ---------- 运维视图与监控（§5） ----------

  /** GET /admin/scheduler/jobs?status=&type= 数据面（后台鉴权 ⚠决策位：随 H1/H2 W2+ 接入） */
  async listJobs(
    filter: {
      readonly status?: ScheduleJobStatus;
      readonly jobType?: ScheduleJobType;
      readonly limit?: number;
    } = {},
  ): Promise<ScheduleJobView[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filter.jobType !== undefined) {
      params.push(filter.jobType);
      clauses.push(`job_type = $${params.length}`);
    }
    params.push(filter.limit ?? 100);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.pool.query<JobTableRow>(
      `SELECT id, job_type, ref_type, ref_id, due_at, status, version, retry_count,
              next_retry_at, last_error, created_at, fired_at
         FROM schedule.schedule_jobs ${where}
        ORDER BY due_at, id
        LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      jobType: r.job_type as ScheduleJobType,
      refType: r.ref_type,
      refId: r.ref_id === null ? null : Number(r.ref_id),
      dueAt: r.due_at,
      status: r.status,
      version: r.version,
      retryCount: r.retry_count,
      nextRetryAt: r.next_retry_at,
      lastError: r.last_error,
      createdAt: r.created_at,
      firedAt: r.fired_at,
    }));
  }

  /**
   * 积压监控判定（§5：积压 >60s 告警，H4 巡检联动的数据位）：PENDING 且逾期超阈值的 job 数
   * 与最老逾期秒数。阈值事实源=config.backlogAlertMs。
   *
   * H4 巡检消费注记（M1-W4 T1）：只看 PENDING 逾期——FAILED（含 REMIND 系列与 ROOM_OPEN
   * 未装配执行器的 NO_EXECUTOR 已知噪音，04 §8 #33）属 JOB_FAILED 告警面非积压面，本面不计
   * （现状语义即如此，注记锚定）。patrol 直连消费本方法，勿在巡检侧重写判定。
   */
  async backlog(now: Date = new Date()): Promise<SchedulerBacklogStats> {
    const cutoff = new Date(now.getTime() - this.config.backlogAlertMs);
    const res = await this.pool.query<{ n: string; oldest: string | null }>(
      `SELECT count(*)::text AS n,
              EXTRACT(EPOCH FROM ($2::timestamptz - min(due_at)))::text AS oldest
         FROM schedule.schedule_jobs
        WHERE status = 'PENDING' AND due_at < $1::timestamptz`,
      [cutoff, now],
    );
    const row = res.rows[0];
    const oldest = row?.oldest;
    return {
      overdueJobs: Number(row?.n ?? 0),
      oldestOverdueSeconds:
        oldest === null || oldest === undefined ? null : Math.floor(Number(oldest)),
    };
  }

  /**
   * 指定类型在册 PENDING job 定位（周期 job 自投的在册检查导出面，M1-W4 T1：H4 RISK_PATROL
   * 消费——B2 ensureReaperJob 同语义；slot-locks 同域内联，本面为跨域消费的合法缝）。
   * exec 形态：与注册方（advisory 锁 → 检查 → registerJob）同一 uow 串行化，独立连接读不到
   * 本事务上下文无意义。excludeJobId：排除当前轮自见（其 RUNNING 推进未提交，uow 内仍视其
   * 为 PENDING——不排除会把当前轮误判为「已注册」而跳过自投，节拍链断链）。
   */
  async findPendingJobId(
    exec: SqlExecutor,
    jobType: ScheduleJobType,
    excludeJobId?: number,
  ): Promise<number | null> {
    const res = await exec.query<{ id: string }>(
      `SELECT id FROM schedule.schedule_jobs
        WHERE job_type = $1 AND status = 'PENDING' AND id <> $2
        ORDER BY id LIMIT 1`,
      [jobType, excludeJobId ?? 0],
    );
    const id = res.rows[0]?.id;
    return id === undefined ? null : Number(id);
  }

  // ---------- 内部件 ----------

  /** 抢占一条到期 job（FOR UPDATE SKIP LOCKED；priority 通道只扫 ROOM_OPEN；exclude=本轮已尝试） */
  private async claimOne(
    uow: SqlExecutor,
    channel: SchedulerChannel,
    exclude: number[],
  ): Promise<ClaimedJob | null> {
    const typeFilter =
      channel === 'priority' ? `job_type = 'ROOM_OPEN'` : `job_type <> 'ROOM_OPEN'`;
    const values: unknown[] = [];
    let excludeFilter = '';
    if (exclude.length > 0) {
      values.push(exclude);
      excludeFilter = ` AND NOT (id = ANY($${values.length}::bigint[]))`;
    }
    const res = await uow.query<ClaimedRow>(
      `SELECT id, job_type, ref_type, ref_id, version, retry_count, due_at
         FROM schedule.schedule_jobs
        WHERE status = 'PENDING' AND due_at <= now() AND next_retry_at <= now()
          AND ${typeFilter}${excludeFilter}
        ORDER BY due_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      values,
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      jobType: row.job_type as ScheduleJobType,
      refType: row.ref_type,
      refId: row.ref_id === null ? null : Number(row.ref_id),
      version: row.version,
      retryCount: row.retry_count,
      dueAt: new Date(row.due_at),
    };
  }

  /** 守卫状态迁移（状态禁裸写）+ 条件更新兜底乐观并发；setFiredAt=抢占时落首次触发时刻 */
  private async transition(
    uow: SqlExecutor,
    jobId: number,
    from: ScheduleJobStatus,
    to: ScheduleJobStatus,
    reason: string,
    setFiredAt = false,
  ): Promise<void> {
    await this.guard.assertTransition(SCHEDULE_JOB_MACHINE, {
      entityId: jobId,
      from,
      to,
      reason,
      jobId: String(jobId),
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE schedule.schedule_jobs
          SET status = $2::varchar,
              version = version + 1,
              fired_at = CASE WHEN $3 THEN COALESCE(fired_at, now()) ELSE fired_at END
        WHERE id = $1 AND status = $4::varchar
        RETURNING id`,
      [jobId, to, setFiredAt, from],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new AppError(
        ErrorCode.StateStaleEntity,
        `调度 job ${jobId} 已被并发迁移（${from}→${to}）`,
      );
    }
  }

  /** R-04：每次尝试（DONE/CANCELLED/RETRY/FAILED/NO_EXECUTOR）落 schedule_job_log */
  private async writeLog(
    uow: SqlExecutor,
    job: ClaimedJob,
    result: LogResult,
    detail: string | null,
    durationMs: number,
  ): Promise<void> {
    await uow.query(
      `INSERT INTO schedule.schedule_job_log (job_id, job_type, ref, result, detail, duration_ms)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        job.id,
        job.jobType,
        JSON.stringify({ ref_type: job.refType, ref_id: job.refId }),
        result,
        detail,
        Math.max(0, Math.trunc(durationMs)),
      ],
    );
  }

  private assertJobRef(jobType: ScheduleJobType, refType: string, refId: number): void {
    if (!isScheduleJobType(jobType)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `job_type 不在全集注册表（I2 §2/§4，25 种）：${JSON.stringify(jobType)}`,
      );
    }
    if (typeof refType !== 'string' || refType.length === 0 || refType.length > 16) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `ref_type 须为 1-16 字符（幂等键=type+ref）：${JSON.stringify(refType)}`,
      );
    }
    if (!Number.isInteger(refId) || refId <= 0) {
      throw new AppError(ErrorCode.InvalidArgument, `ref_id 须为正整数：${String(refId)}`);
    }
  }
}

function serializeResult(ret: Record<string, unknown> | void): string | null {
  return ret === undefined ? null : JSON.stringify(ret);
}
