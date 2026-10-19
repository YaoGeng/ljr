import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ABSENCE_SHARE_DANGLING_TOPIC,
  ATTENDANCE_ADJUDICATED_TOPIC,
  RESERVE_DIFF_FOUND_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import type { SqlExecutor } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { ScheduleExecutorRegistry } from '../schedule/scheduler-executor.registry';
import { SchedulerService } from '../schedule/scheduler.service';
import { lastJobLogOf, listJobsByType } from '../schedule/job-fixture';
import { BenefitsModule } from './points.module';
import { PointsService } from './points.service';
import { ReserveJobExecutors } from './reserve.executors';
import { ReserveService, type ReserveReconcileResult } from './reserve.service';

/**
 * F4 ②全量备付台账 e2e（需 PG，M2-W2 T6）：
 *   - 记账三面：正向入账 ACCRUE（grant/refundRestore 同路径）/核销 REDEEM_NET/过期扣减
 *     EXPIRE_NET——均与业务流水同事务，deduplicated 短路不落行（重放不双计）；
 *   - 符号/单位口径（V43 任务裁定）：ACCRUE=+points/100、REDEEM_NET/EXPIRE_NET=−points/100
 *     （元 NUMERIC；int 分→numeric 精确换算）；
 *   - R-05 日终对平（§10 留框项②）：Σ(balance+frozen) vs Σ(amount)×100——平衡零动作 /
 *     构造不平→告警（Logger.error）+ReserveDiffFound 出箱（H3 工单消费面在 ops 侧各自覆盖）；
 *   - RESERVE_RECONCILE 执行器注册+引导幂等（目录第 26 项）；
 *   - 修复环 I-2：execute 全路径端到端（过去 due→tick 真执行→DONE detail 承载对平结果
 *     +自投下一日）；修复环 I-3：悬空分成附带核对（判定流静默 48h 应发未发检出——
 *     AttendanceAdjudicated 合成留痕回拨时间注入，律师缺席/已发放/未满窗三面清零）。
 */
const USER = 701;
const USER_B = 702;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

interface LedgerRow {
  readonly entry: string;
  readonly amount: string;
  readonly ref_id: string;
  readonly period: string;
}

