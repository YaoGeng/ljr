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
import { Injectable, Optional } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { SchedulerService } from './scheduler.service';
import type { SlotLockAlert, SlotLockAlertReason } from './slot-lock.alerts';
import { SlotLockAlertService } from './slot-lock.alerts';
import { SLOT_LOCK_DEFAULT_CONFIG, type SlotLockConfig } from './slot-lock.config';
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
  LockSlotInput,
  LockSlotResult,
  ReleaseSlotInput,
  ReleaseSlotResult,
  SlotLockRefType,
  SlotLockStatus,
  StartOccupyResult,
} from './slot-lock.types';
import { SLOT_LOCK_REF_TYPES } from './slot-lock.types';

/** 进行中（占段）状态集：ux_slot_active / ix_slot_user 的部分索引谓词同款 */
const ACTIVE_STATUSES_SQL = `'PENDING_PAYMENT', 'LOCKED', 'OCCUPIED'`;

/** R-03 计数上限（业务规则非可调参数：每用户对同律师进行中锁 ≤1、全局 ≤3） */
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
    @Optional() config?: SlotLockConfig,
  ) {
    this.config = config ?? SLOT_LOCK_DEFAULT_CONFIG;
  }

  // ---------- §5 LOCK_SLOT ----------

  /**
   * LOCK_SLOT：与业务实体同事务执行（uow=调用方业务事务）。初始态：带 paymentOrderId ⇒
   * PENDING_PAYMENT（+ttl_at +同事务 SLOT_TTL job）；缺省 ⇒ LOCKED（C1 创建即锁/C5 改期新段）。
   * 拒绝语义见 LockSlotResult：SLOT_TAKEN 时事务已被 23505 污染（调用方只能 ROLLBACK）；
   * SLOT_ABUSE_LIMIT 时锁行未写入，调用方应回滚业务写（SlotAbuseDetected 经独立连接落 outbox，
   * 不随调用方回滚丢失——守卫拒绝留痕同款口径）。
   */
  async lockSlot(uow: SqlExecutor, input: LockSlotInput): Promise<LockSlotResult> {
    this.assertLockInput(input);
    // R-03 计数并发安全：同发起人事务级 advisory 锁串行化（hashtext 键空间；不同用户互不阻塞；
    // 锁在事务提交/回滚时自动释放，无手工解锁面）
    await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `ljr:slot_lock_abuse:${String(input.initiatorUserId)}`,
    ]);
    // R-03 第一重：每用户对同律师进行中锁 ≤1（PENDING_PAYMENT 纳入计数，ix_slot_user 口径）
    const perLawyer = await uow.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks
        WHERE initiator_user_id = $1 AND lawyer_id = $2 AND status IN (${ACTIVE_STATUSES_SQL})`,
      [input.initiatorUserId, input.lawyerId],
    );
    if ((perLawyer.rows[0]?.n ?? 0) >= PER_LAWYER_LIMIT) {
      await this.recordAbuse(input, 'PER_LAWYER');
      return { ok: false, reason: 'SLOT_ABUSE_LIMIT' };
    }
    // R-03 第二重：全局 ≤3
    const global = await uow.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks
        WHERE initiator_user_id = $1 AND status IN (${ACTIVE_STATUSES_SQL})`,
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

  async startOccupy(uow: SqlExecutor, lockId: number): Promise<StartOccupyResult> {
    assertPositiveInt(lockId, 'lockId');
    const res = await uow.query<{ status: SlotLockStatus }>(
      `SELECT status FROM schedule.slot_locks WHERE id = $1 FOR UPDATE`,
      [lockId],
    );
    const row = res.rows[0];
    if (!row) return { ok: false, reason: 'NOT_FOUND' };
    // 非 LOCKED（含 PENDING_PAYMENT 未支付/已 RELEASED）⇒ 守卫拒绝（AppError StateIllegalTransition，
    // 拒绝留痕走独立连接不随业务回滚）
    await this.transition(uow, lockId, row.status, 'OCCUPIED', 'start_occupy');
    return { ok: true, lockId };
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
    const active = await uow.query<LockRowCore>(
      `SELECT id, lawyer_id, slot_start, ref_type, ref_id, status FROM schedule.slot_locks
        WHERE status IN ('LOCKED', 'OCCUPIED')
        ORDER BY id`,
    );
    for (const row of active.rows) {
      const provider = this.terminals.get(row.ref_type as SlotLockRefType);
      if (!provider) continue; // 无 provider（业务方未落位）：跳过，宁漏不误杀
      const info = await provider.isTerminal(Number(row.ref_id));
      if (!info?.terminal || info.since === null) continue;
      if (now.getTime() - info.since.getTime() <= this.config.staleMs) continue; // 未超阈
      const lockId = Number(row.id);
      await this.transition(uow, lockId, row.status, 'RELEASED', 'entity_terminated');
      await this.emitReleased(uow, row, 'ENTITY_TERMINATED');
      staleReleased += 1;
      await this.alertLeak(uow, lockId, 'ENTITY_TERMINATED');
    }
    return { pendingPaymentRescued, staleReleased, scannedActive: active.rows.length };
  }

  /**
   * SLOT_REAPER 周期自投/引导（⚠决策位：周期 job 自投下一周期，ADR-0003 + I2 catalog 裁决）。
   * 全局 advisory 锁串行化「查在册 PENDING→注册」防多节点分叉（多把在册会逐代翻倍）；已注册则
   * 幂等跳过。键=（SLOT_REAPER,'global',下一周期 dueAt 毫秒）——周期递进键不与在册 RUNNING 的
   * 当前轮冲突（同键会撞 I2 在册部分唯一索引被去重吞掉）。
   */
  async ensureReaperJob(
    uow: SqlExecutor,
    dueAt: Date,
  ): Promise<{ jobId: number | null; registered: boolean }> {
    await uow.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ljr:slot_reaper_sched']);
    const pending = await uow.query<{ id: string }>(
      `SELECT id FROM schedule.schedule_jobs
        WHERE job_type = 'SLOT_REAPER' AND status = 'PENDING' ORDER BY id LIMIT 1`,
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

  /** 进程引导（main.ts 调用；测试/嵌入场景可直接用 ensureReaperJob 注册过去时刻驱动首轮） */
  async ensureReaperScheduled(
    now: Date = new Date(),
  ): Promise<{ jobId: number | null; registered: boolean }> {
    return this.pool.withTransaction((uow) =>
      this.ensureReaperJob(uow, new Date(now.getTime() + this.config.reaperIntervalMs)),
    );
  }

  // ---------- 内部件 ----------

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
