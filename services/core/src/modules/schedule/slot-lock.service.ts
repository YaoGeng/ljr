/**
 * B2 时间段占用锁服务（机制核心，§5 内部机制 API——不暴露 HTTP）：LOCK_SLOT / CONFIRM_PAYMENT /
 * RELEASE_SLOT / START_OCCUPY + TTL 释放 + reaper 扫描 + SLOT_REAPER 周期自投。
 *
 * 事务形态（R-02，与 I2 registerJob(uow,…) 同款）：机制方法首参接收调用方业务事务句柄 uow，
 * 锁写入/状态迁移/领域事件与业务写同 commit/rollback——调用方在自己的业务事务内调用，
 * 崩溃注入（业务回滚）时锁写入一并回滚、无残留（测试见 slot-lock.spec）。
 *
 * 并发正确性（R-01/R-03）：
 *   - 唯一性防线=ux_slot_active 部分唯一索引（PENDING_PAYMENT 纳入覆盖），DB 是唯一事实源；
 *     INSERT 23505 冲突映射 SLOT_TAKEN（§8 写 23000，PG 实际 SQLSTATE=23505，以实现为准）。
 *   - 滥用计数（每用户同律师 ≤1、全局 ≤3）在同事务内按 ix_slot_user 口径计数，并以事务级
 *     advisory 锁按发起人串行化（hashtext 键空间；计数→插入无 TOCTOU 窗口；V4 verify_code_sends
 *     行级 advisory lock 同款先例）。Redis 前置锁仅性能优化位（R-01），本批次不引入（Ruling-3）。
 *
 * TTL（R-03）：LOCK_SLOT 带 payment_order_id ⇒ 同事务 registerJob(SLOT_TTL, ref='slot_lock'+lockId,
 * dueAt=ttl_at)；执行器回查（锁仍 PENDING_PAYMENT 且 ttl_at 已过→释放）见 slot-lock.executors。
 * 新锁新键（type+ref 含 lockId），不触 I2 契约注记①的改期刷新问题。
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { SchedulerService } from './scheduler.service';
import type { SlotLockAlert, SlotLockAlertReason } from './slot-lock.alerts';
import { SlotLockAlertService } from './slot-lock.alerts';
import { SLOT_LOCK_CONFIG, type SlotLockConfig } from './slot-lock.config';
import {
  SLOT_ABUSE_DETECTED_TOPIC,
  SLOT_LOCKED_TOPIC,
  SLOT_RELEASED_TOPIC,
  SLOT_TTL_EXPIRED_TOPIC,
} from './slot-lock.events';
import { SLOT_LOCK_MACHINE } from './slot-lock.machine';
import { TerminalStateRegistry } from './slot-lock.terminal-registry';
import type {
  ConfirmPaymentResult,
  EntityTerminalInfo,
  LockSlotInput,
  LockSlotResult,
  ReleaseSlotInput,
  ReleaseSlotResult,
  SlotLockRefType,
  SlotLockStatus,
  StartOccupyResult,
  TerminalStateProvider,
} from './slot-lock.types';
import { SLOT_LOCK_REF_TYPES } from './slot-lock.types';

/** 进行中（占段）状态集：ux_slot_active / ix_slot_user 的部分索引谓词同款 */
const ACTIVE_STATUSES_SQL = `'PENDING_PAYMENT', 'LOCKED', 'OCCUPIED'`;

/** R-03 计数集（R-W3-F 收窄）：仅 PENDING_PAYMENT——B2 §2/R-03 明文滥用防护=C2B 发布锁（发布即锁
 *  绑支付单）；LOCKED（B2C 创建即锁/C5 改期）/OCCUPIED（履约中）不占滥用额度，律师连开多团不受限
 *  （B2C 频控归属=R-W3-H：不设上限，B1 自然边界+G1 BAN_PUBLISH 滥用闸，待澄清备查）。 */
const COUNTED_STATUSES_SQL = `'PENDING_PAYMENT'`;

/** R-03 计数上限（业务规则非可调参数：每用户同律师进行中待支付锁 ≤1、全局 ≤3） */
const PER_LAWYER_LIMIT = 1;
const GLOBAL_LIMIT = 3;

/** SLOT_TTL job 的幂等键 ref 半边（ref_id=lockId；新锁新键） */
export const SLOT_TTL_JOB_REF_TYPE = 'slot_lock';