describe('F4 ②全量备付台账（ACCRUE/REDEEM_NET/EXPIRE_NET 记账 + R-05 日终对平，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let points: PointsService;
  let reserve: ReserveService;
  let poolSvc: PgPoolService;
  let outbox: OutboxService;

  const ledgerRows = async (): Promise<LedgerRow[]> => {
    const res = await pool.query<LedgerRow>(
      `SELECT entry, amount::text AS amount, ref_id, to_char(period, 'YYYY-MM-DD') AS period
         FROM benefits.reserve_ledgers ORDER BY id`,
    );
    return res.rows;
  };

  const diffEvents = async () => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [RESERVE_DIFF_FOUND_TOPIC],
    );
    return res.rows.map((r) => r.payload);
  };

  const runReconcile = (): Promise<ReserveReconcileResult> =>
    poolSvc.withTransaction((uow: SqlExecutor) => reserve.reconcile(uow));

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [BenefitsModule],
    })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    points = app.get(PointsService);
    reserve = app.get(ReserveService);
    poolSvc = app.get(PgPoolService);
    outbox = app.get(OutboxService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------- 记账三面（与业务流水同事务 + 重放不双计） ----------

  it('grant 正向入账 → ACCRUE +points/100（元 NUMERIC 精确）+ref={source_ref}:u{user}+period=上海日；幂等重放不落第二行', async () => {
    const r = await points.grant({
      user_id: USER,
      points: 12345,
      kind: 'COMPENSATION',
      ref: 'price_change:9',
    });
    expect(r.deduplicated).toBe(false);
    let rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entry: 'ACCRUE',
      amount: '123.45',
      ref_id: 'price_change:9:u701',
    });
    expect(rows[0]!.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // at-least-once 重放：同键同载荷短路——台账不双计
    const replay = await points.grant({
      user_id: USER,
      points: 12345,
      kind: 'COMPENSATION',
      ref: 'price_change:9',
    });
    expect(replay.deduplicated).toBe(true);
    rows = await ledgerRows();
    expect(rows).toHaveLength(1);
  });

  it('refundRestore 还原 → ACCRUE 同款（R-06 还原也是未兑付余额增项）', async () => {
    await points.refundRestore({ user_id: USER, points: 500, ref: 'refund:31' });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry: 'ACCRUE', amount: '5.00', ref_id: 'refund:31:u701' });
  });

  it('freeze→settle 核销 → REDEEM_NET −points/100（ref=order:{id}）；settle 重放不落第二行', async () => {
    await points.grant({ user_id: USER, points: 800, kind: 'ABSENCE_SHARE', ref: 'absence:77' });
    await points.freeze({
      user_id: USER,
      payment_order_id: 55,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    await points.settle({ user_id: USER, payment_order_id: 55 });
    let rows = await ledgerRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      entry: 'REDEEM_NET',
      amount: '-3.00',
      ref_id: 'order:55',
    });

    await points.settle({ user_id: USER, payment_order_id: 55 }); // 幂等重放
    rows = await ledgerRows();
    expect(rows).toHaveLength(2);
  });

  it('expireUser 过期扣减 → EXPIRE_NET −deduct/100（ref=expire:{日}:u{user}；§10 留框项①）', async () => {
    const db = app.get(PgPoolService);
    await db.query(
      `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref, expires_at)
       VALUES ($1, 2000, 'COMPENSATION', 'fixture:e1', now() - interval '1 day')`,
      [USER],
    );
    await db.query(
      `INSERT INTO benefits.points_accounts (user_id, balance) VALUES ($1, 2000)
       ON CONFLICT (user_id) DO UPDATE SET balance = 2000`,
      [USER],
    );
    const r = await poolSvc.withTransaction((uow: SqlExecutor) => points.expireUser(uow, USER));
    expect(r).toEqual({ swept: 2000 });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry: 'EXPIRE_NET', amount: '-20.00' });
    expect(rows[0]!.ref_id).toMatch(new RegExp(`^expire:\\d{8}:u${USER}$`));
  });

  // ---------- R-05 日终对平（§10 留框项②：构造不平→告警） ----------

  it('对平（平衡）：grant+freeze（balance+frozen 均未兑付口径）vs ΣACCRUE×100 恒等——零事件零告警', async () => {
    await points.grant({ user_id: USER, points: 1000, kind: 'ABSENCE_SHARE', ref: 'absence:1' });
    await points.grant({
      user_id: USER_B,
      points: 250,
      kind: 'COMPENSATION',
      ref: 'price_change:2',
    });
    await points.freeze({
      user_id: USER,
      payment_order_id: 66,
      points_to_use: 400,
      order_payable_cents: 100000,
    }); // balance 600 + frozen 400（frozen=在途核销同属未兑付）

    const r = await runReconcile();
    expect(r.balanced).toBe(true);
    expect(r.points_outstanding_cents).toBe(1250);
    expect(r.reserve_net_cents).toBe(1250);
    expect(r.diff_cents).toBe(0);
    expect(await diffEvents()).toHaveLength(0);
  });

  it('对平（不平→告警）：直插漂移台账行（ACCRUE 无对应积分）→ diff≠0 + ReserveDiffFound 出箱（载荷含两侧净额与差额）', async () => {
    await points.grant({
      user_id: USER,
      points: 1000,
      kind: 'COMPENSATION',
      ref: 'price_change:3',
    });
    // 漂移注入：多记一笔 ACCRUE 5.00（无对应积分入账——台账多记形态）
    await pool.query(
      `INSERT INTO benefits.reserve_ledgers (period, entry, amount, ref_id)
       VALUES ((now() AT TIME ZONE 'Asia/Shanghai')::date, 'ACCRUE', 5.00, 'drift:test')`,
    );
    const r = await runReconcile();
    expect(r.balanced).toBe(false);
    expect(r.points_outstanding_cents).toBe(1000);
    expect(r.reserve_net_cents).toBe(1500);
    expect(r.diff_cents).toBe(-500);
    const events = await diffEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      period: r.period,
      points_outstanding_cents: 1000,
      reserve_net_cents: 1500,
      diff_cents: -500,
    });
  });

  it('对平（空库）：两侧均 0=平衡；重跑不平轮不重复出箱由 job 事务幂等承载（同轮只出一次）', async () => {
    const r = await runReconcile();
    expect(r).toMatchObject({ balanced: true, points_outstanding_cents: 0, reserve_net_cents: 0 });
    expect(await diffEvents()).toHaveLength(0);
  });

  // ---------- RESERVE_RECONCILE 执行器（目录第 26 项） ----------

  it('执行器注册进 I2 registry（目录名 RESERVE_RECONCILE）；ensureDailyJobScheduled 幂等（同键去重，due=上海 04:00）', async () => {
    const registry = app.get(ScheduleExecutorRegistry);
    expect(registry.has('RESERVE_RECONCILE')).toBe(true);
    const executors = app.get(ReserveJobExecutors);
    const first = await executors.ensureDailyJobScheduled();
    const second = await executors.ensureDailyJobScheduled();
    expect(first.registered).toBe(true);
    expect(second.registered).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    // job 读数经 schedule 域 fixture（owner 直读点；跨域 spec 只 import 函数不内联表名）
    const jobs = await listJobsByType(pool, 'RESERVE_RECONCILE');
    expect(jobs).toHaveLength(1);
    // 上海 04:00 = UTC 20:00（前日）——小时位校验
    const dueHourShanghai = new Date(jobs[0]!.due_at).getUTCHours() + 8;
    expect(dueHourShanghai % 24).toBe(4);
    // 台账无漂移 → 平衡（execute 走 reconcile 同核，已由上方用例覆盖；此处零漂移复跑）
    const r = await runReconcile();
    expect(r.balanced).toBe(true);
  });

  it('recordInTx 防御：非正记账额/越域 ref 抛错（不变量显性化，不落半行）', async () => {
    await expect(
      poolSvc.withTransaction((uow: SqlExecutor) => reserve.recordInTx(uow, 'ACCRUE', 0, 'x')),
    ).rejects.toThrow();
    await expect(
      poolSvc.withTransaction((uow: SqlExecutor) => reserve.recordInTx(uow, 'ACCRUE', 10, '')),
    ).rejects.toThrow();
    expect(await ledgerRows()).toHaveLength(0);
  });

  // ---------- 修复环 I-2：executor execute 全路径端到端（自投→reconcile→DONE detail） ----------

  it('I-2 端到端：过去时刻 due job → tick 常规通道真执行 → DONE（detail 承载对平结果+悬空核对计数+自投下一日）；漂移轮 detail balanced=false', async () => {
    const scheduler = app.get(SchedulerService);
    // 过去时刻 due（misfire 自愈口径——registerJob 显式许可）；refId 取历史日期确定性键
    await poolSvc.withTransaction((uow: SqlExecutor) =>
      scheduler.registerJob(uow, {
        jobType: 'RESERVE_RECONCILE',
        refType: 'daily',
        refId: 20200101,
        dueAt: new Date(Date.now() - 60_000),
      }),
    );
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBe(1);

    // 原 job DONE + 执行器自投下一日 PENDING（同 type 两行）
    const jobs = await listJobsByType(pool, 'RESERVE_RECONCILE');
    expect(jobs.map((j) => j.status).sort()).toEqual(['DONE', 'PENDING']);
    const pending = jobs.find((j) => j.status === 'PENDING');
    expect(pending).toBeDefined();
    const dueHourShanghai = new Date(pending!.due_at).getUTCHours() + 8;
    expect(dueHourShanghai % 24).toBe(4);

    // DONE detail=execute 返回值序列化（对平结果+悬空计数+next 锚——「不建 run 表」的记录承载）
    const log = await lastJobLogOf(pool, 'RESERVE_RECONCILE');
    expect(log).not.toBeNull();
    expect(log!.result).toBe('DONE');
    const detail = JSON.parse(log!.detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({
      balanced: true,
      points_outstanding_cents: 0,
      reserve_net_cents: 0,
      diff_cents: 0,
      dangling_checked_sessions: 0,
      dangling_sessions: 0,
    });
    expect(typeof detail['period']).toBe('string');
    expect(typeof detail['next_job_id']).toBe('number');
    expect(typeof detail['next_due_at']).toBe('string');

    // 漂移轮：detail balanced=false + diff 与台账漂移一致（不平衡→ReserveDiffFound 出箱在 reconcile 用例已钉）
    await pool.query(
      `INSERT INTO benefits.reserve_ledgers (period, entry, amount, ref_id)
       VALUES ((now() AT TIME ZONE 'Asia/Shanghai')::date, 'ACCRUE', 2.00, 'drift:e2e')`,
    );
    await poolSvc.withTransaction((uow: SqlExecutor) =>
      scheduler.registerJob(uow, {
        jobType: 'RESERVE_RECONCILE',
        refType: 'daily',
        refId: 20200102,
        dueAt: new Date(Date.now() - 60_000),
      }),
    );
    const ticked2 = await scheduler.tick('normal');
    expect(ticked2.done).toBe(1);
    const log2 = await lastJobLogOf(pool, 'RESERVE_RECONCILE');
    const detail2 = JSON.parse(log2!.detail ?? '{}') as Record<string, unknown>;
    expect(detail2).toMatchObject({ balanced: false, diff_cents: -200 });
    expect(await diffEvents()).toHaveLength(1);
  });

  // ---------- 修复环 I-3：悬空分成附带核对（判定流静默 48h 应发未发检出） ----------

  /** 播种一组场次判定留痕（合成事件直投 outbox——D3 生产形状）并整体回拨 hours 小时 */
  const seedAdjudications = async (
    sessionId: number,
    members: ReadonlyArray<{
      owner_type: 'user' | 'lawyer';
      owner_id: number;
      result: 'normal' | 'late' | 'absent';
    }>,
    hoursAgo: number,
  ): Promise<void> => {
    let seq = 0;
    for (const m of members) {
      seq += 1;
      await poolSvc.withTransaction((uow: SqlExecutor) =>
        outbox.recordOutbox(uow, {
          type: ATTENDANCE_ADJUDICATED_TOPIC,
          payload: {
            adjudication_id: sessionId * 100 + seq,
            session_id: sessionId,
            owner_type: m.owner_type,
            owner_id: m.owner_id,
            result: m.result,
          },
        }),
      );
    }
    await pool.query(
      `UPDATE platform.outbox SET created_at = now() - ($2::bigint * interval '1 hour')
        WHERE topic = $1 AND payload->>'session_id' = $3`,
      [ATTENDANCE_ADJUDICATED_TOPIC, hoursAgo, String(sessionId)],
    );
  };

  const danglingEvents = async () => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [ABSENCE_SHARE_DANGLING_TOPIC],
    );
    return res.rows.map((r) => r.payload);
  };

  it('I-3 悬空检出：判定流静默 49h（律师 normal+缺席 2+到场 1）且无 ABSENCE_SHARE 流水 → AbsenceShareDangling 出箱；重跑同轮幂等由事件至多一轮一条', async () => {
    await seedAdjudications(
      501,
      [
        { owner_type: 'lawyer', owner_id: 9711, result: 'normal' },
        { owner_type: 'user', owner_id: 7301, result: 'absent' },
        { owner_type: 'user', owner_id: 7302, result: 'absent' },
        { owner_type: 'user', owner_id: 7303, result: 'normal' },
      ],
      49,
    );
    const r = await poolSvc.withTransaction((uow: SqlExecutor) =>
      reserve.detectDanglingAbsenceShares(uow),
    );
    expect(r).toEqual({ checked_sessions: 1, dangling_sessions: 1 });
    const events = await danglingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ session_id: 501, absent_users: 2, attending_users: 1 });
    // 重跑：仍无流水 → 再检出一条（每轮一条——工单一場一单幂等在 H3 消费侧兜底；同轮内事务原子）
    const r2 = await poolSvc.withTransaction((uow: SqlExecutor) =>
      reserve.detectDanglingAbsenceShares(uow),
    );
    expect(r2.dangling_sessions).toBe(1);
    expect(await danglingEvents()).toHaveLength(2);
  });

  it('I-3 清零面：已发放场次（有 absence:{sid} 流水）/律师缺席场/未到静默窗（1h）→ 零检出', async () => {
    // ①已发放：同形态留痕 + 对应 ABSENCE_SHARE 流水（grant 落 absence:502）
    await seedAdjudications(
      502,
      [
        { owner_type: 'lawyer', owner_id: 9712, result: 'normal' },
        { owner_type: 'user', owner_id: 7311, result: 'absent' },
        { owner_type: 'user', owner_id: 7312, result: 'late' },
      ],
      49,
    );
    await points.grant({
      user_id: 7312,
      points: 100,
      kind: 'ABSENCE_SHARE',
      ref: 'absence:502',
    });
    // ②律师缺席场：整场全额退款路径，无 30% 池——非悬空
    await seedAdjudications(
      503,
      [
        { owner_type: 'lawyer', owner_id: 9713, result: 'absent' },
        { owner_type: 'user', owner_id: 7321, result: 'absent' },
        { owner_type: 'user', owner_id: 7322, result: 'normal' },
      ],
      49,
    );
    // ③未到静默窗：判定流 1h 前（判定后不久——消费器可能尚未触发完成门）
    await seedAdjudications(
      504,
      [
        { owner_type: 'lawyer', owner_id: 9714, result: 'normal' },
        { owner_type: 'user', owner_id: 7331, result: 'absent' },
        { owner_type: 'user', owner_id: 7332, result: 'normal' },
      ],
      1,
    );
    const r = await poolSvc.withTransaction((uow: SqlExecutor) =>
      reserve.detectDanglingAbsenceShares(uow),
    );
    expect(r).toEqual({ checked_sessions: 2, dangling_sessions: 0 }); // ①②入候选（静默超窗）③未入
    expect(await danglingEvents()).toHaveLength(0);
  });
});
