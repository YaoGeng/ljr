/**
 * H4 资损巡检执行器（架构 §7.2 五类不变量，分钟级 RISK_PATROL job；M1-W4 Task 1）。
 *
 * 形态（⚠W4-2/4 裁决）：巡检执行器+违例台账落 ops 域（V34 两表）；检测 SQL 各域自持
 * （trade-enrollment/schedule-slot-lock/payment-split-ledgers/pricing-histories 检测件），
 * 跨域核对经既有导出接口应用层聚合（F1 findOrderByIdempotencyKey + F2 listByOrderId +
 * F4 hasTxnOfKindRef + I2 backlog + trade isTerminalBatch provider 注册表）——禁跨 schema
 * join，schema-refs 0 为门。调度=I2 schedule_jobs 分钟级 jobType（非独立 interval——DB 到期
 * 任务表唯一事实源纪律），SLOT_REAPER 同款周期自投。
 *
 * runOnce 两种事务形态：
 *   uow 形态（执行器路径）：开轮/检测入账/关轮与 job DONE 同事务（reaper 形态；RUNNING 态
 *     不可外见——崩溃整体回滚由 I2 退避重试重入，dedup 保证重入不重复入账）；
 *   直调形态（测试/运维）：三段事务——开轮（RUNNING 可观测）→ 检测+入账 → 关轮 DONE；
 *     轮级异常经独立事务关轮 FAILED（守卫拒绝留痕独立连接同款思想，best-effort）。
 * 单类失败不拖垮整轮：五类依序各 try/catch，类级错误记 checked_counts.err（简报逐字）。
 *
 * 幂等/噪音纪律（Review Focus①）：findings dedup 锚=同 kind+ref_type+ref_id 未处置
 * （ux_patrol_findings_open 部分唯一索引物理兜底，INSERT ON CONFLICT DO NOTHING）；同违例
 * 多轮巡检只在新入账时告警（在册未处置重复检出不重复 sink.send——台账已可查）。
 * ③类消费 I2 backlog()（只看 PENDING 逾期；NO_EXECUTOR→FAILED 属 JOB_FAILED 告警面非积压
 * 面，04 §8 #33 已知噪音不误入——backlog() 头注锚定）。
 *
 * 告警（⚠供应商位，W4 许可桩清单增量）：dev=MockPatrolAlertSink 内存+warn 日志、零外部调用
 * 零凭据；CRITICAL 新入账触发 sink.send，WARN=台账留痕；电话级/工单=M2+ 经同一 Sink 替换。
 * 告警在事务提交前发出（mock 零外部调用；真实供应商接入时移至提交后——scheduler-alerts/
 * slot-lock.alerts 同款注记）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { PointsService } from '../benefits/points.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { PaymentPatrolService } from '../payment/payment.patrol';
import { RefundService } from '../payment/refund.service';
import { PriceChangePatrolService } from '../pricing/price-change.patrol';
import { SchedulerService } from '../schedule/scheduler.service';
import { SlotLockPatrolService } from '../schedule/slot-lock.patrol';
import { EnrollmentPatrolService } from '../trade/enrollment.patrol';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { PATROL_ALERT_SINK, type PatrolAlertSink } from './patrol.alerts';
import { PATROL_CONFIG, type PatrolConfig } from './patrol.config';
import {
  PATROL_KINDS,
  PATROL_KIND_SEVERITY,
  type PatrolDetectionResult,
  type PatrolFindingCandidate,
  type PatrolKind,
  type PatrolKindStat,
  type PatrolRunSummary,
} from './patrol.types';

/** RISK_PATROL 自投的注册表键半边（refId=下一周期 dueAt 毫秒，递进键——SLOT_REAPER 同款） */
const PATROL_JOB_REF_TYPE = 'global';

/** F2 退款在途/已完成态（REQUESTED|PROCESSING=在途不算未发起；DONE=已退；FAILED=已发起但终局失败） */
const REFUND_LIVE_STATUSES: readonly string[] = ['REQUESTED', 'PROCESSING', 'DONE'];

/** ③类聚合 finding 的哨兵 ref（积压是队列级非单行级违例；V34 头注 ref_id=0 哨兵口径） */
const BACKLOG_REF_ID = 0;

interface RunRow {
  readonly id: string;
}

@Injectable()
export class PatrolService {
  private readonly logger = new Logger(PatrolService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly scheduler: SchedulerService,
    private readonly lockPatrol: SlotLockPatrolService,
    private readonly enrollmentPatrol: EnrollmentPatrolService,
    private readonly paymentPatrol: PaymentPatrolService,
    private readonly pricingPatrol: PriceChangePatrolService,
    private readonly refunds: RefundService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly points: PointsService,
    @Inject(PATROL_ALERT_SINK) private readonly sink: PatrolAlertSink,
    @Inject(PATROL_CONFIG) private readonly config: PatrolConfig,
  ) {}