interface LockRowCore {
  readonly id: string;
  readonly lawyer_id: string;
  readonly slot_start: Date;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly status: SlotLockStatus;
}

export interface ReaperResult {
  /** PENDING_PAYMENT ttl 过期残留被兜底释放数（TTL job 丢失/失败的最后一道防线） */
  readonly pendingPaymentRescued: number;
  /** LOCKED/OCCUPIED 关联实体终态超阈残留被强制释放数 */
  readonly staleReleased: number;
  /** P2 全量扫描的 LOCKED/OCCUPIED 行数（观测位） */
  readonly scannedActive: number;
  /** P2 缺 provider 注册而跳过的行数（漏放方向——业务方未落位；经执行器结果落 job log，不静默） */
  readonly skippedNoProvider: number;
  /** P2 provider 异常/单行毒锁被隔离跳过的行数（跳过不炸轮——宁漏不误杀，warn 级观测位） */
  readonly skippedErrored: number;
}

@Injectable()
export class SlotLockService {
  readonly config: SlotLockConfig;

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly scheduler: SchedulerService,
    private readonly terminals: TerminalStateRegistry,
    private readonly alerts: SlotLockAlertService,
    // 纯 interface 无运行时类型 token，须经 SLOT_LOCK_CONFIG Symbol 注入（module useFactory 装配；
    // 缺 provider 即 DI 报错 fail-fast——不做 Optional 静默回落，避免 env 断链无声失效）
    @Inject(SLOT_LOCK_CONFIG) config: SlotLockConfig,
  ) {
    this.config = config;
  }

  // ---------- §5 LOCK_SLOT ----------

  /**
   * LOCK_SLOT：与业务实体同事务执行（uow=调用方业务事务）。初始态：带 paymentOrderId ⇒
   * PENDING_PAYMENT（+ttl_at +同事务 SLOT_TTL job）；缺省 ⇒ LOCKED（C1 创建即锁/C5 改期新段）。
   * 拒绝语义见 LockSlotResult：SLOT_TAKEN 时事务已被 23505 污染（调用方只能 ROLLBACK）；
   * SLOT_ABUSE_LIMIT 时锁行未写入，调用方应回滚业务写（SlotAbuseDetected 经独立连接落 outbox，
   * 不随调用方回滚丢失——守卫拒绝留痕同款口径）。滥用计数锚=R-W3-F 收窄：仅 PENDING_PAYMENT
   * （C2B 专属触发；B2C 创建即锁 LOCKED 不计数，B2C 频控=R-W3-H 不设上限，B1 自然边界+G1 闸）。
   */
  async lockSlot(uow: SqlExecutor, input: LockSlotInput): Promise<LockSlotResult> {
    this.assertLockInput(input);
    // R-03 计数并发安全：同发起人事务级 advisory 锁串行化（hashtext 键空间；不同用户互不阻塞；
    // 锁在事务提交/回滚时自动释放，无手工解锁面）
    await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `ljr:slot_lock_abuse:${String(input.initiatorUserId)}`,
    ]);
    // R-03 第一重：每用户对同律师进行中待支付锁 ≤1（R-W3-F：计数集=仅 PENDING_PAYMENT，C2B 滥用防护口径）
    const perLawyer = await uow.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks
        WHERE initiator_user_id = $1 AND lawyer_id = $2 AND status IN (${COUNTED_STATUSES_SQL})`,
      [input.initiatorUserId, input.lawyerId],
    );
    if ((perLawyer.rows[0]?.n ?? 0) >= PER_LAWYER_LIMIT) {
      await this.recordAbuse(input, 'PER_LAWYER');
      return { ok: false, reason: 'SLOT_ABUSE_LIMIT' };
    }
    // R-03 第二重：全局 ≤3（同上计数集）
    const global = await uow.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks
        WHERE initiator_user_id = $1 AND status IN (${COUNTED_STATUSES_SQL})`,
      [input.initiatorUserId],
    );
    if ((global.rows[0]?.n ?? 0) >= GLOBAL_LIMIT) {
      await this.recordAbuse(input, 'GLOBAL');
      return { ok: false, reason: 'SLOT_ABUSE_LIMIT' };
    }

    const status: SlotLockStatus =
      input.paymentOrderId !== undefined ? 'PENDING_PAYMENT' : 'LOCKED';
    const ttlAt = status === 'PENDING_PAYMENT' ? new Date(Date.now() + this.config.ttlMs) : null;
    let lockId: number;
    try {
      // R-01 物理防线：ux_slot_active 部分唯一索引（创建态恒为活跃态，必受唯一覆盖）
      const res = await uow.query<{ id: string }>(
        `INSERT INTO schedule.slot_locks
           (lawyer_id, slot_start, status, ref_type, ref_id, initiator_user_id, payment_order_id, ttl_at)
         VALUES ($1, $2, $3::varchar, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.lawyerId,
          input.slotStart,
          status,
          input.refType,
          input.refId,
          input.initiatorUserId,
          input.paymentOrderId ?? null,
          ttlAt,
        ],
      );
      const inserted = res.rows[0];
      if (!inserted) throw new AppError(ErrorCode.InternalError, '占用锁插入失败（不应触达）');
      lockId = Number(inserted.id);
    } catch (e) {
      if (isUniqueViolationOf(e, 'ux_slot_active')) {
        // §8 唯一索引冲突 → SLOT_TAKEN（文档写 23000；PG 实际 SQLSTATE=23505，以实现为准）
        return { ok: false, reason: 'SLOT_TAKEN' };
      }
      throw e;
    }

    // R-03 TTL：PENDING_PAYMENT 同事务注册 SLOT_TTL job（dueAt=ttl_at；I2 registerJob(uow,…)）
    if (status === 'PENDING_PAYMENT' && ttlAt !== null) {
      await this.scheduler.registerJob(uow, {
        jobType: 'SLOT_TTL',
        refType: SLOT_TTL_JOB_REF_TYPE,
        refId: lockId,
        dueAt: ttlAt,
      });
    }
    // §6：SlotLocked 与锁写入同事务（业务回滚则事件不出）
    await this.outbox.recordOutbox(uow, {
      type: SLOT_LOCKED_TOPIC,
      payload: {
        lock_id: lockId,
        lawyer_id: input.lawyerId,
        slot_start: input.slotStart.toISOString(),
        ref: { ref_type: input.refType, ref_id: input.refId },
        status,
      },
    });
    return { ok: true, lockId, status };
  }

  // ---------- §5 CONFIRM_PAYMENT ----------

  /** CONFIRM_PAYMENT(payment_order_id)：支付回调事务内调用；重复回调幂等短路（transitioned=false） */
  async confirmPayment(uow: SqlExecutor, paymentOrderId: number): Promise<ConfirmPaymentResult> {
    assertPositiveInt(paymentOrderId, 'paymentOrderId');
    const res = await uow.query<{ id: string; status: SlotLockStatus }>(
      `SELECT id, status FROM schedule.slot_locks
        WHERE payment_order_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [paymentOrderId],
    );
    const row = res.rows[0];
    // 无锁行，或锁已 RELEASED（退款/取消后迟到的回调）⇒ 无可确认对象
    if (!row || row.status === 'RELEASED') return { ok: false, reason: 'NOT_FOUND' };
    const lockId = Number(row.id);
    if (row.status !== 'PENDING_PAYMENT') {
      // LOCKED|OCCUPIED：支付早已体现，回调重放幂等短路
      return { ok: true, lockId, transitioned: false };
    }
    // I2 契约注记②：取消 job 之外同时落业务终态（此处即状态迁移，双保险）
    await this.scheduler.cancelJob(uow, {
      jobType: 'SLOT_TTL',
      refType: SLOT_TTL_JOB_REF_TYPE,
      refId: lockId,
    });
    await this.transition(uow, lockId, 'PENDING_PAYMENT', 'LOCKED', 'confirm_payment');
    return { ok: true, lockId, transitioned: true };
  }

  // ---------- START_OCCUPY（§2/§4：LOCKED→OCCUPIED，开房） ----------

  /**
   * START_OCCUPY(lock_id)：开房迁移。已 OCCUPIED ⇒ 幂等短路 transitioned=false（W3 开房 job
   * 重试/回调重放不抛不留痕，对齐 CONFIRM_PAYMENT 口径——重放不得毒化调用方业务事务）；
   * 非 LOCKED 且非重放（PENDING_PAYMENT 未支付/已 RELEASED）⇒ 守卫拒绝（AppError
   * StateIllegalTransition，拒绝留痕走独立连接不随业务回滚）；无行 ⇒ NOT_FOUND。
   */
  async startOccupy(uow: SqlExecutor, lockId: number): Promise<StartOccupyResult> {
    assertPositiveInt(lockId, 'lockId');
    const res = await uow.query<{ status: SlotLockStatus }>(
      `SELECT status FROM schedule.slot_locks WHERE id = $1 FOR UPDATE`,
      [lockId],
    );
    const row = res.rows[0];
    if (!row) return { ok: false, reason: 'NOT_FOUND' };
    if (row.status === 'OCCUPIED') {
      // 开房重放：幂等短路（不抛、无拒绝留痕、调用方事务不受污染）
      return { ok: true, lockId, transitioned: false };
    }
    await this.transition(uow, lockId, row.status, 'OCCUPIED', 'start_occupy');
    return { ok: true, lockId, transitioned: true };
  }

  // ---------- §5 RELEASE_SLOT ----------

  /**
   * RELEASE_SLOT(ref_type, ref_id, reason)：幂等（已释放 ⇒ ALREADY_RELEASED）；与业务终态同事务
   * （调用方在业务终态迁移的同一 uow 内调用）。PENDING_PAYMENT 释放时同步取消其 SLOT_TTL job
   * （I2 注记②）；该 ref 从无锁行 ⇒ NOT_FOUND（异常显性化，§5 未定义此态，报告注明）。
   */
  async releaseSlot(uow: SqlExecutor, input: ReleaseSlotInput): Promise<ReleaseSlotResult> {
    assertRefType(input.refType);
    assertPositiveInt(input.refId, 'refId');
    assertReason(input.reason);
    const res = await uow.query<LockRowCore>(
      `SELECT id, lawyer_id, slot_start, ref_type, ref_id, status FROM schedule.slot_locks
        WHERE ref_type = $1 AND ref_id = $2 AND status IN (${ACTIVE_STATUSES_SQL})
        ORDER BY id FOR UPDATE`,
      [input.refType, input.refId],
    );
    const rows = res.rows;
    if (rows.length === 0) {
      const any = await uow.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM schedule.slot_locks WHERE ref_type = $1 AND ref_id = $2`,
        [input.refType, input.refId],
      );
      return {
        ok: false,
        reason: (any.rows[0]?.n ?? 0) > 0 ? 'ALREADY_RELEASED' : 'NOT_FOUND',
      };
    }
    let firstLockId = 0;
    for (const row of rows) {
      const lockId = Number(row.id);
      if (row.status === 'PENDING_PAYMENT') {
        await this.scheduler.cancelJob(uow, {
          jobType: 'SLOT_TTL',
          refType: SLOT_TTL_JOB_REF_TYPE,
          refId: lockId,
        });
      }
      await this.transition(uow, lockId, row.status, 'RELEASED', input.reason);
      await this.emitReleased(uow, row, input.reason);
      if (firstLockId === 0) firstLockId = lockId;
    }
    return { ok: true, lockId: firstLockId };
  }

  // ---------- TTL 释放（SLOT_TTL 执行器与 reaper 共用的机制路径） ----------

  /**
   * 释放一把到期的 PENDING_PAYMENT 锁（行锁重验 status+ttl_at；发 SlotTtlExpired + SlotReleased）。
   * 行不存在/已非 PENDING_PAYMENT/ttl 未到（时钟差兜底）⇒ released=false（回查路径各自兜底）。
   */
  async releaseExpiredTtl(
    uow: SqlExecutor,
    lockId: number,
  ): Promise<{ released: boolean; lockId: number }> {
    assertPositiveInt(lockId, 'lockId');
    const res = await uow.query<LockRowCore>(
      `SELECT id, lawyer_id, slot_start, ref_type, ref_id, status FROM schedule.slot_locks
        WHERE id = $1 AND status = 'PENDING_PAYMENT' AND ttl_at <= now()
        ORDER BY id FOR UPDATE`,
      [lockId],
    );
    const row = res.rows[0];
    if (!row) return { released: false, lockId };
    await this.transition(uow, lockId, 'PENDING_PAYMENT', 'RELEASED', 'ttl_expired');
    const ref = { ref_type: row.ref_type, ref_id: Number(row.ref_id) };
    await this.outbox.recordOutbox(uow, {
      type: SLOT_TTL_EXPIRED_TOPIC,
      payload: {
        lock_id: lockId,
        lawyer_id: Number(row.lawyer_id),
        slot_start: new Date(row.slot_start).toISOString(),
        ref,
      },
    });
    await this.emitReleased(uow, row, 'TTL_EXPIRED');
    return { released: true, lockId };
  }

  // ---------- reaper（R-04；由 SLOT_REAPER 周期 job 驱动，见 slot-lock.executors） ----------

  /**
   * 单轮扫描（在执行器抢占事务内执行，效果与 job DONE 同事务）：
   *   P1：PENDING_PAYMENT 且 ttl_at 已过（ix_slot_ttl 部分索引）——TTL job 失效兜底，
   *       释放 + SlotTtlExpired + SlotReleased(TTL_EXPIRED) + 告警；
   *   P2：LOCKED/OCCUPIED 全量扫描（V1 活跃锁 ≤万级预算可接受，量级增长后补 created_at 部分索引）
   *       经 provider 注册表判实体终态，超阈（config.staleMs，默认 15min）→ 强制释放 + 告警。
   *
   * P2 韧性（评审修复：单行/单 provider 故障不得炸整轮——整轮回滚会连坐本轮其余释放与自投）：
   *   - 终态判定每 ref_type 一次批量调用（isTerminalBatch；未实现回退逐行）；
   *   - provider 整体抛错 → 该类型本轮跳过 + skipped_errored 计数（宁漏不误杀）；
   *   - 迁移前行锁重读+状态重验（照 releaseExpiredTtl 同款）：扫描与迁移之间被业务并发释放
   *     → 良性 skip，不再以 StateStaleEntity 炸轮；
   *   - 单行处置仍包 per-lock try/catch：残余异常跳过该行 + 计数，隔离毒锁。
   * ⚠ 告警在提交前发出（mock 适配器零外部调用）；真实供应商接入时移至提交后（接口留位）。
   */
  async reapOnce(uow: SqlExecutor, now: Date = new Date()): Promise<ReaperResult> {
    let pendingPaymentRescued = 0;
    const pp = await uow.query<{ id: string }>(
      `SELECT id FROM schedule.slot_locks
        WHERE status = 'PENDING_PAYMENT' AND ttl_at < now()
        ORDER BY id`,
    );
    for (const row of pp.rows) {
      const lockId = Number(row.id);
      const r = await this.releaseExpiredTtl(uow, lockId);
      if (r.released) {
        pendingPaymentRescued += 1;
        await this.alertLeak(uow, lockId, 'TTL_EXPIRED_BACKSTOP');
      }
    }

    let staleReleased = 0;
    let skippedNoProvider = 0;
    let skippedErrored = 0;
    const active = await uow.query<LockRowCore>(
      `SELECT id, lawyer_id, slot_start, ref_type, ref_id, status FROM schedule.slot_locks
        WHERE status IN ('LOCKED', 'OCCUPIED')
        ORDER BY id`,
    );
    // 按 ref_type 分组：每轮对每 provider 至多一次批量终态判定（防逐行 N+1）
    for (const refType of SLOT_LOCK_REF_TYPES) {
      const rows = active.rows.filter((r) => r.ref_type === refType);
      if (rows.length === 0) continue;
      const provider = this.terminals.get(refType);
      if (!provider) {
        // 缺 provider（业务方未落位）：跳过（漏放方向），计数暴露不静默
        skippedNoProvider += rows.length;
        continue;
      }
      let infos: Map<number, EntityTerminalInfo | null>;
      try {
        infos = await this.resolveTerminalInfos(
          provider,
          rows.map((r) => Number(r.ref_id)),
        );
      } catch {
        // provider 整体异常（毒 provider）：该类型本轮全跳过，计数隔离，不炸轮
        skippedErrored += rows.length;
        continue;
      }
      for (const row of rows) {
        const lockId = Number(row.id);
        try {
          const info = infos.get(Number(row.ref_id)) ?? null;
          if (!info?.terminal || info.since === null) continue;
          if (now.getTime() - info.since.getTime() <= this.config.staleMs) continue; // 未超阈
          // 行锁重读+状态重验：扫描后已被业务并发确认/释放 → 良性 skip（不炸轮）
          const fresh = await this.rereadActiveForUpdate(uow, lockId);
          if (!fresh || fresh.status !== row.status) continue;
          await this.transition(uow, lockId, fresh.status, 'RELEASED', 'entity_terminated');
          await this.emitReleased(uow, fresh, 'ENTITY_TERMINATED');
          staleReleased += 1;
          await this.alertLeak(uow, lockId, 'ENTITY_TERMINATED');
        } catch {
          // per-lock 毒锁隔离：残余异常（StateStaleEntity/outbox 等）跳过该行+计数，不影响其余行
          skippedErrored += 1;
        }
      }
    }
    return {
      pendingPaymentRescued,
      staleReleased,
      scannedActive: active.rows.length,
      skippedNoProvider,
      skippedErrored,
    };
  }

  /**
   * SLOT_REAPER 周期自投/引导（⚠决策位：周期 job 自投下一周期，ADR-0003 + I2 catalog 裁决）。
   * 全局 advisory 锁串行化「查在册 PENDING→注册」防多节点分叉（多把在册会逐代翻倍）；已注册则
   * 幂等跳过。键=（SLOT_REAPER,'global',下一周期 dueAt 毫秒）——周期递进键不与在册 RUNNING 的
   * 当前轮冲突（同键会撞 I2 在册部分唯一索引被去重吞掉）。
   *
   * excludeJobId：在册检查排除指定 job（执行器经独立事务自投时，当前轮的 RUNNING 推进尚未提交，
   * 独立连接仍视其为 PENDING——不排除会把当前轮误判为「已注册」而跳过自投，节拍链断链）。
   */
  async ensureReaperJob(
    uow: SqlExecutor,
    dueAt: Date,
    excludeJobId?: number,
  ): Promise<{ jobId: number | null; registered: boolean }> {
    await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ljr:slot_reaper_sched']);
    const pending = await uow.query<{ id: string }>(
      `SELECT id FROM schedule.schedule_jobs
        WHERE job_type = 'SLOT_REAPER' AND status = 'PENDING' AND id <> $1 ORDER BY id LIMIT 1`,
      [excludeJobId ?? 0],
    );
    const existing = pending.rows[0];
    if (existing) return { jobId: Number(existing.id), registered: false };
    const reg = await this.scheduler.registerJob(uow, {
      jobType: 'SLOT_REAPER',
      refType: 'global',
      refId: dueAt.getTime(),
      dueAt,
    });
    return { jobId: reg.jobId, registered: true };
  }

  /**
   * 独立事务注册下一周期（自投解耦：与扫描/执行成败互不连坐——评审修复②③）。执行器传入
   * excludeJobId=当前轮 job；main.ts 引导/测试驱动不传（全量检查）。
   */
  async ensureReaperScheduled(options?: {
    now?: Date;
    excludeJobId?: number;
  }): Promise<{ jobId: number | null; registered: boolean }> {
    const now = options?.now ?? new Date();
    return this.pool.withTransaction((uow) =>
      this.ensureReaperJob(
        uow,
        new Date(now.getTime() + this.config.reaperIntervalMs),
        options?.excludeJobId,
      ),
    );
  }

  // ---------- 内部件 ----------

  /**
   * 终态批量判定：provider 实现批量形态则一次调用；否则逐行回退（TerminalStateProvider 契约，
   * 量级触发线：活跃锁上万且走回退形态即成 N+1，provider 落位时应实现 isTerminalBatch）。
   */
  private async resolveTerminalInfos(
    provider: TerminalStateProvider,
    refIds: number[],
  ): Promise<Map<number, EntityTerminalInfo | null>> {
    if (provider.isTerminalBatch) return provider.isTerminalBatch(refIds);
    const map = new Map<number, EntityTerminalInfo | null>();
    for (const refId of refIds) map.set(refId, await provider.isTerminal(refId));
    return map;
  }

  /**
   * P2 迁移前行锁重读（照 releaseExpiredTtl 同款）：FOR UPDATE + 活跃态重验。
   * 返回 null=行已消失/已被并发释放（良性竞态 → skip，宁漏不误杀）。
   */
  private async rereadActiveForUpdate(
    uow: SqlExecutor,
    lockId: number,
  ): Promise<LockRowCore | null> {
    const res = await uow.query<LockRowCore>(
      `SELECT id, lawyer_id, slot_start, ref_type, ref_id, status FROM schedule.slot_locks
        WHERE id = $1 AND status IN (${ACTIVE_STATUSES_SQL})
        ORDER BY id FOR UPDATE`,
      [lockId],
    );
    return res.rows[0] ?? null;
  }

  /** 守卫状态迁移（状态禁裸写）+ 条件更新兜底乐观并发（0 行=并发竞态） */
  private async transition(
    uow: SqlExecutor,
    lockId: number,
    from: SlotLockStatus,
    to: SlotLockStatus,
    reason: string,
  ): Promise<void> {
    await this.guard.assertTransition(SLOT_LOCK_MACHINE, {
      entityId: lockId,
      from,
      to,
      reason,
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE schedule.slot_locks SET status = $2::varchar
        WHERE id = $1 AND status = $3::varchar
        RETURNING id`,
      [lockId, to, from],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new AppError(
        ErrorCode.StateStaleEntity,
        `占用锁 ${lockId} 已被并发迁移（${from}→${to}）`,
      );
    }
  }

  private async emitReleased(uow: SqlExecutor, row: LockRowCore, reason: string): Promise<void> {
    await this.outbox.recordOutbox(uow, {
      type: SLOT_RELEASED_TOPIC,
      payload: {
        lock_id: Number(row.id),
        lawyer_id: Number(row.lawyer_id),
        slot_start: new Date(row.slot_start).toISOString(),
        ref: { ref_type: row.ref_type, ref_id: Number(row.ref_id) },
        reason,
      },
    });
  }

  /**
   * SlotAbuseDetected（→G1）：经独立连接落 outbox（不随调用方回滚丢失）——拒绝路径上调用方事务
   * 必然回滚，同事务事件会被一并吞掉；守卫「拒绝留痕走独立连接」同款口径（报告注明）。
   */
  private async recordAbuse(input: LockSlotInput, limit: 'PER_LAWYER' | 'GLOBAL'): Promise<void> {
    await this.outbox.recordOutbox(this.pool, {
      type: SLOT_ABUSE_DETECTED_TOPIC,
      payload: { user_id: input.initiatorUserId, lawyer_id: input.lawyerId, limit },
    });
  }

  private async alertLeak(
    uow: SqlExecutor,
    lockId: number,
    reason: SlotLockAlertReason,
  ): Promise<void> {
    const res = await uow.query<{ lawyer_id: string; ref_type: string; ref_id: string }>(
      `SELECT lawyer_id, ref_type, ref_id FROM schedule.slot_locks WHERE id = $1`,
      [lockId],
    );
    const row = res.rows[0];
    const alert: Omit<SlotLockAlert, 'message'> = {
      kind: 'LOCK_LEAK',
      lockId,
      lawyerId: Number(row?.lawyer_id ?? 0),
      refType: row?.ref_type ?? 'unknown',
      refId: Number(row?.ref_id ?? 0),
      reason,
    };
    await this.alerts.alertLockLeak(alert);
  }

  private assertLockInput(input: LockSlotInput): void {
    assertPositiveInt(input.lawyerId, 'lawyerId');
    assertPositiveInt(input.initiatorUserId, 'initiatorUserId');
    assertPositiveInt(input.refId, 'refId');
    assertRefType(input.refType);
    if (!(input.slotStart instanceof Date) || Number.isNaN(input.slotStart.getTime())) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `slotStart 须为有效 Date：${String(input.slotStart)}`,
      );
    }
    if (input.paymentOrderId !== undefined)
      assertPositiveInt(input.paymentOrderId, 'paymentOrderId');
  }
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${name} 须为正整数：${String(value)}`);
  }
}

function assertRefType(refType: SlotLockRefType): void {
  if (!(SLOT_LOCK_REF_TYPES as readonly string[]).includes(refType)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `ref_type 不在枚举（session|groupbuy|reschedule）：${JSON.stringify(refType)}`,
    );
  }
}

function assertReason(reason: string): void {
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 64) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `reason 须为 1-64 字符：${JSON.stringify(reason)}`,
    );
  }
}

/** 唯一索引冲突判定：pg 驱动 23505 + 约束名精确匹配（§8 写 23000 为 SQLSTATE 类笔误，以实现为准） */
function isUniqueViolationOf(e: unknown, constraint: string): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err !== null && err.code === '23505' && err.constraint === constraint;
}
