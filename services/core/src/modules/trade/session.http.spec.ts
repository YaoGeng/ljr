import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { CreditRestrictionCache } from '../credit/credit.cache';
import { CreditService } from '../credit/credit.service';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { seedLawyerProfile } from '../identity/lawyer-fixture';
import { IdentityTokenService } from '../identity/identity.token.service';
import { RuleCenterService } from '../ops/rule-center.service';
import { SessionListCache } from './session.cache';
import { SessionService } from './session.service';
import { TradeModule } from './trade.module';

/**
 * C1 REST 契约（§5 表逐字 + Task 4 简报）：
 *   POST /sessions {slot_start, price_mode, unit_price?, capacity, enroll_deadline?, room_mode}
 *     → {session}；409 SLOT_TAKEN/E_SESSION_DUP_KEY、403 RESTRICTED；幂等键=lawyer+slot_start。
 *   GET /sessions?specialty=&lawyer=&from=&to= 列表（仅 PASSED；缓存 30s 进程内适配位）。
 *   GET /sessions/{id} 详情+剩余席位。GET /lawyer/sessions/stats?from=&to= 四率（两率+两桩）。
 * 鉴权（A1 §10-5 律师端 HTTP 复验落点）：POST /sessions 与 stats 挂 @RequireRole('lawyer')+
 * @CurrentIdentity（守卫双向用例：user token 打律师面 403）；GET 列表/详情公开（契约鉴权列「否」）。
 * 错误体形态：infrastructure AppHttpExceptionFilter {code, message}。
 */

const HOUR = 3_600_000;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

const RULES_SEED_BAN_PUBLISH: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    lawyer_price_abuse: { delta: -20, restriction: { kind: 'BAN_PUBLISH', days: 7 } },
  },
};