  // ===========================================================================
  // runOnce（RISK_PATROL 执行器内核 / 直调入口）
  // ===========================================================================

  /** 一轮巡检：开 run 行 → 五类依序检测入账（dedup）→ 关 run 行（finding_count） */
  async runOnce(uow?: SqlExecutor): Promise<PatrolRunSummary> {
    if (uow !== undefined) {
      const runId = await this.openRun(uow);
      return this.executeRound(uow, runId); // 异常随调用方事务回滚（重入由 dedup 收敛）
    }
    const runId = await this.pool.withTransaction((tx) => this.openRun(tx));
    try {
      return await this.pool.withTransaction((tx) => this.executeRound(tx, runId));
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await this.pool
        .withTransaction((tx) =>
          tx.query(
            `UPDATE ops.patrol_runs
                SET status = 'FAILED', finished_at = now(),
                    checked_counts = checked_counts || $2::jsonb
              WHERE id = $1 AND status = 'RUNNING'`,
            [runId, JSON.stringify({ fatal: message.slice(0, 500) })],
          ),
        )
        .catch(() => undefined); // best-effort 关轮（连接级故障时留 RUNNING 行=崩溃窗可见）
      throw e;
    }
  }

  /** 五类依序检测+入账+关轮（exec=uow 或直调第二段事务） */
  private async executeRound(exec: SqlExecutor, runId: number): Promise<PatrolRunSummary> {
    const counts: Record<string, PatrolKindStat> = {};
    let findingCount = 0;
    for (const kind of PATROL_KINDS) {
      const stat = await this.runKind(exec, runId, kind);
      counts[kind] = stat;
      findingCount += stat.inserted;
    }
    await exec.query(
      `UPDATE ops.patrol_runs
          SET status = 'DONE', finished_at = now(), checked_counts = $2::jsonb, finding_count = $3
        WHERE id = $1`,
      [runId, JSON.stringify(counts), findingCount],
    );
    return { runId, status: 'DONE', findingCount, checkedCounts: counts };
  }

  /** 单类：检测 → 逐违例 dedup 入账 → 新入账 CRITICAL 告警；类级异常吞为 err 不拖垮整轮 */
  private async runKind(
    exec: SqlExecutor,
    runId: number,
    kind: PatrolKind,
  ): Promise<PatrolKindStat> {
    let result: PatrolDetectionResult;
    try {
      result = await this.detect(kind);
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.logger.warn(`资损巡检类 ${kind} 单类失败（不拖垮整轮）：${message}`);
      return { checked: 0, findings: 0, inserted: 0, err: message.slice(0, 500) };
    }
    let inserted = 0;
    for (const finding of result.findings) {
      const isNew = await this.insertFinding(exec, runId, finding);
      if (!isNew) continue; // 在册未处置重复检出：dedup 短路，不重复告警
      inserted += 1;
      if (finding.severity === 'CRITICAL') {
        await this.alert(finding);
      }
    }
    return { checked: result.checked, findings: result.findings.length, inserted };
  }

  /** 检测分派（五类依序；类内逻辑见各分支头注） */
  private async detect(kind: PatrolKind): Promise<PatrolDetectionResult> {
    switch (kind) {
      case 'PAID_NOT_REFUNDED':
        return this.detectPaidNotRefunded();
      case 'STALE_LOCK':
        return this.detectStaleLocks();
      case 'SCHED_BACKLOG':
        return this.detectBacklog();
      case 'SPLIT_UNCONFIRMED':
        return this.detectSplitUnconfirmed();
      case 'COMPENSATION_UNPAID':
        return this.detectCompensationUnpaid();
    }
  }

  // --------------------------------------------------------------------------
  // 五类检测体（跨域核对全部经导出接口应用层聚合——禁跨 schema join）
  // --------------------------------------------------------------------------

