import 'reflect-metadata';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { SqlExecutor } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { PgPoolService, pgConfigFromEnv } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { SchedulerService } from './scheduler.service';
import { MockSlotLockAlertSink, SlotLockAlertService } from './slot-lock.alerts';
import { SLOT_LOCK_DEFAULT_CONFIG, type SlotLockConfig } from './slot-lock.config';
import {
  SLOT_ABUSE_DETECTED_TOPIC,
  SLOT_LOCKED_TOPIC,
  SLOT_RELEASED_TOPIC,
  SLOT_TTL_EXPIRED_TOPIC,
} from './slot-lock.events';
import { SlotLockService } from './slot-lock.service';
import { SlotLockModule } from './slot-lock.module';
import { TerminalStateRegistry } from './slot-lock.terminal-registry';

/**
 * B2 时间段占用锁 e2e（需 PG）：§5 机制 API + R-01 部分唯一防线（100 并发压测）+
 * R-02 同事务语义（崩溃注入）+ R-03 滥用防护三重 + SLOT_TTL 到期释放（I2 联调）。
 * 形态照 scheduler.spec：Test 模块装配（执行器经 SlotLockModule onModuleInit 注册），
 * 调度 tick 手动驱动；TTL 用独立装配的快锁服务（ttlMs=200）避免真实等待。
 */

const LAWYER = 9001;
const SLOT = new Date('2026-11-06T10:00:00.000Z');

interface LockRow {
  id: string;
  lawyer_id: string;
  status: string;
  ref_type: string;
  ref_id: string;
  initiator_user_id: string;
  payment_order_id: string | null;
  ttl_at: Date | null;
}

