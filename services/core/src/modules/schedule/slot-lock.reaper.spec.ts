import 'reflect-metadata';
import { ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { SchedulerService } from './scheduler.service';
import { MockSlotLockAlertSink } from './slot-lock.alerts';
import { SLOT_LOCK_DEFAULT_CONFIG } from './slot-lock.config';
import { SLOT_RELEASED_TOPIC, SLOT_TTL_EXPIRED_TOPIC } from './slot-lock.events';
import { TerminalStateRegistry } from './slot-lock.terminal-registry';
import type { EntityTerminalInfo, TerminalStateProvider } from './slot-lock.types';
import { SlotLockService } from './slot-lock.service';
import { SlotLockModule } from './slot-lock.module';

/**
 * B2 reaper 兜底 e2e（需 PG，R-04）：活跃锁 + 关联实体已终态超阈（15min）→ 强制释放+告警；
 * PENDING_PAYMENT 走 ttl_at 部分索引兜底；LOCKED/OCCUPIED 全量扫描经 provider 注册表判定
 * （业务实体表 W1 尚不存在——真实 provider 随 C1/C2/C5 落位注册，本套件以 stub 验证机制）；
 * 周期节拍由 I2 SLOT_REAPER job 承载（执行 DONE 后自投下一周期，收敛恰一在册）。
 */

const SLOT = new Date('2026-11-06T10:00:00.000Z');

/** 可编程终态判定 stub（W1 机制验证；refId→terminal 映射由用例注入） */
class StubTerminalProvider implements TerminalStateProvider {
  readonly byRef = new Map<number, EntityTerminalInfo | null>();

  async isTerminal(refId: number): Promise<EntityTerminalInfo | null> {
    return this.byRef.get(refId) ?? null;
  }
}

describe('B2 reaper（R-04，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let svc: SlotLockService;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let alerts: MockSlotLockAlertSink;
  let sessionProvider: StubTerminalProvider;
  let groupbuyProvider: StubTerminalProvider;

  const lockRow = async (lockId: number) => {
    const res = await pool.query<{ status: string }>(
      `SELECT status FROM schedule.slot_locks WHERE id = $1`,
      [lockId],
    );
    return res.rows[0];
  };

  /** 触发一轮 reaper：走生产自投节拍（ensureReaperScheduled 注册 → 回拨 due → tick 执行） */
  const runReaper = async (): Promise<void> => {
    await svc.ensureReaperScheduled();
    await pool.query(
      `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1 second'
        WHERE job_type = 'SLOT_REAPER' AND status = 'PENDING'`,
    );
    const tick = await scheduler.tick('normal');
    expect(tick).toMatchObject({ done: 1 });
  };

  const pendingReapers = async () => {
    const res = await pool.query<{ id: string; due_at: Date }>(
      `SELECT id, due_at FROM schedule.schedule_jobs
        WHERE job_type = 'SLOT_REAPER' AND status = 'PENDING' ORDER BY id`,
    );
    return res.rows;
  };

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows;
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
    const registry = app.get(TerminalStateRegistry);
    sessionProvider = new StubTerminalProvider();
    groupbuyProvider = new StubTerminalProvider();
    registry.register('session', sessionProvider); // 真实 provider 随 C1/C5 落位注册
    registry.register('groupbuy', groupbuyProvider); // 真实 provider 随 C2 落位注册
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    sessionProvider.byRef.clear();
    groupbuyProvider.byRef.clear();
    alerts.alerts.length = 0;
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('R-04 关联实体终态超阈（15min）：LOCKED 残留 → 强制释放 + SlotReleased(ENTITY_TERMINATED) + 告警 + 自投下一周期', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await svc.lockSlot(uow, {
        lawyerId: 9201,
        slotStart: SLOT,
        initiatorUserId: 601,
        refType: 'session',
        refId: 7401,
      });
      lockId = r.ok ? r.lockId : 0;
      expect(r.ok).toBe(true);
    });
    sessionProvider.byRef.set(7401, {
      terminal: true,
      since: new Date(Date.now() - 20 * 60_000), // 终态已 20min > 15min
    });

    await runReaper();

    expect((await lockRow(lockId))?.status).toBe('RELEASED');
    const evt = await outboxOf(SLOT_RELEASED_TOPIC);
    expect(evt).toHaveLength(1);
    expect(evt[0]?.payload).toMatchObject({
      lock_id: lockId,
      lawyer_id: 9201,
      ref: { ref_type: 'session', ref_id: 7401 },
      reason: 'ENTITY_TERMINATED',
    });
    // 释放 + 告警（mock 适配器，供应商位 M2+）
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({
      kind: 'LOCK_LEAK',
      lockId,
      refType: 'session',
      refId: 7401,
    });
    // 周期自投：恰一个 PENDING 的下一周期（dueAt ≈ now+5min）
    const next = await pendingReapers();
    expect(next).toHaveLength(1);
    expect(next[0] ? next[0].due_at.getTime() - Date.now() : -1).toBeGreaterThan(4 * 60_000);
  });

  it('R-04 不误杀：未终态 / 终态未超阈 / 无 provider（reschedule）/ provider 判 null → 全部不动', async () => {
    const mk = async (refId: number, refType: 'session' | 'groupbuy' | 'reschedule') => {
      await poolSvc.withTransaction(async (uow) => {
        const r = await svc.lockSlot(uow, {
          lawyerId: 9300 + refId,
          slotStart: SLOT,
          initiatorUserId: 610 + refId,
          refType,
          refId,
        });
        expect(r.ok).toBe(true);
      });
    };
    await mk(7501, 'session'); // 未终态
    await mk(7502, 'session'); // 终态但仅 5min < 15min
    await mk(7503, 'reschedule'); // 无 provider 注册（C5 未落位）
    await mk(7504, 'groupbuy'); // provider 返回 null（实体查不到，宁漏不误杀）
    sessionProvider.byRef.set(7501, { terminal: false, since: null });
    sessionProvider.byRef.set(7502, {
      terminal: true,
      since: new Date(Date.now() - 5 * 60_000),
    });

    await runReaper();

    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks WHERE status IN ('LOCKED', 'OCCUPIED')`,
    );
    expect(rows.rows[0]?.n).toBe(4);
    expect(alerts.alerts).toHaveLength(0);
    expect(await outboxOf(SLOT_RELEASED_TOPIC)).toHaveLength(0);
  });

  it('R-04 OCCUPIED 终态残留 → 释放（全量扫描覆盖两活跃态）', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await svc.lockSlot(uow, {
        lawyerId: 9401,
        slotStart: SLOT,
        initiatorUserId: 621,
        refType: 'groupbuy',
        refId: 7601,
      });
      lockId = r.ok ? r.lockId : 0;
      const o = await svc.startOccupy(uow, r.ok ? r.lockId : 0);
      expect(o.ok).toBe(true);
    });
    groupbuyProvider.byRef.set(7601, {
      terminal: true,
      since: new Date(Date.now() - 16 * 60_000),
    });

    await runReaper();

    expect((await lockRow(lockId))?.status).toBe('RELEASED');
    expect(alerts.alerts[0]).toMatchObject({ kind: 'LOCK_LEAK', refType: 'groupbuy' });
  });

  it('R-04 PENDING_PAYMENT 残留（ttl_at 已过、TTL job 失效）→ ix_slot_ttl 兜底释放 + SlotTtlExpired + 告警', async () => {
    let lockId = 0;
    await poolSvc.withTransaction(async (uow) => {
      const r = await svc.lockSlot(uow, {
        lawyerId: 9501,
        slotStart: SLOT,
        initiatorUserId: 631,
        refType: 'groupbuy',
        refId: 7701,
        paymentOrderId: 67001,
      });
      lockId = r.ok ? r.lockId : 0;
    });
    // 模拟 TTL job 丢失（误作废）：reaper 是最后一道防线
    await pool.query(
      `UPDATE schedule.schedule_jobs SET status = 'CANCELLED'
        WHERE job_type = 'SLOT_TTL' AND ref_type = 'slot_lock' AND ref_id = $1`,
      [lockId],
    );
    await pool.query(
      `UPDATE schedule.slot_locks SET ttl_at = now() - interval '2 second' WHERE id = $1`,
      [lockId],
    );

    await runReaper();

    expect((await lockRow(lockId))?.status).toBe('RELEASED');
    expect(await outboxOf(SLOT_TTL_EXPIRED_TOPIC)).toHaveLength(1);
    const rel = await outboxOf(SLOT_RELEASED_TOPIC);
    expect(rel[0]?.payload).toMatchObject({ lock_id: lockId, reason: 'TTL_EXPIRED' });
    expect(alerts.alerts[0]).toMatchObject({ kind: 'LOCK_LEAK', lockId });
  });

  it('自投收敛：连续两轮 tick 后仍恰一个 PENDING SLOT_REAPER（多轮不翻倍）', async () => {
    await runReaper();
    await runReaper(); // 第二轮执行时自投前会先查在册 PENDING（advisory 锁串行化）
    expect(await pendingReapers()).toHaveLength(1);
  });

  it('超阈边界：since=15min-1s 不释放；since=15min+1s 释放（staleMs 判定锚点）', async () => {
    const mk = async (refId: number) => {
      await poolSvc.withTransaction(async (uow) => {
        const r = await svc.lockSlot(uow, {
          lawyerId: 9600 + refId,
          slotStart: SLOT,
          initiatorUserId: 640 + refId,
          refType: 'session',
          refId,
        });
        expect(r.ok).toBe(true);
      });
    };
    await mk(7801); // 未到阈
    await mk(7802); // 已过阈
    sessionProvider.byRef.set(7801, {
      terminal: true,
      since: new Date(Date.now() - (SLOT_LOCK_DEFAULT_CONFIG.staleMs - 1_000)),
    });
    sessionProvider.byRef.set(7802, {
      terminal: true,
      since: new Date(Date.now() - (SLOT_LOCK_DEFAULT_CONFIG.staleMs + 1_000)),
    });

    await runReaper();

    const kept = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule.slot_locks WHERE status = 'LOCKED'`,
    );
    expect(kept.rows[0]?.n).toBe(1); // 7801 保留
    const released = await outboxOf(SLOT_RELEASED_TOPIC);
    expect(released[0]?.payload).toMatchObject({ ref: { ref_id: 7802 } });
  });
});

// ---------- 纯单元：provider 注册表 ----------

describe('TerminalStateRegistry（纯单元）', () => {
  it('register/get：按 ref_type 注册与取用；重复注册抛 ConfigInvalid；未注册返回 null', () => {
    const registry = new TerminalStateRegistry();
    const p: TerminalStateProvider = { isTerminal: async () => null };
    expect(registry.get('session')).toBeNull();
    registry.register('session', p);
    expect(registry.get('session')).toBe(p);
    expect(registry.get('groupbuy')).toBeNull();
    expect(() => registry.register('session', p)).toThrowError(
      expect.objectContaining({ code: ErrorCode.ConfigInvalid }),
    );
  });
});
