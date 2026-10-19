import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { IdentityTokenService } from '../identity/identity.token.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { seedPaidEnrollmentRaw } from './trade-fixture';
import { GroupBuyResponseService } from './group-buy-response.service';
import { GroupBuyService } from './group-buy.service';
import { TradeModule } from './trade.module';
import { PgPoolService } from '../../infrastructure/sql';
import { SlotLockService } from '../schedule/slot-lock.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';

/**
 * C4 REST 契约（§5 表逐字）：五端点鉴权/形状/错误体。
 *   GET  /lawyer/group-buys?status=PENDING_LAWYER（律师 JWT；user token 403；status 越域 400）
 *   POST /group-buys/{id}/confirm  → {session_id}（409 E_NOT_REACHED / 403 E_RESTRICTED）
 *   POST /group-buys/{id}/reject   → {status}（409 E_NOT_PENDING；body {reason?} 形状）
 *   POST /group-buys/{id}/convert  → {session_id}（409 E_NOT_CONVERTIBLE；body {capacity?, price?}）
 *   GET  /lawyer/response-stats?from=&to=（缺参 400；user token 403）
 * 错误体形态：infrastructure AppHttpExceptionFilter {code, message}。
 */

const HOUR = 3_600_000;
const LAWYER = 9101;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('C4 REST 契约（§5 五端点，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let groupBuys: GroupBuyService;
  let responses: GroupBuyResponseService;
  let pricing: PricingConfigService;
  let tokens: IdentityTokenService;
  let poolSvc: PgPoolService;
  let locks: SlotLockService;

  const lawyerToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'lawyer', roles: ['lawyer'] });
  const userToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'user', roles: ['user'] });

  const authPost = async (
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<request.Response> => {
    const req = request(app.getHttpServer()).post(path).set('Content-Type', 'application/json');
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.send((body ?? {}) as object);
  };

  /** PENDING_LAWYER 任务（三参与者+达线） */
  const pendingGroup = async (slotHours: number): Promise<number> => {
    const gateway = app.get(PaymentGatewayService);
    const result = await groupBuys.create({
      initiator_id: 6101,
      lawyer_id: LAWYER,
      specialty: 'labor_arbitration',
      slot_start: new Date(Date.now() + slotHours * HOUR),
      sub_min: 3,
      sub_max: 6,
      question_tags: ['劳动仲裁时效'],
    });
    await poolSvc.withTransaction((uow) => locks.confirmPayment(uow, result.payment_order.id));
    for (const uid of [6101, 6102, 6103]) {
      await seedPaidEnrollmentRaw(pool, 'groupbuy', result.group_buy.id, {
        userId: uid,
        cash: '33.33',
        points: 0,
        unitPrice: '33.33',
        snapshot: {
          price_mode: 'per_head',
          unit_price: '33.33',
          share_price: '33.33',
          session_total: '33.33',
          price_version: 1,
          snapshot_at: new Date().toISOString(),
        },
      });
      void gateway;
    }
    await groupBuys.groupBuyReachedGuard(result.group_buy.id, 3);
    return result.group_buy.id;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TradeModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    groupBuys = app.get(GroupBuyService);
    responses = app.get(GroupBuyResponseService);
    pricing = app.get(PricingConfigService);
    tokens = app.get(IdentityTokenService);
    poolSvc = app.get(PgPoolService);
    locks = app.get(SlotLockService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await pricing.putPricing(LAWYER, {
      base_version: 0,
      per_head: null,
      session_total: '100.00',
      group_size: null,
      accept_min: 2,
      accept_max: 8,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('GET /lawyer/group-buys：律师 JWT 返回待确认清单（joined 接线）；user token 403；status 越域 400；无鉴权 401', async () => {
    const gbId = await pendingGroup(25);
    const token = await lawyerToken(LAWYER);
    const res = await request(app.getHttpServer())
      .get('/lawyer/group-buys?status=PENDING_LAWYER')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: gbId,
      status: 'PENDING_LAWYER',
      sub_min: 3,
      sub_max: 6,
      joined: 3,
      lawyer_confirm_by: expect.any(String),
    });

    expect(
      await (
        await request(app.getHttpServer())
          .get('/lawyer/group-buys')
          .set('Authorization', `Bearer ${await userToken(6101)}`)
      ).status,
    ).toBe(403);
    const badStatus = await request(app.getHttpServer())
      .get('/lawyer/group-buys?status=CONFIRMED')
      .set('Authorization', `Bearer ${token}`);
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe(ErrorCode.InvalidArgument);
    expect((await request(app.getHttpServer()).get('/lawyer/group-buys').send()).status).toBe(401);
  });

  it('POST /group-buys/{id}/confirm|reject|convert：契约出参/守卫码/鉴权矩阵', async () => {
    const token = await lawyerToken(LAWYER);
    const user = await userToken(6101);

    // PUBLISHED 上 confirm → 409 E_NOT_REACHED（错误体 {code,message}；发起人 6102 错开
    // B2 R-03 同用户同律师 PENDING_PAYMENT ≤1 计数——pendingGroup 的发起人是 6101）
    const published = await groupBuys.create({
      initiator_id: 6102,
      lawyer_id: LAWYER,
      specialty: 'labor_arbitration',
      slot_start: new Date(Date.now() + 30 * HOUR),
      sub_min: 3,
      sub_max: 6,
      question_tags: ['x'],
    });
    const notReached = await authPost(`/group-buys/${published.group_buy.id}/confirm`, token);
    expect(notReached.status).toBe(409);
    expect(notReached.body.code).toBe(ErrorCode.NotReached);

    // reject：PUBLISHED（published 任务）→ 409 E_NOT_PENDING；user token → 403（PENDING_LAWYER 任务上）
    const gbId = await pendingGroup(25);
    const notPending = await authPost(`/group-buys/${published.group_buy.id}/reject`, token, {
      reason: '档期冲突',
    });
    expect(notPending.status).toBe(409);
    expect(notPending.body.code).toBe(ErrorCode.NotPending);
    const forbidden = await authPost(`/group-buys/${gbId}/reject`, user, {});
    expect(forbidden.status).toBe(403);

    // convert：PENDING_LAWYER → 201 {session_id}（Nest POST 缺省 201）
    const converted = await authPost(`/group-buys/${gbId}/convert`, token, {
      capacity: 8,
      price: '120.00',
    });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(Object.keys(converted.body)).toEqual(['session_id']);
    expect(converted.body.session_id).toBeGreaterThan(0);
    // 幂等重放：同 session_id
    const replay = await authPost(`/group-buys/${gbId}/convert`, token, {});
    expect(replay.status).toBe(201);
    expect(replay.body.session_id).toBe(converted.body.session_id);
    // CONVERTED 上 confirm → 409 E_NOT_REACHED；convert → 幂等；body 形状错 400
    expect((await authPost(`/group-buys/${gbId}/confirm`, token)).status).toBe(409);
    const badBody = await authPost(`/group-buys/${gbId}/convert`, token, { capacity: 'abc' });
    expect(badBody.status).toBe(400);
    expect(badBody.body.code).toBe(ErrorCode.InvalidArgument);

    // confirm 主链（另一任务）：201 {session_id}
    const gb2 = await pendingGroup(26);
    const confirmed = await authPost(`/group-buys/${gb2}/confirm`, token);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.session_id).toBeGreaterThan(0);
    // reject 主链出参 {status:'REJECTED'}（第三任务）
    const gb3 = await pendingGroup(27);
    const rejected = await authPost(`/group-buys/${gb3}/reject`, token, { reason: '档期冲突' });
    expect(rejected.status).toBe(201);
    expect(rejected.body).toEqual({ status: 'REJECTED' });
  });

  it('GET /lawyer/response-stats：from/to 缺参 400；律师 JWT 出参形状 {samples, avg_confirm_minutes}', async () => {
    const token = await lawyerToken(LAWYER);
    expect(
      (
        await request(app.getHttpServer())
          .get('/lawyer/response-stats')
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(400);
    const today = new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10);
    const res = await request(app.getHttpServer())
      .get(`/lawyer/response-stats?from=${today}&to=${today}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['avg_confirm_minutes', 'samples']);
    expect(res.body.samples).toEqual([]);
    expect(res.body.avg_confirm_minutes).toBeNull();
    expect(
      (
        await request(app.getHttpServer())
          .get(`/lawyer/response-stats?from=${today}&to=${today}`)
          .set('Authorization', `Bearer ${await userToken(6101)}`)
      ).status,
    ).toBe(403);
    void responses;
  });
});