describe('B2 时间段占用锁（机制 API，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: SlotLockService;
  let fastSvc: SlotLockService; // ttlMs=200 独立装配（TTL 用例确定性）
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let alerts: MockSlotLockAlertSink;

  const lockInput = (over: Partial<Parameters<SlotLockService['lockSlot']>[1]> = {}) => ({
    lawyerId: LAWYER,
    slotStart: SLOT,
    initiatorUserId: 501,
    refType: 'session' as const,
    refId: 7001,
    ...over,
  });

  const lockRow = async (lockId: number): Promise<LockRow | undefined> => {
    const res = await pool.query<LockRow>(
      `SELECT id, lawyer_id::text AS lawyer_id, status, ref_type, ref_id::text AS ref_id,
              initiator_user_id::text AS initiator_user_id, payment_order_id::text AS payment_order_id, ttl_at
         FROM schedule.slot_locks WHERE id = $1`,
      [lockId],
    );
    return res.rows[0];
  };

  const activeCount = async (lawyerId = LAWYER, slotStart = SLOT): Promise<number> => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks
        WHERE lawyer_id = $1 AND slot_start = $2 AND status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED')`,
      [lawyerId, slotStart],
    );
    return res.rows[0]?.n ?? 0;
  };

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows;
  };

  const stlOf = async (lockId: number) => {
    const res = await pool.query<{
      from_status: string | null;
      to_status: string;
      allowed: boolean;
    }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'slot_lock' AND entity_id = $1 ORDER BY id`,
      [lockId],
    );
    return res.rows;
  };

  /** 把某锁的 SLOT_TTL job 与 ttl_at 回拨到过去（确定性触发，免真实等待） */
  const backdateTtl = async (lockId: number): Promise<void> => {
    await pool.query(
      `UPDATE schedule.slot_locks SET ttl_at = now() - interval '1 second' WHERE id = $1`,
      [lockId],
    );
    await pool.query(
      `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1 second'
        WHERE job_type = 'SLOT_TTL' AND ref_type = 'slot_lock' AND ref_id = $1 AND status = 'PENDING'`,
      [lockId],
    );
  };

  const jobOf = async (lockId: number) => {
    const res = await pool.query<{ id: string; status: string; due_at: Date }>(
      `SELECT id, status, due_at FROM schedule.schedule_jobs
        WHERE job_type = 'SLOT_TTL' AND ref_type = 'slot_lock' AND ref_id = $1 ORDER BY id DESC LIMIT 1`,
      [lockId],
    );
    return res.rows[0];
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [SlotLockModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(SlotLockService);
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
    alerts = app.get(MockSlotLockAlertSink);
    fastSvc = new SlotLockService(
      poolSvc,
      app.get(OutboxService),
      app.get(StateTransitionGuardService),
      scheduler,
      app.get(TerminalStateRegistry),
      app.get(SlotLockAlertService),
      { ...SLOT_LOCK_DEFAULT_CONFIG, ttlMs: 200 } satisfies SlotLockConfig,
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    alerts.alerts.length = 0;
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------- LOCK_SLOT 基本路径 ----------

  it('LOCK_SLOT C1 创建即锁：无 payment_order_id ⇒ LOCKED；SlotLocked 同事务落 outbox', async () => {
    await poolSvc.withTransaction(async (uow) => {
      const r = await svc.lockSlot(uow, lockInput());
      expect(r).toMatchObject({ ok: true, status: 'LOCKED' });
      expect(r.ok && r.lockId).toBeGreaterThan(0);
    });
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks`,
    );
    expect(rows.rows[0]?.n).toBe(1);

    const evt = await outboxOf(SLOT_LOCKED_TOPIC);
    expect(evt).toHaveLength(1);
    expect(evt[0]?.payload).toMatchObject({
      lawyer_id: LAWYER,
      slot_start: SLOT.toISOString(),
      ref: { ref_type: 'session', ref_id: 7001 },
      status: 'LOCKED',
    });

    // 同段第二把（不同用户不同 ref）→ SLOT_TAKEN（23505→SLOT_TAKEN，§8 笔误以 PG 实际 SQLSTATE 为准）
    await poolSvc.withTransaction(async (uow) => {
      const r2 = await svc.lockSlot(
        uow,
        lockInput({ initiatorUserId: 502, refType: 'groupbuy', refId: 8001 }),
      );
      expect(r2).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    });
    expect(await activeCount()).toBe(1);
  });

  it('LOCK_SLOT C2B 发布即 PENDING_PAYMENT：绑定 payment_order_id ⇒ ttl_at + SLOT_TTL job 同事务注册', async () => {
    let lockId = 0;
    const before = Date.now();
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(uow, lockInput({ paymentOrderId: 66001 }));
      expect(r).toMatchObject({ ok: true, status: 'PENDING_PAYMENT' });
      lockId = r.ok ? r.lockId : 0;
    });
    const row = await lockRow(lockId);
    expect(row).toMatchObject({ status: 'PENDING_PAYMENT', payment_order_id: '66001' });
    expect(row?.ttl_at).not.toBeNull();

    // SLOT_TTL job 同事务注册（I2 registerJob(uow,…)），dueAt=ttl_at
    const job = await jobOf(lockId);
    expect(job).toBeDefined();
    expect(job?.status).toBe('PENDING');
    const dueMs = (job?.due_at as Date).getTime();
    const ttlMs = (row?.ttl_at as Date).getTime();
    expect(Math.abs(dueMs - ttlMs)).toBeLessThan(5);
    expect(ttlMs - before).toBeGreaterThanOrEqual(150); // ttlMs=200（时钟容差）
    expect(ttlMs - before).toBeLessThan(2_000);
  });

  // ---------- R-01：100 并发真 PG 压测 ----------

  it('R-01（§10）100 并发同段加锁恰一成功：部分唯一索引防线', async () => {
    // 连接池上限 60：portable PG max_connections=100（上调须重启库，裁决禁 stop）——100 个
    // 加锁事务并发尝试、在途并发由池收敛到 ~60、其余排队；唯一索引防线的竞争语义不变
    //（任一时刻多个在途事务在ux_slot_active 同一索引项上竞争，恰一提交胜出）。
    const big = new Pool({ ...pgConfigFromEnv(), max: 60 });
    try {
      const users = Array.from({ length: 100 }, (_, i) => 1000 + i);
      const results = await Promise.all(
        users.map((uid) => {
          return (async (): Promise<string> => {
            const client = await big.connect();
            try {
              await client.query('BEGIN');
              const r = await svc.lockSlot(client as unknown as SqlExecutor, {
                lawyerId: LAWYER,
                slotStart: SLOT,
                initiatorUserId: uid,
                refType: 'session',
                refId: 7000 + uid,
              });
              if (r.ok) {
                await client.query('COMMIT');
                return `GRANTED:${r.status}`;
              }
              await client.query('ROLLBACK'); // SLOT_TAKEN 后事务已被 23505 污染，只能回滚
              return r.reason;
            } catch (e) {
              await client.query('ROLLBACK').catch(() => undefined);
              throw e;
            } finally {
              client.release();
            }
          })();
        }),
      );
      const granted = results.filter((r) => r.startsWith('GRANTED'));
      expect(granted).toHaveLength(1); // 恰一胜
      expect(granted[0]).toBe('GRANTED:LOCKED');
      expect(results.filter((r) => r === 'SLOT_TAKEN')).toHaveLength(99); // 其余 99 败
      expect(await activeCount()).toBe(1);
      expect(
        await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM schedule.slot_locks`),
      ).toMatchObject({ rows: [{ n: 1 }] }); // 无半提交残留
    } finally {
      await big.end().catch(() => undefined);
    }
  }, 60_000);

  it('R-01 部分唯一含 PENDING_PAYMENT：未支付占段同样挡新锁；TTL 释放后他人可同段重锁（C2 §10 联调）', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(
        uow,
        lockInput({ initiatorUserId: 511, paymentOrderId: 66101 }),
      );
      lockId = r.ok ? r.lockId : 0;
      expect(r.ok).toBe(true);
    });
    // 他人同段 → SLOT_TAKEN（PENDING_PAYMENT 在唯一索引覆盖内）
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(uow, lockInput({ initiatorUserId: 512, refId: 7002 }));
      expect(r).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    });
    // TTL 到期释放 → 同段可再锁
    await backdateTtl(lockId);
    expect(await scheduler.tick('normal')).toMatchObject({ done: 1 });
    expect((await lockRow(lockId))?.status).toBe('RELEASED');
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(uow, lockInput({ initiatorUserId: 512, refId: 7002 }));
      expect(r).toMatchObject({ ok: true, status: 'LOCKED' });
    });
  });

  // ---------- R-02：同事务语义（崩溃注入） ----------

  it('R-02（§10）崩溃注入：业务事务回滚则锁写入一并回滚、无残留；同事务释放回滚则锁仍在', async () => {
    // a) 加锁后业务失败回滚 → 锁行与 SLOT_TTL job 全部消失
    await expect(
      poolSvc.withTransaction(async (uow) => {
        const r = await fastSvc.lockSlot(uow, lockInput({ paymentOrderId: 66201 }));
        expect(r.ok).toBe(true);
        throw new Error('业务失败回滚（加锁）');
      }),
    ).rejects.toThrow('业务失败回滚（加锁）');
    expect(
      await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM schedule.slot_locks`),
    ).toMatchObject({ rows: [{ n: 0 }] });
    expect(
      await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM schedule.schedule_jobs`),
    ).toMatchObject({ rows: [{ n: 0 }] });

    // b) 先提交一把锁，再在业务事务内释放后崩溃 → 释放一并回滚，锁仍活跃
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await svc.lockSlot(uow, lockInput());
      lockId = r.ok ? r.lockId : 0;
    });
    await expect(
      poolSvc.withTransaction(async (uow) => {
        const r = await svc.releaseSlot(uow, {
          refType: 'session',
          refId: 7001,
          reason: 'FLOW_FAILED',
        });
        expect(r).toMatchObject({ ok: true });
        throw new Error('业务失败回滚（释放）');
      }),
    ).rejects.toThrow('业务失败回滚（释放）');
    expect((await lockRow(lockId))?.status).toBe('LOCKED');
    expect(await activeCount()).toBe(1);

    // c) 正控：同事务提交则持久
    await poolSvc.withTransaction(async (uow) => {
      await svc.releaseSlot(uow, { refType: 'session', refId: 7001, reason: 'FLOW_FAILED' });
    });
    expect((await lockRow(lockId))?.status).toBe('RELEASED');
  });

  // ---------- R-03：滥用防护三重 ----------

  it('R-03 每用户对同律师进行中锁 ≤1（PENDING_PAYMENT 纳入计数）；他律师不受限', async () => {
    await poolSvc.withTransaction(async (uow) => {
      const first = await svc.lockSlot(uow, lockInput());
      expect(first.ok).toBe(true);
      // 同用户同律师第二段（PENDING_PAYMENT 也计数）→ SLOT_ABUSE_LIMIT(PER_LAWYER)
      const second = await fastSvc.lockSlot(uow, {
        lawyerId: LAWYER,
        slotStart: new Date('2026-11-06T14:00:00.000Z'),
        initiatorUserId: 501,
        refType: 'groupbuy',
        refId: 8101,
        paymentOrderId: 66301,
      });
      expect(second).toMatchObject({ ok: false, reason: 'SLOT_ABUSE_LIMIT' });
      // 换律师 → 不受限
      const other = await svc.lockSlot(uow, {
        lawyerId: 9002,
        slotStart: SLOT,
        initiatorUserId: 501,
        refType: 'groupbuy',
        refId: 8102,
      });
      expect(other.ok).toBe(true);
    });
    expect(await activeCount(LAWYER, SLOT)).toBe(1);
    expect(await activeCount(9002, SLOT)).toBe(1);
  });

  it('R-03 全局 ≤3：三把成功，第 4 把拒绝（GLOBAL）', async () => {
    await poolSvc.withTransaction(async (uow) => {
      for (const i of [1, 2, 3]) {
        const r = await svc.lockSlot(uow, {
          lawyerId: 9100 + i,
          slotStart: SLOT,
          initiatorUserId: 520,
          refType: 'session',
          refId: 7200 + i,
        });
        expect(r.ok).toBe(true);
      }
      const fourth = await svc.lockSlot(uow, {
        lawyerId: 9104,
        slotStart: SLOT,
        initiatorUserId: 520,
        refType: 'session',
        refId: 7204,
      });
      expect(fourth).toMatchObject({ ok: false, reason: 'SLOT_ABUSE_LIMIT' });
    });
    const mine = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks WHERE initiator_user_id = 520
        AND status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED')`,
    );
    expect(mine.rows[0]?.n).toBe(3);
    // 全局维度拒绝同样落 SlotAbuseDetected（limit=GLOBAL，→G1；PER_LAWYER 维度见上一用例）
    const evt = await outboxOf(SLOT_ABUSE_DETECTED_TOPIC);
    expect(evt).toHaveLength(1);
    expect(evt[0]?.payload).toMatchObject({ user_id: 520, lawyer_id: 9104, limit: 'GLOBAL' });
  });

  it('R-03 滥用拒绝：SlotAbuseDetected 经独立事务落 outbox（调用方回滚不丢事件）', async () => {
    await expect(
      poolSvc.withTransaction(async (uow) => {
        const r = await svc.lockSlot(uow, lockInput()); // 第一把（占用中）
        expect(r.ok).toBe(true);
        const second = await svc.lockSlot(uow, {
          lawyerId: LAWYER,
          slotStart: new Date('2026-11-06T15:00:00.000Z'),
          initiatorUserId: 501,
          refType: 'session',
          refId: 7301,
        });
        expect(second).toMatchObject({ ok: false, reason: 'SLOT_ABUSE_LIMIT' });
        throw new Error('业务放弃（回滚整个发布事务）');
      }),
    ).rejects.toThrow('业务放弃（回滚整个发布事务）');

    // 锁写入随业务回滚：只有第一把…第一把在同一事务也被回滚 → 全部无残留
    expect(
      await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM schedule.slot_locks`),
    ).toMatchObject({ rows: [{ n: 0 }] });
    // 但滥用告警事件经独立事务存活（G1 消费不受调用方回滚影响，守卫拒绝留痕同款口径）
    const evt = await outboxOf(SLOT_ABUSE_DETECTED_TOPIC);
    expect(evt).toHaveLength(1);
    expect(evt[0]?.payload).toMatchObject({ user_id: 501, lawyer_id: LAWYER });
  });

  it('R-03 并发同用户同律师双锁：advisory 串行化下恰 1 成功 1 SLOT_ABUSE_LIMIT（计数无 TOCTOU）', async () => {
    const [a, b] = await Promise.all([
      poolSvc.withTransaction((uow) =>
        svc.lockSlot(uow, lockInput({ slotStart: new Date('2026-11-06T10:00:00.000Z') })),
      ),
      poolSvc.withTransaction((uow) =>
        svc.lockSlot(uow, lockInput({ slotStart: new Date('2026-11-06T16:00:00.000Z') })),
      ),
    ]);
    const granted = [a, b].filter((r) => r.ok);
    const limited = [a, b].filter((r) => !r.ok && r.reason === 'SLOT_ABUSE_LIMIT');
    expect(granted).toHaveLength(1);
    expect(limited).toHaveLength(1);
    expect(
      await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM schedule.slot_locks WHERE initiator_user_id = 501
          AND status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED')`,
      ),
    ).toMatchObject({ rows: [{ n: 1 }] });
  });

  // ---------- TTL（I2 联调） ----------

  it('TTL 到期（I2 联调，§10）：SLOT_TTL 执行器回查+释放 → SlotTtlExpired + SlotReleased(TTL_EXPIRED)；job DONE', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(
        uow,
        lockInput({ initiatorUserId: 531, paymentOrderId: 66401 }),
      );
      lockId = r.ok ? r.lockId : 0;
    });
    await backdateTtl(lockId);
    expect(await scheduler.tick('normal')).toMatchObject({ done: 1 });

    expect((await lockRow(lockId))?.status).toBe('RELEASED');
    const job = await jobOf(lockId);
    expect(job?.status).toBe('DONE');

    const ttlEvt = await outboxOf(SLOT_TTL_EXPIRED_TOPIC);
    expect(ttlEvt).toHaveLength(1);
    expect(ttlEvt[0]?.payload).toMatchObject({
      lock_id: lockId,
      lawyer_id: LAWYER,
      ref: { ref_type: 'session', ref_id: 7001 },
    });
    const relEvt = await outboxOf(SLOT_RELEASED_TOPIC);
    expect(relEvt).toHaveLength(1);
    expect(relEvt[0]?.payload).toMatchObject({ lock_id: lockId, reason: 'TTL_EXPIRED' });

    // 守卫留痕：PENDING_PAYMENT→RELEASED
    expect((await stlOf(lockId)).map((r) => `${r.from_status}→${r.to_status}`)).toEqual([
      'PENDING_PAYMENT→RELEASED',
    ]);
  });

  it('TTL 被业务先行：CONFIRM_PAYMENT 后 tick → job CANCELLED 无操作（R-02 回查兜底），锁保持 LOCKED', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(
        uow,
        lockInput({ initiatorUserId: 532, paymentOrderId: 66501 }),
      );
      lockId = r.ok ? r.lockId : 0;
      const c = await fastSvc.confirmPayment(uow, 66501);
      expect(c).toMatchObject({ ok: true, transitioned: true });
    });
    await backdateTtl(lockId); // 即便 due 已过：job 已 CANCELLED，锁已 LOCKED
    expect(await scheduler.tick('normal')).toMatchObject({ done: 0, cancelled: 0 });
    expect((await lockRow(lockId))?.status).toBe('LOCKED');
    const job = await jobOf(lockId);
    expect(job?.status).toBe('CANCELLED');
  });

  it('TTL 未到不提前释放（时钟差兜底）：job 先到而 ttl_at 未到 → DONE 不释放；reaper 兜底回收+告警', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(
        uow,
        lockInput({ initiatorUserId: 533, paymentOrderId: 66502 }),
      );
      lockId = r.ok ? r.lockId : 0;
      expect(r.ok).toBe(true);
    });
    // 只回拨 job 的 due_at（模拟 job 相对 ttl_at 早到/应用与 DB 时钟差），ttl_at 仍在未来
    await pool.query(
      `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1 second'
        WHERE job_type = 'SLOT_TTL' AND ref_type = 'slot_lock' AND ref_id = $1 AND status = 'PENDING'`,
      [lockId],
    );
    expect(await scheduler.tick('normal')).toMatchObject({ done: 1 });
    // 未到 ttl_at：绝不提前释放（PENDING_PAYMENT 占段防线保持），job DONE（released=false 落 log）
    expect((await lockRow(lockId))?.status).toBe('PENDING_PAYMENT');
    expect((await jobOf(lockId))?.status).toBe('DONE');
    // 该锁已无在册 TTL job → reaper P1 是最后一道防线：回拨 ttl_at 后一轮回收
    await pool.query(
      `UPDATE schedule.slot_locks SET ttl_at = now() - interval '1 second' WHERE id = $1`,
      [lockId],
    );
    await svc.ensureReaperScheduled();
    await pool.query(
      `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1 second'
        WHERE job_type = 'SLOT_REAPER' AND status = 'PENDING'`,
    );
    expect(await scheduler.tick('normal')).toMatchObject({ done: 1 });
    expect((await lockRow(lockId))?.status).toBe('RELEASED');
    expect(alerts.alerts.some((a) => a.reason === 'TTL_EXPIRED_BACKSTOP')).toBe(true);
  });

  // ---------- CONFIRM_PAYMENT / START_OCCUPY / RELEASE_SLOT ----------

  it('CONFIRM_PAYMENT：首迁 PENDING_PAYMENT→LOCKED+取消 TTL job；重复回调幂等；NOT_FOUND；RELEASED 后 NOT_FOUND', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(
        uow,
        lockInput({ initiatorUserId: 541, paymentOrderId: 66601 }),
      );
      lockId = r.ok ? r.lockId : 0;
      const first = await fastSvc.confirmPayment(uow, 66601);
      expect(first).toMatchObject({ ok: true, lockId, transitioned: true });
      const again = await fastSvc.confirmPayment(uow, 66601);
      expect(again).toMatchObject({ ok: true, lockId, transitioned: false }); // 回调重放幂等
      const missing = await fastSvc.confirmPayment(uow, 999);
      expect(missing).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    });
    // job 作废断言须在事务提交后（jobOf 走独立连接，READ COMMITTED 看不到未提交行）
    expect((await jobOf(lockId))?.status).toBe('CANCELLED');
    expect((await stlOf(lockId)).map((r) => `${r.from_status}→${r.to_status}`)).toEqual([
      'PENDING_PAYMENT→LOCKED',
    ]);

    // 释放后迟到回调 → NOT_FOUND（无可确认对象）
    await poolSvc.withTransaction(async (uow) => {
      await svc.releaseSlot(uow, { refType: 'session', refId: 7001, reason: 'CANCELLED' });
      const late = await svc.confirmPayment(uow, 66601);
      expect(late).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    });
  });

  it('START_OCCUPY：LOCKED→OCCUPIED 守卫留痕；重放幂等短路（transitioned=false 不毒化事务）；非 LOCKED 拒绝；NOT_FOUND', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await svc.lockSlot(uow, lockInput({ initiatorUserId: 542 }));
      lockId = r.ok ? r.lockId : 0;
      const ok = await svc.startOccupy(uow, lockId);
      expect(ok).toMatchObject({ ok: true, lockId, transitioned: true });
      // 二次开房（W3 开房 job 重试/回调重放）：幂等短路，不抛不留拒绝痕（重放不得毒化调用方事务）
      const replay = await svc.startOccupy(uow, lockId);
      expect(replay).toMatchObject({ ok: true, lockId, transitioned: false });
      const unknown = await svc.startOccupy(uow, 987654);
      expect(unknown).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    });
    expect((await lockRow(lockId))?.status).toBe('OCCUPIED');
    expect(
      (await stlOf(lockId)).map((r) => `${r.from_status}→${r.to_status}:${r.allowed}`),
    ).toEqual(['LOCKED→OCCUPIED:true']); // 重放无拒绝留痕

    // PENDING_PAYMENT 直接开房 → 非法迁移（换段位：上方 OCCUPIED 锁仍活跃占着 (9001, SLOT)）
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(
        uow,
        lockInput({
          initiatorUserId: 543,
          refId: 7003,
          slotStart: new Date('2026-11-06T17:00:00.000Z'),
          paymentOrderId: 66701,
        }),
      );
      expect(r.ok).toBe(true);
      await expect(svc.startOccupy(uow, r.ok ? r.lockId : 0)).rejects.toMatchObject({
        code: ErrorCode.StateIllegalTransition,
      });
    });
  });

  it('RELEASE_SLOT：幂等（二次 ALREADY_RELEASED）；NOT_FOUND；PENDING_PAYMENT 释放取消 TTL job；SlotReleased 载荷', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await fastSvc.lockSlot(
        uow,
        lockInput({ initiatorUserId: 544, paymentOrderId: 66801 }),
      );
      lockId = r.ok ? r.lockId : 0;
      const first = await svc.releaseSlot(uow, {
        refType: 'session',
        refId: 7001,
        reason: 'GROUPBUY_FAILED',
      });
      expect(first).toMatchObject({ ok: true, lockId });
      const second = await svc.releaseSlot(uow, {
        refType: 'session',
        refId: 7001,
        reason: 'GROUPBUY_FAILED',
      });
      expect(second).toMatchObject({ ok: false, reason: 'ALREADY_RELEASED' }); // 幂等
      const none = await svc.releaseSlot(uow, { refType: 'session', refId: 987654, reason: 'X' });
      expect(none).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    });
    // 释放同步取消 TTL job（断言在提交后：jobOf 走独立连接看不到未提交行）
    expect((await jobOf(lockId))?.status).toBe('CANCELLED');
    expect((await lockRow(lockId))?.status).toBe('RELEASED');
    const evt = await outboxOf(SLOT_RELEASED_TOPIC);
    expect(evt).toHaveLength(1);
    expect(evt[0]?.payload).toMatchObject({
      lock_id: lockId,
      lawyer_id: LAWYER,
      slot_start: SLOT.toISOString(),
      ref: { ref_type: 'session', ref_id: 7001 },
      reason: 'GROUPBUY_FAILED',
    });
  });

  it('非法入参：id/时间/ref_type/reason 校验拒绝且不落行', async () => {
    await expect(
      poolSvc.withTransaction((uow) => svc.lockSlot(uow, lockInput({ lawyerId: 0 }))),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      poolSvc.withTransaction((uow) =>
        svc.lockSlot(uow, lockInput({ slotStart: 'not-a-date' as unknown as Date })),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      poolSvc.withTransaction((uow) => svc.lockSlot(uow, lockInput({ refType: 'hack' as never }))),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      poolSvc.withTransaction((uow) =>
        svc.releaseSlot(uow, { refType: 'session', refId: 1, reason: '' }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM schedule.slot_locks`);
    expect(n.rows[0]?.n).toBe(0);
  });
});
