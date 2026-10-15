import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { SLOT_LOCKED_TOPIC } from './slot-lock.events';
import { SlotLockService } from './slot-lock.service';
import { SlotLockModule } from './slot-lock.module';
import { SlotViewCache } from './time-table.cache';
import { TimeTableModule } from './time-table.module';
import { TimeTableService } from './time-table.service';

/**
 * B1 时间表管理 e2e（需 PG）：§5 REST 契约（PUT 幂等键=lawyer+version 乐观并发 409）、
 * R-01 模板变更不影响已排期场次（禁用/替换后 slot_locks 照常活跃 + 视图仍可见）、
 * R-02 模板不参与唯一约束/物化不落库、R-03 时长三档 DB CHECK+应用校验双层、
 * §10-3 状态视图与 slot_locks 一致（60s 进程内缓存适配位 + Slot* 事件消费主动失效真接线）。
 * 用例各自独占 lawyer_id，避免共享缓存实例跨用例串扰。
 */

const LAWYER_A = 9101;
const LAWYER_B = 9102;
const LAWYER_C = 9103;
const LAWYER_D = 9104;
const LAWYER_E = 9105;
const USER_ID = 501;
/** 2026-11-02 = 周一；10:00 上海 = 02:00Z */
const MONDAY = '2026-11-02';
const MON_10 = '2026-11-02T02:00:00.000Z';

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('B1 时间表管理（REST 契约 + R-01/R-02/R-03 + 状态视图缓存失效，需 PG）', () => {
  let pool: Pool;
  let poolSvc: PgPoolService;
  let app: INestApplication;
  let service: TimeTableService;
  let slotLocks: SlotLockService;
  let relay: OutboxRelayService;
  let cache: SlotViewCache;
  let jwt: JwtService;
  let userToken: string;
  /** 各用例律师的本人 token（PUT 身份=claims；用例独占 lawyer_id 亦隔离共享缓存实例） */
  const lawyerTokens = new Map<number, string>();

  /** 直签测试 token（claims 形态与 A1 IdentityTokenService 同款；密钥经 IDENTITY_CONFIG override） */
  const mintToken = async (userId: number, role: 'user' | 'lawyer'): Promise<string> =>
    jwt.signAsync({
      sub: String(userId),
      role,
      roles: role === 'lawyer' ? ['user', 'lawyer'] : ['user'],
    });

  const putSchedule = (lawyerId: number, body: unknown) =>
    request(app.getHttpServer())
      .put('/lawyer/schedule')
      .set('Authorization', `Bearer ${lawyerTokens.get(lawyerId) ?? ''}`)
      .send(body as object);

  const getSchedule = (lawyerId: number) =>
    request(app.getHttpServer()).get(`/lawyer/${lawyerId}/schedule`);

  const getSlots = (lawyerId: number, from: string, to: string) =>
    request(app.getHttpServer()).get(`/lawyer/${lawyerId}/slots?from=${from}&to=${to}`);

  /** 真 B2 加锁（uow 形态，出 SlotLocked 事件） */
  const lock = async (
    lawyerId: number,
    slotStart: Date,
    over: Partial<Parameters<SlotLockService['lockSlot']>[1]> = {},
  ): Promise<{ ok: boolean; lockId?: number; status?: string }> => {
    const result = await poolSvc.withTransaction((uow) =>
      slotLocks.lockSlot(uow, {
        lawyerId,
        slotStart,
        initiatorUserId: USER_ID,
        refType: 'session',
        refId: 7001,
        ...over,
      }),
    );
    return result.ok ? { ok: true, lockId: result.lockId, status: result.status } : { ok: false };
  };

  const templateCount = async (lawyerId: number): Promise<number> => {
    const res = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schedule.time_slot_templates WHERE lawyer_id = $1',
      [lawyerId],
    );
    return res.rows[0]?.n ?? 0;
  };

  const activeLocks = async (lawyerId: number) => {
    const res = await pool.query<{
      slot_start: Date;
      status: string;
      ref_type: string;
      ref_id: string;
    }>(
      `SELECT slot_start, status, ref_type, ref_id FROM schedule.slot_locks
        WHERE lawyer_id = $1 AND status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED') ORDER BY id`,
      [lawyerId],
    );
    return res.rows;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TimeTableModule, SlotLockModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(TimeTableService);
    slotLocks = app.get(SlotLockService);
    relay = app.get(OutboxRelayService);
    cache = app.get(SlotViewCache);
    poolSvc = app.get(PgPoolService);
    jwt = app.get(JwtService);
    for (const id of [LAWYER_A, LAWYER_B, LAWYER_C, LAWYER_D, LAWYER_E]) {
      lawyerTokens.set(id, await mintToken(id, 'lawyer'));
    }
    userToken = await mintToken(USER_ID, 'user');
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

  // ---------- §5 PUT /lawyer/schedule：幂等键=lawyer+version（乐观并发） + 鉴权 ----------

  it('PUT：未认证 401 / user 角色 403 E_ROLE_FORBIDDEN / lawyer 本人成功 {version:1, templates 归一}；同 version 重放 409 E_VERSION_MISMATCH', async () => {
    const body = {
      version: 0,
      templates: [{ weekday: 1, start_time: '10:00', duration_small: 60 }],
    };
    const anon = await request(app.getHttpServer()).put('/lawyer/schedule').send(body);
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const asUser = await request(app.getHttpServer())
      .put('/lawyer/schedule')
      .set('Authorization', `Bearer ${userToken}`)
      .send(body as object);
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe(ErrorCode.RoleForbidden);

    const ok = await putSchedule(LAWYER_A, body);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
    expect(ok.body.templates).toEqual([
      {
        id: expect.any(Number),
        weekday: 1,
        start_time: '10:00:00',
        duration_small: 60,
        enabled: true,
      },
    ]);

    // 幂等键=lawyer+version：同 version 重放 → 409（version 语义最小化口径，成功后服务端 +1）
    const replay = await putSchedule(LAWYER_A, body);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe(ErrorCode.VersionMismatch);
  });

  it('PUT 全量替换：version=1 换新模板集 → 旧集删除；GET /lawyer/{id}/schedule 公开回读（无 token 200）', async () => {
    await putSchedule(LAWYER_A, {
      version: 0,
      templates: [
        { weekday: 1, start_time: '10:00', duration_small: 60 },
        { weekday: 3, start_time: '14:30', duration_small: 90, enabled: false },
      ],
    });
    const replaced = await putSchedule(LAWYER_A, {
      version: 1,
      templates: [{ weekday: 5, start_time: '09:00:00', duration_small: 120 }],
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.version).toBe(2);
    expect(replaced.body.templates).toEqual([
      {
        id: expect.any(Number),
        weekday: 5,
        start_time: '09:00:00',
        duration_small: 120,
        enabled: true,
      },
    ]);

    const read = await getSchedule(LAWYER_A); // 最小实现 GET 面不设角色限制（简报裁决，报告标注）
    expect(read.status).toBe(200);
    expect(read.body.version).toBe(2);
    expect(read.body.templates).toEqual(replaced.body.templates);
  });

  it('GET 新律师时间表 → {version: 0, templates: []}（无行=0）；非法路径 id → 400', async () => {
    const fresh = await getSchedule(LAWYER_B);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ version: 0, templates: [] });

    const badId = await request(app.getHttpServer()).get('/lawyer/not-a-number/schedule');
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe(ErrorCode.InvalidArgument);
  });

  // ---------- R-03：时长三档 DB CHECK + 应用校验双层 ----------

  it('R-03 应用层：duration_small=45 / weekday=7 / start_time=25:00 / version=-1 / templates 非数组 → 400 E_INVALID_ARGUMENT', async () => {
    const cases: unknown[] = [
      { version: 0, templates: [{ weekday: 1, start_time: '10:00', duration_small: 45 }] },
      { version: 0, templates: [{ weekday: 7, start_time: '10:00', duration_small: 60 }] },
      { version: 0, templates: [{ weekday: 1, start_time: '25:00', duration_small: 60 }] },
      { version: -1, templates: [] },
      { version: 0, templates: 'nope' },
    ];
    for (const body of cases) {
      const res = await putSchedule(LAWYER_A, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ErrorCode.InvalidArgument);
    }
    expect(await templateCount(LAWYER_A)).toBe(0);
  });

  it('R-03 DB 层：duration_small=45 / weekday=7 裸插 → CHECK 违规 23514', async () => {
    await expect(
      pool.query(
        `INSERT INTO schedule.time_slot_templates (lawyer_id, weekday, start_time, duration_small)
         VALUES ($1, 1, '10:00:00', 45)`,
        [LAWYER_A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO schedule.time_slot_templates (lawyer_id, weekday, start_time, duration_small)
         VALUES ($1, 7, '10:00:00', 60)`,
        [LAWYER_A],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ---------- R-01：模板变更不影响已排期场次 ----------

  it('R-01：物化候选加锁后全量替换清空模板 → slot_locks 照常活跃；视图仍可见（孤儿行）；materializeSlots 不再产候选', async () => {
    const put = await putSchedule(LAWYER_C, {
      version: 0,
      templates: [{ weekday: 1, start_time: '10:00', duration_small: 60 }],
    });
    expect(put.status).toBe(200);

    const candidates = await service.materializeSlots(LAWYER_C, MONDAY);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.slotStart.toISOString()).toBe(MON_10);

    const locked = await lock(LAWYER_C, candidates[0]!.slotStart);
    expect(locked.ok).toBe(true);

    // 模板全量清空（R-01：只影响未来物化候选）
    const cleared = await putSchedule(LAWYER_C, { version: 1, templates: [] });
    expect(cleared.status).toBe(200);
    expect(await templateCount(LAWYER_C)).toBe(0);

    // 既有 slot_locks 照常活跃（R-01 核心断言）
    const locks = await activeLocks(LAWYER_C);
    expect(locks).toHaveLength(1);
    expect(locks[0]!.status).toBe('LOCKED');
    expect(locks[0]!.slot_start.toISOString()).toBe(MON_10);

    // materializeSlots 不再产候选（禁用/删除只影响未来物化）
    expect(await service.materializeSlots(LAWYER_C, MONDAY)).toEqual([]);

    // 但状态视图仍可见已锁场次（已排期场次不受模板变更影响）
    const res = await getSlots(LAWYER_C, MONDAY, MONDAY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { slot_start: MON_10, status: 'LOCKED', ref: { ref_type: 'session', ref_id: 7001 } },
    ]);
  });

  // ---------- R-02：模板不参与唯一约束；物化不落库 ----------

  it('R-02：同段双模板 PUT 成功（无唯一约束）→ materializeSlots 产两个同刻候选；物化前后表计数不变（不落库）', async () => {
    const put = await putSchedule(LAWYER_D, {
      version: 0,
      templates: [
        { weekday: 1, start_time: '10:00', duration_small: 60 },
        { weekday: 1, start_time: '10:00:00', duration_small: 90 },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.templates).toHaveLength(2); // 无业务唯一索引——唯一性防线只在 B2 ux_slot_active

    const before = await templateCount(LAWYER_D);
    const candidates = await service.materializeSlots(LAWYER_D, MONDAY);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.slotStart.toISOString())).toEqual([MON_10, MON_10]);
    expect(candidates.map((c) => c.durationSmall)).toEqual([60, 90]);
    expect(await templateCount(LAWYER_D)).toBe(before); // 物化只算不写
    expect(await pool.query('SELECT count(*)::int AS n FROM schedule.slot_locks')).toMatchObject({
      rows: [{ n: 0 }],
    });
  });

  // ---------- §10-3：状态视图与 slot_locks 一致（60s 缓存适配位 + Slot* 事件主动失效真接线） ----------

  it('状态视图：FREE → 加锁后缓存窗口内仍 FREE（缓存位在路径上）→ relay 消费 SlotLocked → LOCKED+ref → 释放 → FREE', async () => {
    await putSchedule(LAWYER_E, {
      version: 0,
      templates: [{ weekday: 1, start_time: '10:00', duration_small: 60 }],
    });

    const free = await getSlots(LAWYER_E, MONDAY, MONDAY);
    expect(free.status).toBe(200);
    expect(free.body).toEqual([{ slot_start: MON_10, status: 'FREE', ref: null }]);

    const locked = await lock(LAWYER_E, new Date(MON_10));
    expect(locked.ok).toBe(true);

    // 缓存命中窗口：事件未消费前视图仍是旧值（R-W2-8：60s TTL 兜底语义的旧值窗口存在性证明）
    const stale = await getSlots(LAWYER_E, MONDAY, MONDAY);
    expect(stale.body).toEqual([{ slot_start: MON_10, status: 'FREE', ref: null }]);

    // relay 消费 SlotLocked → 缓存主动失效 → 视图反映 LOCKED
    expect((await relay.tick()).dispatched).toBe(1);
    const lockedView = await getSlots(LAWYER_E, MONDAY, MONDAY);
    expect(lockedView.body).toEqual([
      { slot_start: MON_10, status: 'LOCKED', ref: { ref_type: 'session', ref_id: 7001 } },
    ]);

    // 释放（SlotReleased）→ tick → 视图回 FREE
    const released = await poolSvc.withTransaction((uow) =>
      slotLocks.releaseSlot(uow, { refType: 'session', refId: 7001, reason: 'spec_cancel' }),
    );
    expect(released.ok).toBe(true);
    await relay.tick();
    const freedView = await getSlots(LAWYER_E, MONDAY, MONDAY);
    expect(freedView.body).toEqual([{ slot_start: MON_10, status: 'FREE', ref: null }]);
    expect(cache.get<unknown[]>(LAWYER_E, MONDAY, MONDAY)).not.toBeNull(); // 视图重入缓存
  });

  it('状态视图：PENDING_PAYMENT 为活跃态（非空闲）→ TTL 释放（SlotTtlExpired+SlotReleased）→ tick → FREE', async () => {
    await putSchedule(LAWYER_A, {
      version: 0,
      templates: [{ weekday: 1, start_time: '10:00', duration_small: 60 }],
    });
    const locked = await lock(LAWYER_A, new Date(MON_10), { paymentOrderId: 8801 });
    expect(locked).toMatchObject({ ok: true, status: 'PENDING_PAYMENT' });
    await relay.tick(); // 消费 SlotLocked
    const pendingView = await getSlots(LAWYER_A, MONDAY, MONDAY);
    expect(pendingView.body).toEqual([
      { slot_start: MON_10, status: 'PENDING_PAYMENT', ref: { ref_type: 'session', ref_id: 7001 } },
    ]);

    // TTL 到期释放（回拨 ttl_at 免真实等待；slot-lock.spec backdateTtl 同款口径）
    await pool.query(`UPDATE schedule.slot_locks SET ttl_at = now() - interval '1 second'`);
    const expired = await poolSvc.withTransaction((uow) =>
      slotLocks.releaseExpiredTtl(uow, locked.lockId!),
    );
    expect(expired.released).toBe(true);
    await relay.tick(); // SlotTtlExpired + SlotReleased 均触发失效
    const freedView = await getSlots(LAWYER_A, MONDAY, MONDAY);
    expect(freedView.body).toEqual([{ slot_start: MON_10, status: 'FREE', ref: null }]);
  });

  it('materializeSlots 实时（不走缓存）：startOccupy → OCCUPIED 立即可见（B2 无该迁移事件，视图侧靠 60s TTL 收敛）', async () => {
    await putSchedule(LAWYER_B, {
      version: 0,
      templates: [{ weekday: 1, start_time: '10:00', duration_small: 60 }],
    });
    const locked = await lock(LAWYER_B, new Date(MON_10));
    const lockedNow = await service.materializeSlots(LAWYER_B, MONDAY);
    expect(lockedNow).toHaveLength(1);
    expect(lockedNow[0]).toMatchObject({ status: 'LOCKED', templateId: expect.any(Number) });

    const occupied = await poolSvc.withTransaction((uow) =>
      slotLocks.startOccupy(uow, locked.lockId!),
    );
    expect(occupied.ok).toBe(true);
    const occupiedNow = await service.materializeSlots(LAWYER_B, MONDAY);
    expect(occupiedNow[0]).toMatchObject({
      status: 'OCCUPIED',
      ref: { refType: 'session', refId: 7001 },
    });
  });

  it('状态视图护栏：非法日期 / from>to / 区间跨度 >31 天 → 400；跨周区间查询正常', async () => {
    const bad = await getSlots(LAWYER_A, '2026-13-01', '2026-13-07');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(ErrorCode.InvalidArgument);

    const inverted = await getSlots(LAWYER_A, '2026-11-07', '2026-11-02');
    expect(inverted.status).toBe(400);

    const tooWide = await getSlots(LAWYER_A, '2026-11-01', '2027-01-15');
    expect(tooWide.status).toBe(400);

    // 跨周区间（11-02 周一 + 11-08 周日 各一模板）：两个候选同视图
    await putSchedule(LAWYER_A, {
      version: 0,
      templates: [
        { weekday: 1, start_time: '10:00', duration_small: 60 },
        { weekday: 0, start_time: '20:00', duration_small: 90 },
      ],
    });
    const week = await getSlots(LAWYER_A, '2026-11-02', '2026-11-08');
    expect(week.status).toBe(200);
    expect(week.body).toEqual([
      { slot_start: MON_10, status: 'FREE', ref: null }, // 周一 10:00
      { slot_start: '2026-11-08T12:00:00.000Z', status: 'FREE', ref: null }, // 周日 20:00
    ]);
  });

  it('消费端载荷防御：Slot* 事件缺 lawyer_id → relay 重试轨道（不静默丢弃）', async () => {
    await pool.query(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES (gen_random_uuid(), $1, $2::jsonb, 'PENDING')`,
      [SLOT_LOCKED_TOPIC, JSON.stringify({ ref: { ref_type: 'session', ref_id: 1 } })],
    );
    const ticked = await relay.tick();
    expect(ticked.dispatched).toBe(0);
    expect(ticked.retried).toBe(1);
  });
});