describe('C1 HTTP 契约（§5，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let sessions: SessionService;
  let credit: CreditService;
  let rules: RuleCenterService;
  let creditCache: CreditRestrictionCache;
  let listCache: SessionListCache;
  let tokens: IdentityTokenService;

  const lawyerToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'lawyer', roles: ['lawyer'] });
  const userToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'user', roles: ['user'] });

  const postSession = (token: string | null, body: Record<string, unknown>) => {
    const req = request(app.getHttpServer())
      .post('/sessions')
      .set('Content-Type', 'application/json');
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  const bodyOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    slot_start: new Date(Date.now() + 25 * HOUR).toISOString(),
    price_mode: 'per_head',
    unit_price: '50.00',
    capacity: 6,
    room_mode: 'text',
    ...over,
  });

  const createViaService = (lawyerId: number, over: Record<string, unknown> = {}) =>
    sessions.create({
      lawyer_id: lawyerId,
      slot_start: new Date(Date.now() + 25 * HOUR),
      price_mode: 'per_head',
      unit_price: '50.00',
      capacity: 6,
      room_mode: 'text',
      ...over,
    } as Parameters<SessionService['create']>[0]);

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TradeModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    sessions = app.get(SessionService);
    credit = app.get(CreditService);
    rules = app.get(RuleCenterService);
    creditCache = app.get(CreditRestrictionCache);
    listCache = app.get(SessionListCache);
    tokens = app.get(IdentityTokenService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    // 进程内缓存不随 TRUNCATE 失效：清 G1 限制令缓存（RESTRICTED 用例发行后跨用例残留）
    creditCache.invalidateOwner({ ownerType: 'lawyer', ownerId: 9401 });
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('POST /sessions：{session} 出参；幂等重放同单；同键异载荷 409；user token 403 / 无 token 401（A1 §10-5 双向）', async () => {
    const token = await lawyerToken(9401);
    const body = bodyOf(); // 同键=lawyer+slot_start：重放/异载荷用例必须复用同一 slot_start
    const ok = await postSession(token, body);
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body)).toEqual(['session']); // §5：→ {session}
    expect(ok.body.session.status).toBe('CREATED');
    expect(ok.body.session.unit_price).toBe('50.00');
    expect(ok.body.session.session_total).toBe('300.00'); // R-04：50.00×6

    const replay = await postSession(token, body);
    expect(replay.status).toBe(201);
    expect(replay.body.session.id).toBe(ok.body.session.id); // 幂等键=lawyer+slot_start

    const conflict = await postSession(token, { ...body, capacity: 8 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(ErrorCode.SessionDuplicateKey);

    const asUser = await postSession(await userToken(9402), bodyOf());
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe(ErrorCode.RoleForbidden); // 守卫双向：user token 打律师面

    const anon = await postSession(null, bodyOf());
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);
  });

  it('POST /sessions：停接（活跃 BAN_PUBLISH）→ 403 E_RESTRICTED；入参校验 400/422', async () => {
    const token = await lawyerToken(9401);
    await app.get(PgPoolService).withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: RULES_SEED_BAN_PUBLISH,
        effectiveAt: new Date(Date.now() - 10 * HOUR),
      }),
    );
    await credit.emit({
      owner_type: 'lawyer',
      owner_id: 9401,
      action: 'lawyer_price_abuse',
      ref_type: 'price_change',
      ref_id: 1,
    });
    const forbidden = await postSession(token, bodyOf());
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe(ErrorCode.Restricted);

    // 入参校验用无限制令律师（限制令行不可变，until 内 9401 恒 403——惰性失效口径）
    const token2 = await lawyerToken(9403);
    const ok = await postSession(token2, bodyOf({ unit_price: '60.00' }));
    expect(ok.status).toBe(201);
    expect(ok.body.session.session_total).toBe('360.00');

    const badCapacity = await postSession(token2, bodyOf({ capacity: 1 }));
    expect(badCapacity.status).toBe(400);
    expect(badCapacity.body.code).toBe(ErrorCode.InvalidArgument);
    const overCapacity = await postSession(token2, bodyOf({ capacity: 51 }));
    expect(overCapacity.status).toBe(400);
    const badMode = await postSession(token2, bodyOf({ price_mode: 'per_person' }));
    expect(badMode.status).toBe(400);
    const badRoom = await postSession(token2, bodyOf({ room_mode: 'phone' }));
    expect(badRoom.status).toBe(400);
    const badSlot = await postSession(token2, bodyOf({ slot_start: '明天下午' }));
    expect(badSlot.status).toBe(400);
    const badMoney = await postSession(token2, bodyOf({ unit_price: '60.5' }));
    expect(badMoney.status).toBe(422);
    expect(badMoney.body.code).toBe(ErrorCode.MoneyInvalidFormat);
  });

  it('GET /sessions：仅 PASSED 律师场次；lawyer/from/to 过滤；30s 缓存适配位（命中+新建失效）', async () => {
    await seedLawyerProfile(pool, 9501, 'PASSED', 'http-passed');
    await seedLawyerProfile(pool, 9502, 'SUBMITTED', 'http-submitted');
    await createViaService(9501);
    await createViaService(9502, {
      slot_start: new Date(Date.now() + 26 * HOUR),
      capacity: 4,
      room_mode: 'voice',
    });

    const list1 = await request(app.getHttpServer()).get('/sessions');
    expect(list1.status).toBe(200);
    expect(list1.body.map((s: { lawyer_id: number }) => s.lawyer_id)).toEqual([9501]);
    expect(listCache.size).toBe(1); // 缓存适配位命中载体

    const byLawyer = await request(app.getHttpServer()).get('/sessions?lawyer=9502');
    expect(byLawyer.body).toEqual([]); // 过滤命中但审核未过 → 不可见

    const far = new Date(Date.now() + 40 * 24 * HOUR).toISOString().slice(0, 10);
    const byRange = await request(app.getHttpServer()).get(`/sessions?from=${far}&to=${far}`);
    expect(byRange.body).toEqual([]);

    // 新建失效（create 写路径 invalidateAll）：列表即时可见新场次（B2 R-03：同律师进行中 ≤1 → 换律师）
    await seedLawyerProfile(pool, 9503, 'PASSED', 'http-passed-2');
    await createViaService(9503, {
      slot_start: new Date(Date.now() + 30 * HOUR),
      unit_price: '55.00',
      capacity: 8,
    });
    const list2 = await request(app.getHttpServer()).get('/sessions');
    expect(list2.body.map((s: { lawyer_id: number }) => s.lawyer_id)).toEqual([9501, 9503]);
  });

  it('GET /sessions?specialty= 超长 400：查询参上界 32=列宽对齐（T11.5-① 收口；>32 原得空集，边界 32 放行）', async () => {
    const tooLong = await request(app.getHttpServer()).get(`/sessions?specialty=${'a'.repeat(33)}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe(ErrorCode.InvalidArgument);

    const boundary = await request(app.getHttpServer()).get(
      `/sessions?specialty=${'a'.repeat(32)}`,
    );
    expect(boundary.status).toBe(200); // 边界长度放行，走过滤空集语义
    expect(boundary.body).toEqual([]);
  });

  it('GET /sessions/{id}：详情+剩余席位；404 E_NOT_FOUND', async () => {
    const view = await createViaService(9501);
    const detail = await request(app.getHttpServer()).get(`/sessions/${view.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.remaining).toBe(6);
    expect(detail.body.status).toBe('CREATED');

    const missing = await request(app.getHttpServer()).get('/sessions/987654');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ErrorCode.NotFound);
  });

  it('GET /lawyer/sessions/stats：enroll_rate/group_rate 出数（口径=范围内聚合）；attendance/ooo 缺数据=null（聚合面=M2-W3 T3 接真，出数用例在 D3 attendance.spec）；缺参 400；user token 403', async () => {
    const base = Date.now();
    const ymd = (offsetDays: number): string =>
      new Date(base + offsetDays * 24 * HOUR).toISOString().slice(0, 10);
    await createViaService(9601); // capacity 6 / joined 0 / CREATED
    // 夹具直插第二场（本 schema 夹具；绕开 B2 滥用计数——同律师进行中 ≤1，stats 聚合与创建路径无关；
    // 生产零 joined 写点与零直插写点，见领域 spec 同口径注释）
    const s2 = await pool.query<{ id: string }>(
      `INSERT INTO trade.sessions
         (lawyer_id, slot_start, price_mode, unit_price, session_total, capacity, joined,
          enroll_deadline, room_mode, status)
       VALUES (9601, now() + interval '30 hours', 'per_head', 50.00, 200.00, 4, 4,
               now() + interval '6 hours', 'text', 'CREATED')
       RETURNING id`,
    );
    await sessions.markFull(Number(s2.rows[0]!.id)); // CREATED→FULL 守卫路径

    const token = await lawyerToken(9601);
    const stats = await request(app.getHttpServer())
      .get(`/lawyer/sessions/stats?from=${ymd(0)}&to=${ymd(2)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(stats.status).toBe(200);
    expect(Object.keys(stats.body).sort()).toEqual([
      'attendance_rate',
      'enroll_rate',
      'group_rate',
      'ooo_rate',
    ]); // §5 四键逐字
    expect(stats.body.enroll_rate).toBe(0.4); // Σjoined=4 / Σcapacity=10
    expect(stats.body.group_rate).toBe(0.5); // 成团 1（FULL）/总 2
    expect(stats.body.attendance_rate).toBeNull(); // 缺数据 null（M2-W3 T3 接真后：窗内零已判定行）
    expect(stats.body.ooo_rate).toBeNull(); // 缺数据 null（M2-W3 T3 接真后：窗内零进房用户）

    const empty = await request(app.getHttpServer())
      .get(`/lawyer/sessions/stats?from=${ymd(40)}&to=${ymd(41)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(empty.body).toEqual({
      enroll_rate: null,
      group_rate: null,
      attendance_rate: null,
      ooo_rate: null,
    });

    const missing = await request(app.getHttpServer())
      .get('/lawyer/sessions/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(ErrorCode.InvalidArgument);

    const asUser = await request(app.getHttpServer())
      .get(`/lawyer/sessions/stats?from=${ymd(0)}&to=${ymd(2)}`)
      .set('Authorization', `Bearer ${await userToken(9402)}`);
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe(ErrorCode.RoleForbidden);
  });
});