  /**
   * ① PAID_NOT_REFUNDED：trade 候选集 → 逐单经 F1 幂等键定位支付单 → F2 退款单核对。
   * 在途（REQUESTED|PROCESSING）/已完成（DONE）不算未发起；仅 FAILED 终局退款=资损未消除
   * 仍检出（reason=REFUND_ALL_FAILED）；支付单不可读=数据漂移显性化（reason=ORDER_MISSING）。
   *
   * 孤儿窗口径注记（M2-W3 T5，I-1 接线后复核——只更新口径不改判定/阈值）：拒绝/超时两路
   * （C2 12h 确认超时自动拒+C4 律师显式拒同 topic）现均有 F2 全额退款消费收敛（T1）+PENDING
   * 冻结积分 sweep 收敛（T5 createLawyerRejectedSweepHandler）——「终态后 PAID 无人退」的
   * 孤儿窗收窄为「事件出箱后 relay 未投递」段（退避重试轨道内自然收敛，巡检 10min 阈值
   * paidNotRefundedMs 覆盖的剩余语义=投递滞后告警而非消费缺位）；判定 SQL 与阈值不动。
   */
  private async detectPaidNotRefunded(): Promise<PatrolDetectionResult> {
    const candidates = await this.enrollmentPatrol.findRefundDueCandidates({
      windowMs: this.config.paidNotRefundedMs,
    });
    const findings: PatrolFindingCandidate[] = [];
    for (const c of candidates) {
      const order = await this.paymentGateway.findOrderByIdempotencyKey(
        enrollmentOrderKey(c.enrollmentId),
      );
      let reason: string;
      if (!order) {
        reason = 'ORDER_MISSING';
      } else {
        const refunds = await this.refunds.listByOrderId(order.id);
        const hasLive = refunds.some((r) => REFUND_LIVE_STATUSES.includes(r.status));
        reason = hasLive ? '' : refunds.length > 0 ? 'REFUND_ALL_FAILED' : 'NO_REFUND_INITIATED';
      }
      if (reason === '') continue;
      findings.push({
        kind: 'PAID_NOT_REFUNDED',
        refType: 'enrollment',
        refId: c.enrollmentId,
        severity: PATROL_KIND_SEVERITY.PAID_NOT_REFUNDED,
        detail: {
          reason,
          ref: { type: c.refType, id: c.refId },
          user_id: c.userId,
          paid_amount: c.paidAmount,
          entity_status: c.entityStatus,
          terminal_since: c.terminalSince,
          order_id: order?.id ?? null,
        },
      });
    }
    return { checked: candidates.length, findings };
  }

  /** ② STALE_LOCK：schedule 侧三谓词扫描（SLOT_PAST/TTL_PAST/ENTITY_TERMINAL），一锁一 finding */
  private async detectStaleLocks(): Promise<PatrolDetectionResult> {
    const scan = await this.lockPatrol.findStaleLocks({ windowMs: this.config.staleLockMs });
    return {
      checked: scan.checked,
      findings: scan.violations.map((v) => ({
        kind: 'STALE_LOCK' as const,
        refType: 'slot_lock',
        refId: v.lockId,
        severity: PATROL_KIND_SEVERITY.STALE_LOCK,
        detail: {
          reasons: v.reasons,
          lawyer_id: v.lawyerId,
          lock_status: v.status,
          ref: { type: v.refType, id: v.refId },
          slot_start: v.slotStart,
          created_at: v.createdAt,
          skipped_no_provider: scan.skippedNoProvider,
        },
      })),
    };
  }

  /**
   * ③ SCHED_BACKLOG：消费 I2 backlog()（只看 PENDING 逾期；阈值事实源=SchedulerConfig.
   * backlogAlertMs）。violation=积压非空且最老逾期 ≥ 本侧 backlogMs 对齐位（两键相等时与
   * backlog() 原语义逐字一致——见 patrol.config 头注）。
   */
  private async detectBacklog(): Promise<PatrolDetectionResult> {
    const stats = await this.scheduler.backlog();
    const oldestMs = stats.oldestOverdueSeconds === null ? null : stats.oldestOverdueSeconds * 1000;
    if (stats.overdueJobs === 0 || oldestMs === null || oldestMs < this.config.backlogMs) {
      return { checked: 1, findings: [] };
    }
    return {
      checked: 1,
      findings: [
        {
          kind: 'SCHED_BACKLOG',
          refType: 'schedule_jobs',
          refId: BACKLOG_REF_ID,
          severity: PATROL_KIND_SEVERITY.SCHED_BACKLOG,
          detail: {
            overdue_jobs: stats.overdueJobs,
            oldest_overdue_seconds: stats.oldestOverdueSeconds,
            threshold_ms: this.config.backlogMs,
          },
        },
      ],
    };
  }

  /** ④ SPLIT_UNCONFIRMED：payment 侧 ISSUED 超窗指令集，一指令一 finding */
  private async detectSplitUnconfirmed(): Promise<PatrolDetectionResult> {
    const rows = await this.paymentPatrol.findUnconfirmedSplits({
      windowMs: this.config.splitUnconfirmedMs,
    });
    return {
      checked: rows.length,
      findings: rows.map((r) => ({
        kind: 'SPLIT_UNCONFIRMED' as const,
        refType: 'split_ledger',
        refId: r.ledgerId,
        severity: PATROL_KIND_SEVERITY.SPLIT_UNCONFIRMED,
        detail: {
          period: r.period,
          channel: r.channel,
          direction: r.direction,
          amount: r.amount,
          idempotency_key: r.idempotencyKey,
          created_at: r.createdAt,
        },
      })),
    };
  }

