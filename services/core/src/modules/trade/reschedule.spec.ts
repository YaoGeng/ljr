import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import {
  ErrorCode,
  RESCHEDULE_CONFIRMED_TOPIC,
  RESCHEDULE_REQUESTED_TOPIC,
  type RescheduleConfirmedPayload,
  type RescheduleRequestedPayload,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { backdateJobDue, jobStatusRaw, remindJobSnapshotRaw } from '../schedule/job-fixture';
import { SchedulerService } from '../schedule/scheduler.service';
import { createRescheduleConfirmedHandler } from '../notify/reminder.consumer';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { EnrollmentService } from './enrollment.service';
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from './trade-fixture';
import { RescheduleService } from './reschedule.service';

/**
 * C5 领域层（需 PG；M2-W2 T5）：申请-撤回-律师确认-超时回退。
 * 覆盖（C5 §7 R-01~R-04 + §9 附加 + §10 四条验收 + 执行计划 T5 验收）：
 *   - R-01 2h 边界两侧（申请窗锚=原场次 slot_start）；
 *   - R-02 reschedule_used 一次（夹具直置+确认后新行再申请 409）；
 *   - R-03 快照价沿用（新行 price_snapshot/金额列与旧行逐字相等，不重算）；
 *   - R-04 超时回退原报名完全不动（状态/used/joined/REMIND job 全不变）；
 *   - §4 确认事务逐字：空位守卫（FOR UPDATE 并发安全——两请求抢 1 空位恰一成功）→旧行
 *     RESCHEDULED_OUT（§9 禁 UPDATE：业务列逐字不动）→新建行（prev 回链+reschedule_used=true）
 *     →目标 joined+1（满员 markFull）→旧场次 joined-1（席位回吐裁定）→job 作废→出箱；
 *   - §10④ 提醒重投：REMIND×4 场次锚零操作（不作废不预写——PAID 清单动态承载，D2 消费面
 *     =防御复核 handler 直调）；旧段 PAID 清单跌出改期者/目标段含迁移行；
 *   - 幂等：申请同目标重放/确认 CONFIRMED 短路；守卫矩阵（403 RESTRICTED/409 NO_SEAT|USED|
 *     EXPIRED|CONFIRMED）；executor recheck 业务先到 CANCELLED。
 * 驱动：调度器/relay 不自启动——手动 tick（scheduler normal 通道）。
 */

const HOUR = 3_600_000;
const LAWYER = 9101;
const LAWYER_OTHER = 9102;
const U1 = 6101;
const U2 = 6102;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** 迁移用六键快照（V26 头注⑦ 形状；share_price=null=B2C 场次报名行语义） */
const snapOf = (unit: string) => ({
  price_mode: 'per_head',
  unit_price: unit,
  share_price: null,
  session_total: unit,
  price_version: 1,
  snapshot_at: new Date('2026-10-15T08:00:00.000Z').toISOString(),
});

interface EnrollmentRaw {
  id: number;
  ref_type: string;
  ref_id: number;
  user_id: number;
  pay_status: string;
  reschedule_used: boolean;
  prev_enrollment_id: number | null;
  price_snapshot: Record<string, unknown>;
  unit_price: string;
  paid_amount: string;
  cash_amount: string;
  points_amount: number;
  price_version_id: number;
  credit_used: number;
}

describe('C5 改期（apply/cancel/confirm/超时回退，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let reschedules: RescheduleService;
  let enrollments: EnrollmentService;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;

  const hoursFromNow = (h: number): Date => new Date(Date.now() + h * HOUR);

  /** 原场次（CREATED，slot_start 显式）+U1 的 PAID 报名（六键快照；源场次占位 joined=1） */
  const seedReady = async (
    sourceSlot: Date,
    userId = U1,
  ): Promise<{
    sourceId: number;
    enrollId: number;
  }> => {
    const sourceId = await seedSessionAtRaw(pool, LAWYER, 'CREATED', sourceSlot);
    const enrollId = await seedPaidEnrollmentRaw(pool, 'session', sourceId, {
      userId,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
      snapshot: snapOf('100.00'),
    });
    await pool.query(`UPDATE trade.sessions SET joined = 1 WHERE id = $1`, [sourceId]);
    return { sourceId, enrollId };
  };

  /** 目标场次（同律师 CREATED；capacity/joined 可调） */
  const seedTarget = async (capacity = 5, joined = 0, lawyerId = LAWYER): Promise<number> => {
    const id = await seedSessionAtRaw(pool, lawyerId, 'CREATED', hoursFromNow(48));
    await pool.query(`UPDATE trade.sessions SET capacity = $2, joined = $3 WHERE id = $1`, [
      id,
      capacity,
      joined,
    ]);
    return id;
  };

  const requestStatus = async (requestId: number): Promise<string> => {
    const res = await pool.query<{ status: string }>(
      `SELECT status FROM trade.reschedule_requests WHERE id = $1`,
      [requestId],
    );
    return res.rows[0]!.status;
  };

  const jobRow = async (
    jobType: string,
    refType: string,
    refId: number,
  ): Promise<{ status: string } | undefined> => {
    const status = await jobStatusRaw(pool, jobType, refType, refId);
    return status === undefined ? undefined : { status };
  };

  /** REMIND×4 状态快照（提醒不变断言锚：作废/预写任一动作都会改变此集合；schedule owner fixture） */
  const remindSnapshot = (sessionId: number): Promise<string[]> =>
    remindJobSnapshotRaw(pool, sessionId);

  const seedRemind = async (sessionId: number): Promise<void> => {
    for (const [jobType, offsetH] of [
      ['REMIND_24H', 24],
      ['REMIND_1H', 1],
    ] as const) {
      await poolSvc.withTransaction((uow) =>
        scheduler.registerJob(uow, {
          jobType,
          refType: 'session',
          refId: sessionId,
          dueAt: hoursFromNow(48 - offsetH),
        }),
      );
    }
  };

  const countOutbox = async (topic: string): Promise<number> => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [topic],
    );
    return res.rows[0]!.n;
  };

  const outboxPayload = async <T>(topic: string): Promise<T> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id DESC LIMIT 1`,
      [topic],
    );
    return res.rows[0]!.payload as T;
  };

  const enrollmentRaw = async (id: number): Promise<EnrollmentRaw | undefined> => {
    const res = await pool.query(
      `SELECT id::int AS id, ref_type, ref_id::int AS ref_id, user_id::int AS user_id, pay_status,
              reschedule_used, prev_enrollment_id::int AS prev_enrollment_id, price_snapshot,
              unit_price::text AS unit_price, paid_amount::text AS paid_amount,
              cash_amount::text AS cash_amount, points_amount, price_version_id::int AS price_version_id,
              credit_used
         FROM trade.enrollments WHERE id = $1`,
      [id],
    );
    return res.rows[0] as EnrollmentRaw | undefined;
  };

  const sessionJoined = async (id: number): Promise<{ joined: number; status: string }> => {
    const res = await pool.query<{ joined: number; status: string }>(
      `SELECT joined, status FROM trade.sessions WHERE id = $1`,
      [id],
    );
    return res.rows[0]!;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app)); // FulfillmentModule 携 D5 WSS 网关（C4 spec 同款）
    await app.init();
    reschedules = app.get(RescheduleService);
    enrollments = app.get(EnrollmentService);
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
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

  // ===========================================================================
  // 申请（§5/R-01/R-02；§10①②）
  // ===========================================================================

  it('申请主链：PENDING 行+expires_at=requested_at+12h+RESCHEDULE_CONFIRM_TIMEOUT job 预写（due=expires_at）+RescheduleRequested 出箱，同事务', async () => {
    const { sourceId, enrollId } = await seedReady(hoursFromNow(25));
    const targetId = await seedTarget();

    const view = await reschedules.apply(enrollId, U1, targetId);
    expect(view.status).toBe('PENDING');
    expect(view.enrollment_id).toBe(enrollId);
    expect(view.target_session_id).toBe(targetId);
    expect(view.confirmed_at).toBeNull();
    // 12h 窗（DB 钟生成；1s 容差）
    const expiresMs = Date.parse(view.expires_at);
    expect(expiresMs - Date.parse(view.requested_at)).toBeGreaterThan(12 * HOUR - 1_000);
    expect(expiresMs - Date.parse(view.requested_at)).toBeLessThan(12 * HOUR + 60_000);

    // 超时 job 预写（ref=reschedule/request_id，due=expires_at 同源同钟）
    const job = await jobRow('RESCHEDULE_CONFIRM_TIMEOUT', 'reschedule', view.id);
    expect(job?.status).toBe('PENDING');

    // 出箱（I1 通知律师位——A.1 冻结形状）
    expect(await countOutbox(RESCHEDULE_REQUESTED_TOPIC)).toBe(1);
    const payload = await outboxPayload<RescheduleRequestedPayload>(RESCHEDULE_REQUESTED_TOPIC);
    expect(payload).toEqual({
      request_id: view.id,
      enrollment_id: enrollId,
      user_id: U1,
      target_session_id: targetId,
    });
    void sourceId;
  });

  it('R-01 2h 边界两侧（锚=原场次 scheduled_start）：1h59m 拒 400 / 2h5m 过；源场次终态 409', async () => {
    const late = await seedReady(hoursFromNow(1 + 59 / 60)); // 1h59m——§10① <2h 拒
    const targetA = await seedTarget();
    await expect(reschedules.apply(late.enrollId, U1, targetA)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
    expect(await countOutbox(RESCHEDULE_REQUESTED_TOPIC)).toBe(0);
    expect(
      await pool.query(`SELECT count(*)::int AS n FROM trade.reschedule_requests`),
    ).toMatchObject({ rows: [{ n: 0 }] });

    const ok = await seedReady(hoursFromNow(2 + 5 / 60)); // 2h5m——边界外通过
    const targetB = await seedTarget();
    const view = await reschedules.apply(ok.enrollId, U1, targetB);
    expect(view.status).toBe('PENDING');

    // 源场次终态（CANCELLED）→ 改期不适用（走 D4 取消链）
    const term = await seedReady(hoursFromNow(25));
    await pool.query(`UPDATE trade.sessions SET status = 'CANCELLED' WHERE id = $1`, [
      term.sourceId,
    ]);
    await expect(reschedules.apply(term.enrollId, U1, targetB)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
  });

  it('R-02 第二次改期 409 USED：reschedule_used 直置（历史行）与确认后新行（reschedule_used=true）双半边', async () => {
    // 半边一：夹具直置历史行 used（§10②）
    const { enrollId } = await seedReady(hoursFromNow(25));
    await pool.query(`UPDATE trade.enrollments SET reschedule_used = true WHERE id = $1`, [
      enrollId,
    ]);
    const target = await seedTarget();
    await expect(reschedules.apply(enrollId, U1, target)).rejects.toMatchObject({
      code: ErrorCode.RescheduleUsed,
      httpStatus: 409,
    });

    // 半边二：确认主链后新行 reschedule_used=true → 再申请 409（用例 10 细化此处只守卫矩阵）
    const { enrollId: e2 } = await seedReady(hoursFromNow(25));
    const target2 = await seedTarget();
    const view = await reschedules.apply(e2, U1, target2);
    await reschedules.confirm(view.id, LAWYER);
    const newRow = (
      await pool.query<{ id: string }>(
        `SELECT id FROM trade.enrollments WHERE prev_enrollment_id = $1`,
        [e2],
      )
    ).rows[0]!;
    await expect(reschedules.apply(Number(newRow.id), U1, target2)).rejects.toMatchObject({
      code: ErrorCode.RescheduleUsed,
    });
  });

  it('属主/形态守卫：非属主 403 RESTRICTED（§5）；非 session 型/非 PAID 409', async () => {
    const { enrollId } = await seedReady(hoursFromNow(25));
    const target = await seedTarget();
    await expect(reschedules.apply(enrollId, U2, target)).rejects.toMatchObject({
      code: ErrorCode.Restricted,
      httpStatus: 403,
    });
    // 非 PAID（REFUNDED）
    await pool.query(`UPDATE trade.enrollments SET pay_status = 'REFUNDED' WHERE id = $1`, [
      enrollId,
    ]);
    await expect(reschedules.apply(enrollId, U1, target)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
    await expect(reschedules.apply(999999, U1, target)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });

  it('NO_SEAT 申请守卫（§1 边界=同律师既有报名中场次空位）：满员/非同律师/非 CREATED 各拒 409；目标=原场次 400', async () => {
    const { sourceId, enrollId } = await seedReady(hoursFromNow(25));
    const full = await seedTarget(5, 5); // 满员
    await expect(reschedules.apply(enrollId, U1, full)).rejects.toMatchObject({
      code: ErrorCode.NoSeat,
      httpStatus: 409,
    });
    const otherLawyer = await seedTarget(5, 0, LAWYER_OTHER); // 非同律师
    await expect(reschedules.apply(enrollId, U1, otherLawyer)).rejects.toMatchObject({
      code: ErrorCode.NoSeat,
    });
    await pool.query(`UPDATE trade.sessions SET status = 'FULL' WHERE id = $1`, [otherLawyer]); // 复用行：改回同律师+FULL 状态（非 CREATED）
    await pool.query(`UPDATE trade.sessions SET lawyer_id = $2 WHERE id = $1`, [
      otherLawyer,
      LAWYER,
    ]);
    await expect(reschedules.apply(enrollId, U1, otherLawyer)).rejects.toMatchObject({
      code: ErrorCode.NoSeat,
    });
    await expect(reschedules.apply(enrollId, U1, sourceId)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument, // 目标与原场次相同
      httpStatus: 400,
    });
    await expect(reschedules.apply(enrollId, U1, 999999)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });

  it('幂等键=enrollment：已有 PENDING 同目标幂等返回原请求（零新行零新 job 零新事件）/异目标 409', async () => {
    const { enrollId } = await seedReady(hoursFromNow(25));
    const target = await seedTarget();
    const first = await reschedules.apply(enrollId, U1, target);
    const second = await reschedules.apply(enrollId, U1, target); // 同目标重放
    expect(second.id).toBe(first.id);
    expect(await countOutbox(RESCHEDULE_REQUESTED_TOPIC)).toBe(1);

    const other = await seedTarget();
    await expect(reschedules.apply(enrollId, U1, other)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
  });

  // ===========================================================================
  // 撤回（§2/§5）
  // ===========================================================================

  it('撤回主链：PENDING→CANCELLED+超时 job 同事务作废（幽灵执行禁令）；重放幂等；已 CONFIRMED 409', async () => {
    const { enrollId } = await seedReady(hoursFromNow(25));
    const target = await seedTarget();
    const view = await reschedules.apply(enrollId, U1, target);

    const out = await reschedules.cancel(view.id, U1);
    expect(out).toEqual({ status: 'CANCELLED' });
    expect(await requestStatus(view.id)).toBe('CANCELLED');
    // job 作废断言（§10③ 提醒不变/幽灵执行禁令半边——超时 job 不再 fire）
    expect((await jobRow('RESCHEDULE_CONFIRM_TIMEOUT', 'reschedule', view.id))?.status).toBe(
      'CANCELLED',
    );
    // 幂等重放
    expect(await reschedules.cancel(view.id, U1)).toEqual({ status: 'CANCELLED' });
    // 非属主 403
    await expect(reschedules.cancel(view.id, U2)).rejects.toMatchObject({
      code: ErrorCode.Restricted,
    });

    // 已 CONFIRMED 不可撤（§5 409 CONFIRMED）
    const { enrollId: e2 } = await seedReady(hoursFromNow(25));
    const target2 = await seedTarget();
    const view2 = await reschedules.apply(e2, U1, target2);
    await reschedules.confirm(view2.id, LAWYER);
    await expect(reschedules.cancel(view2.id, U1)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
  });

  // ===========================================================================
  // 律师确认（§4 逐字；§10④；R-03；§9 禁 UPDATE；并发抢占）
  // ===========================================================================

  it('确认主链（§4 逐字+§10④+R-03+§9）：旧行 RESCHEDULED_OUT 业务列逐字不动+新行快照逐字复制+prev 回链+used=true+目标 joined+1/旧场次 joined-1+job 作废+出箱+提醒重投（REMIND 零操作+PAID 清单动态）+幂等重放', async () => {
    const { sourceId, enrollId } = await seedReady(hoursFromNow(25));
    const targetId = await seedTarget(5, 0);
    const before = await enrollmentRaw(enrollId);
    expect(before).toBeDefined();
    // REMIND×2 预插（源+目标）——确认事务对 REMIND 零操作的断言锚
    await seedRemind(sourceId);
    await seedRemind(targetId);
    const remindBeforeSource = await remindSnapshot(sourceId);
    const remindBeforeTarget = await remindSnapshot(targetId);

    const view = await reschedules.apply(enrollId, U1, targetId);
    const out = await reschedules.confirm(view.id, LAWYER);
    expect(out.new_enrollment_id).toBeGreaterThan(0);

    // 请求 CONFIRMED+confirmed_at 落值；超时 job 作废
    const reqRow = (
      await pool.query<{ status: string; confirmed_at: Date | null }>(
        `SELECT status, confirmed_at FROM trade.reschedule_requests WHERE id = $1`,
        [view.id],
      )
    ).rows[0]!;
    expect(reqRow.status).toBe('CONFIRMED');
    expect(reqRow.confirmed_at).not.toBeNull();
    expect((await jobRow('RESCHEDULE_CONFIRM_TIMEOUT', 'reschedule', view.id))?.status).toBe(
      'CANCELLED',
    );

    // 旧行：pay_status=RESCHEDULED_OUT + §9 业务列逐字不动（快照/金额/版本/used 均不 UPDATE）
    const oldRow = await enrollmentRaw(enrollId);
    expect(oldRow!.pay_status).toBe('RESCHEDULED_OUT');
    expect(oldRow!.ref_type).toBe(before!.ref_type);
    expect(oldRow!.ref_id).toBe(before!.ref_id);
    expect(oldRow!.user_id).toBe(before!.user_id);
    expect(oldRow!.price_snapshot).toEqual(before!.price_snapshot); // R-03 源
    expect(oldRow!.unit_price).toBe(before!.unit_price);
    expect(oldRow!.paid_amount).toBe(before!.paid_amount);
    expect(oldRow!.cash_amount).toBe(before!.cash_amount);
    expect(oldRow!.points_amount).toBe(before!.points_amount);
    expect(oldRow!.price_version_id).toBe(before!.price_version_id);
    expect(oldRow!.credit_used).toBe(before!.credit_used);
    expect(oldRow!.reschedule_used).toBe(false); // used 标记只落新行（旧行内容禁 UPDATE）

    // 新行：session 型+PAID 出生态+prev 回链+reschedule_used=true+R-03 快照逐字相等（不重算）
    const newRow = await enrollmentRaw(out.new_enrollment_id);
    expect(newRow!.ref_type).toBe('session');
    expect(newRow!.ref_id).toBe(targetId);
    expect(newRow!.user_id).toBe(U1);
    expect(newRow!.pay_status).toBe('PAID');
    expect(newRow!.prev_enrollment_id).toBe(enrollId);
    expect(newRow!.reschedule_used).toBe(true);
    expect(newRow!.price_snapshot).toEqual(before!.price_snapshot);
    expect(newRow!.unit_price).toBe(before!.unit_price);
    expect(newRow!.paid_amount).toBe(before!.paid_amount);
    expect(newRow!.cash_amount).toBe(before!.cash_amount);
    expect(newRow!.points_amount).toBe(before!.points_amount);
    expect(newRow!.price_version_id).toBe(before!.price_version_id);
    expect(newRow!.credit_used).toBe(before!.credit_used);

    // 目标 joined+1（§10④ 新段半边）；旧场次 joined-1（席位回吐裁定：1→0）
    expect(await sessionJoined(targetId)).toMatchObject({ joined: 1, status: 'CREATED' });
    expect(await sessionJoined(sourceId)).toMatchObject({ joined: 0 });

    // 出箱（A.1 冻结形状）
    expect(await countOutbox(RESCHEDULE_CONFIRMED_TOPIC)).toBe(1);
    const payload = await outboxPayload<RescheduleConfirmedPayload>(RESCHEDULE_CONFIRMED_TOPIC);
    expect(payload).toEqual({
      old_enrollment_id: enrollId,
      new_enrollment_id: out.new_enrollment_id,
      session_id: targetId,
      user_id: U1,
    });

    // §10④ 提醒重投：REMIND×4 场次锚零操作（旧/目标均不作废不预写——集合逐字不变）
    expect(await remindSnapshot(sourceId)).toEqual(remindBeforeSource);
    expect(await remindSnapshot(targetId)).toEqual(remindBeforeTarget);
    // PAID 清单动态承载：改期者跌出旧场次、进入目标场次
    const sourcePaid = await enrollments.listPaidEnrollmentUsers(poolSvc, sourceId);
    const targetPaid = await enrollments.listPaidEnrollmentUsers(poolSvc, targetId);
    expect(sourcePaid.map((p) => p.user_id)).not.toContain(U1);
    expect(targetPaid).toContainEqual({ enrollment_id: out.new_enrollment_id, user_id: U1 });

    // D2 消费面=防御复核（reminder.consumer）：真载荷通过零动作
    const handler = createRescheduleConfirmedHandler(enrollments);
    await expect(
      handler(
        {
          id: 1,
          eventId: 'ev-1',
          topic: RESCHEDULE_CONFIRMED_TOPIC,
          payload,
          retryCount: 0,
        },
        poolSvc,
      ),
    ).resolves.toBeUndefined();
    // 漂移载荷（错报名 id）→ 显性化进重试轨道（不静默）
    await expect(
      handler(
        {
          id: 2,
          eventId: 'ev-2',
          topic: RESCHEDULE_CONFIRMED_TOPIC,
          payload: { ...payload, new_enrollment_id: enrollId },
          retryCount: 0,
        },
        poolSvc,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });

    // 幂等重放（幂等键=request）：同 new_enrollment_id+零新副作用（无新行/新事件/新状态迁移）
    const replay = await reschedules.confirm(view.id, LAWYER);
    expect(replay.new_enrollment_id).toBe(out.new_enrollment_id);
    expect(await countOutbox(RESCHEDULE_CONFIRMED_TOPIC)).toBe(1);
    expect(
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trade.enrollments`)).rows[0]!
        .n,
    ).toBe(2); // 旧行+新行恰两行

    // 律师非属主（目标场次属主校验，C4 先例口径）：NotFound 不暴露他人物
    const { enrollId: e2 } = await seedReady(hoursFromNow(25));
    const target2 = await seedTarget();
    const view2 = await reschedules.apply(e2, U1, target2);
    await expect(reschedules.confirm(view2.id, LAWYER_OTHER)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    // M-2（评审）：属主校验前移至 CONFIRMED 幂等短路之前——非属主律师经重放面探测
    // new_enrollment_id 同样 NotFound（不泄露迁移结果）
    const confirmed = await reschedules.confirm(view2.id, LAWYER);
    await expect(reschedules.confirm(view2.id, LAWYER_OTHER)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    void confirmed;
  });

  it('I-1 活跃报名守卫：apply 软检查 400（目标已有 PENDING 单）；确认前新下 PENDING 单 → confirm 409 E_CONFLICT 非 500+请求 FAILED；撤单后重开申请 confirm 成功', async () => {
    const { sourceId, enrollId } = await seedReady(hoursFromNow(25));
    const targetId = await seedTarget();

    // apply 软检查：目标场次已有该用户 PENDING 单（未支付）→ 400 同语义拒
    const pendingId = (
      await pool.query<{ id: string }>(
        `INSERT INTO trade.enrollments
           (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
            points_amount, price_version_id, pay_status, credit_used)
         VALUES ('session', $1, $2, $3::jsonb, '100.00', '100.00', '100.00', 0, 1, 'PENDING', 0)
         RETURNING id`,
        [targetId, U1, JSON.stringify(snapOf('100.00'))],
      )
    ).rows[0]!.id;
    await expect(reschedules.apply(enrollId, U1, targetId)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });

    // 撤单（PENDING→REFUNDED 收敛，活跃集移出）→ apply 通过；确认前再下 PENDING 单 →
    // confirm 撞 NOT EXISTS 权威守卫：409 E_CONFLICT（**非 500**——无此前置则迁移 INSERT
    // 撞 ux_enroll_active 唯一索引 23505 直接冒泡）+请求置 FAILED+旧行不动
    await enrollments.advanceToRefunded(Number(pendingId), 'test:pending_withdrawn');
    const view = await reschedules.apply(enrollId, U1, targetId);
    const pendingId2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO trade.enrollments
           (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
            points_amount, price_version_id, pay_status, credit_used)
         VALUES ('session', $1, $2, $3::jsonb, '100.00', '100.00', '100.00', 0, 1, 'PENDING', 0)
         RETURNING id`,
        [targetId, U1, JSON.stringify(snapOf('100.00'))],
      )
    ).rows[0]!.id;
    await expect(reschedules.confirm(view.id, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    expect(await requestStatus(view.id)).toBe('FAILED');
    expect((await enrollmentRaw(enrollId))!.pay_status).toBe('PAID'); // 旧行不动
    expect(await countOutbox(RESCHEDULE_CONFIRMED_TOPIC)).toBe(0);

    // 撤单后重开申请 → confirm 成功（新行落成，迁移链完整）
    await enrollments.advanceToRefunded(Number(pendingId2), 'test:pending_withdrawn');
    const view2 = await reschedules.apply(enrollId, U1, targetId);
    const out = await reschedules.confirm(view2.id, LAWYER);
    expect(out.new_enrollment_id).toBeGreaterThan(0);
    const newRow = await enrollmentRaw(out.new_enrollment_id);
    expect(newRow).toMatchObject({
      ref_type: 'session',
      ref_id: targetId,
      user_id: U1,
      pay_status: 'PAID',
      prev_enrollment_id: enrollId,
      reschedule_used: true,
    });
    expect((await enrollmentRaw(enrollId))!.pay_status).toBe('RESCHEDULED_OUT');
    void sourceId;
  });

  it('确认 NO_SEAT（申请后目标被并发占满）：409+请求置 FAILED（随事务提交）+原报名完全不动', async () => {
    const { sourceId, enrollId } = await seedReady(hoursFromNow(25));
    const targetId = await seedTarget(5, 0); // 申请时空位充足（申请软守卫过）
    const view = await reschedules.apply(enrollId, U1, targetId);
    await pool.query(`UPDATE trade.sessions SET joined = 5 WHERE id = $1`, [targetId]); // 确认前被并发占满

    await expect(reschedules.confirm(view.id, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.NoSeat,
      httpStatus: 409,
    });
    expect(await requestStatus(view.id)).toBe('FAILED');
    expect((await enrollmentRaw(enrollId))!.pay_status).toBe('PAID'); // 原报名不动
    expect(await sessionJoined(sourceId)).toMatchObject({ joined: 1 });
    expect(await countOutbox(RESCHEDULE_CONFIRMED_TOPIC)).toBe(0);
    // FAILED 终态：再确认 409
    await expect(reschedules.confirm(view.id, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
  });

  it('并发抢占最后空位（§8/§9）：目标剩 1 位（capacity=2 已占 1——V23 capacity 下界 2），两改期请求同 confirm 恰一成功一 NO_SEAT(FAILED)；成功侧满员 markFull', async () => {
    const targetId = await seedTarget(2, 1); // capacity∈[2,50]，剩 1 位
    const a = await seedReady(hoursFromNow(25), U1);
    const b = await seedReady(hoursFromNow(26), U2);
    const viewA = await reschedules.apply(a.enrollId, U1, targetId);
    const viewB = await reschedules.apply(b.enrollId, U2, targetId);

    const results = await Promise.allSettled([
      reschedules.confirm(viewA.id, LAWYER),
      reschedules.confirm(viewB.id, LAWYER),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as Array<PromiseRejectedResult>;
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as { code: string }).code).toBe(ErrorCode.NoSeat);

    // 赢家 +1 → joined=2=capacity：满员即成团（markFull 同事务，R-02/C4 confirm 先例）
    expect(await sessionJoined(targetId)).toMatchObject({ joined: 2, status: 'FULL' });
    // 恰一请求 CONFIRMED、一 FAILED
    const statuses = [await requestStatus(viewA.id), await requestStatus(viewB.id)].sort();
    expect(statuses).toEqual(['CONFIRMED', 'FAILED']);
    // 败者原报名不动
    for (const [view, enrollId] of [
      [viewA, a.enrollId],
      [viewB, b.enrollId],
    ] as const) {
      if ((await requestStatus(view.id)) === 'FAILED') {
        expect((await enrollmentRaw(enrollId))!.pay_status).toBe('PAID');
      }
    }
  });

  // ===========================================================================
  // 超时回退（R-04/§10③；executor=recheck/execute）
  // ===========================================================================

  it('超时回退（§10③/R-04）：job fire → PENDING→EXPIRED+原报名状态与提醒完全不变（PAID/used/joined/REMIND job 全不动）+job DONE；再 confirm 409 EXPIRED', async () => {
    const { sourceId, enrollId } = await seedReady(hoursFromNow(25));
    const targetId = await seedTarget();
    await seedRemind(sourceId); // 提醒锚
    const remindBefore = await remindSnapshot(sourceId);
    const beforeUsed = (await enrollmentRaw(enrollId))!.reschedule_used;

    const view = await reschedules.apply(enrollId, U1, targetId);
    await backdateJobDue(pool, 'RESCHEDULE_CONFIRM_TIMEOUT', 'reschedule', view.id);
    await scheduler.tick('normal');

    expect(await requestStatus(view.id)).toBe('EXPIRED');
    expect((await jobRow('RESCHEDULE_CONFIRM_TIMEOUT', 'reschedule', view.id))?.status).toBe(
      'DONE',
    );
    // 原报名完全不动（R-04 幂等回退）
    const row = await enrollmentRaw(enrollId);
    expect(row!.pay_status).toBe('PAID');
    expect(row!.reschedule_used).toBe(beforeUsed); // false——改期权未消耗
    expect(await sessionJoined(sourceId)).toMatchObject({ joined: 1 });
    expect(await remindSnapshot(sourceId)).toEqual(remindBefore); // 提醒不变
    expect(await countOutbox(RESCHEDULE_CONFIRMED_TOPIC)).toBe(0); // 无确认事实
    // 再确认 409 EXPIRED（§5 契约码）
    await expect(reschedules.confirm(view.id, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.RescheduleExpired,
      httpStatus: 409,
    });
    // 回退后可重新申请（ENROLLMENT 幂等键无进行中请求）
    const again = await reschedules.apply(enrollId, U1, targetId);
    expect(again.status).toBe('PENDING');
  });

  it('executor recheck 回查锚（请求非 PENDING → CANCELLED 无操作）：迟到/重注 job 对已 EXPIRED 请求零状态迁移', async () => {
    const { enrollId } = await seedReady(hoursFromNow(25));
    const targetId = await seedTarget();
    const view = await reschedules.apply(enrollId, U1, targetId);
    await backdateJobDue(pool, 'RESCHEDULE_CONFIRM_TIMEOUT', 'reschedule', view.id);
    await scheduler.tick('normal'); // 首轮 fire → EXPIRED（job DONE）
    expect(await requestStatus(view.id)).toBe('EXPIRED');

    // 重注同键 job（幂等键=type+ref 的在册集只数 PENDING|RUNNING——DONE 行不挡新行）：
    // recheck 读请求已非 PENDING → job CANCELLED 无操作（业务先到的兜底双保险半边；
    // cancel/confirm 路径的同事务作废断言见各自用例）
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, {
        jobType: 'RESCHEDULE_CONFIRM_TIMEOUT',
        refType: 'reschedule',
        refId: view.id,
        dueAt: new Date(Date.now() - 1_000),
      }),
    );
    const tick = await scheduler.tick('normal');

    expect(tick.cancelled).toBeGreaterThan(0); // recheck=false → CANCELLED
    expect(await requestStatus(view.id)).toBe('EXPIRED'); // 零状态迁移（守卫拒非法迁移之外的幂等回退）
    expect((await enrollmentRaw(enrollId))!.pay_status).toBe('PAID');
  });

  it('改期后新行语义（T2 confirm-arrival 锚注记）：旧行非 PAID（409 语义）、新行 session 型 PAID 可解析；退款完成收敛经迁移链重定向落新行', async () => {
    const { enrollId } = await seedReady(hoursFromNow(25));
    const targetId = await seedTarget();
    const view = await reschedules.apply(enrollId, U1, targetId);
    const { new_enrollment_id } = await reschedules.confirm(view.id, LAWYER);

    const oldResolved = await enrollments.resolveEnrollment(enrollId);
    expect(oldResolved!.pay_status).toBe('RESCHEDULED_OUT'); // D3 confirm-arrival 的 PAID 守卫天然拒旧行
    const newResolved = await enrollments.resolveEnrollment(new_enrollment_id);
    expect(newResolved).toMatchObject({
      ref_type: 'session',
      ref_id: targetId,
      user_id: U1,
      pay_status: 'PAID', // 确认到场锚新行（D2 §5 幂等键=enrollment 的改期语义）
    });

    // 退款完成收敛（RefundCompleted 消费锚原单幂等键 → advanceToRefunded(oldId)）：
    // RESCHEDULED_OUT 迁移链重定向（T5 扩 V40 CONVERTED_OUT 同构）——新行 PAID→REFUNDED，
    // 旧行保持 RESCHEDULED_OUT 不复活
    const out = await enrollments.advanceToRefunded(enrollId, 'refund_completed:test');
    expect(out.advanced).toBe(true);
    expect((await enrollmentRaw(new_enrollment_id))!.pay_status).toBe('REFUNDED');
    expect((await enrollmentRaw(enrollId))!.pay_status).toBe('RESCHEDULED_OUT');
    // 幂等重放（后继已收敛短路）
    expect(await enrollments.advanceToRefunded(enrollId, 'refund_completed:test')).toEqual({
      advanced: true,
    });
  });
});