  /**
   * ⑤ COMPENSATION_UNPAID：pricing 候选集 → 逐行经 F4 hasTxnOfKindRef 核对补偿授予流水
   * （ref=price_change:{id}）。零发放行需人工核对（「应发」快照未持久化的假阳边界，见
   * price-change.patrol 头注 ⚠注记）。
   */
  private async detectCompensationUnpaid(): Promise<PatrolDetectionResult> {
    const candidates = await this.pricingPatrol.findUnpaidCompensationCandidates({
      windowMs: this.config.compensationUnpaidMs,
    });
    const findings: PatrolFindingCandidate[] = [];
    for (const c of candidates) {
      const granted = await this.points.hasTxnOfKindRef(
        'COMPENSATION',
        `price_change:${c.historyId}`,
      );
      if (granted) continue;
      findings.push({
        kind: 'COMPENSATION_UNPAID',
        refType: 'pricing_history',
        refId: c.historyId,
        severity: PATROL_KIND_SEVERITY.COMPENSATION_UNPAID,
        detail: {
          lawyer_id: c.lawyerId,
          direction: c.direction,
          has_active_group: c.hasActiveGroup,
          created_at: c.createdAt,
        },
      });
    }
    return { checked: candidates.length, findings };
  }

  // ===========================================================================
  // 台账与告警
  // ===========================================================================

  /** 开 run 行（RUNNING） */
  private async openRun(exec: SqlExecutor): Promise<number> {
    const res = await exec.query<RunRow>(
      `INSERT INTO ops.patrol_runs (status) VALUES ('RUNNING') RETURNING id`,
    );
    return Number(res.rows[0]!.id);
  }

  /** dedup 入账（ux_patrol_findings_open 冲突短路）；返回是否新入账 */
  private async insertFinding(
    exec: SqlExecutor,
    runId: number,
    finding: PatrolFindingCandidate,
  ): Promise<boolean> {
    const res = await exec.query<{ id: string }>(
      `INSERT INTO ops.patrol_findings (run_id, kind, ref_type, ref_id, severity, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (kind, ref_type, ref_id) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      [
        runId,
        finding.kind,
        finding.refType,
        finding.refId,
        finding.severity,
        JSON.stringify(finding.detail),
      ],
    );
    return res.rows.length > 0;
  }

  /** CRITICAL 新入账告警（dev=mock sink；WARN 级=台账留痕由 runKind 分流） */
  private async alert(finding: PatrolFindingCandidate): Promise<void> {
    const message = `资损巡检违例（${finding.kind} ${finding.refType}#${finding.refId}）：${JSON.stringify(finding.detail)}`;
    this.logger.warn(`[PATROL-CRITICAL] ${message}`);
    await this.sink
      .send({
        kind: finding.kind,
        severity: finding.severity,
        refType: finding.refType,
        refId: finding.refId,
        message,
      })
      .catch(() => undefined); // sink 失败不影响巡检主流程（tick 告警同款口径）
  }

  // ===========================================================================
  // RISK_PATROL 周期自投（SLOT_REAPER ensureReaperJob 同语义；main.ts 引导 + 执行器自续）
  // ===========================================================================

  /**
   * 幂等注册下一周期 RISK_PATROL（全局 advisory 锁串行化「查在册 PENDING→注册」防多节点
   * 分叉翻倍；已注册则幂等跳过）。excludeJobId：执行器自投时排除当前轮（其 RUNNING 推进
   * 未提交，独立事务仍视其为 PENDING——不排除会误判已注册而断链）。
   */
  async ensureScheduled(options?: {
    readonly now?: Date;
    readonly excludeJobId?: number;
  }): Promise<{ jobId: number; registered: boolean }> {
    const now = options?.now ?? new Date();
    const dueAt = new Date(now.getTime() + this.config.intervalMs);
    return this.pool.withTransaction((uow) =>
      this.ensureScheduledInTx(uow, dueAt, options?.excludeJobId),
    );
  }

  private async ensureScheduledInTx(
    uow: SqlExecutor,
    dueAt: Date,
    excludeJobId?: number,
  ): Promise<{ jobId: number; registered: boolean }> {
    await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ljr:risk_patrol_sched']);
    const existing = await this.scheduler.findPendingJobId(uow, 'RISK_PATROL', excludeJobId);
    if (existing !== null) return { jobId: existing, registered: false };
    const reg = await this.scheduler.registerJob(uow, {
      jobType: 'RISK_PATROL',
      refType: PATROL_JOB_REF_TYPE,
      refId: dueAt.getTime(),
      dueAt,
    });
    return { jobId: reg.jobId, registered: !reg.deduplicated };
  }
}
