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
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from './trade-fixture';
import { RescheduleService } from './reschedule.service';
import { TradeModule } from './trade.module';

/**
 * C5 REST 契约（§5 表逐字）：三端点鉴权/形状/错误体（**2h 边界含端点**——§9 TDD 附加项）。
 *   POST /enrollments/{id}/reschedule {target_session_id} → {request}（user JWT；
 *     400 E_INVALID_ARGUMENT（<2H 含端点级/缺 target_session_id）/ 409 E_NO_SEAT|E_RESCHEDULE_USED
 *     / 403 E_RESTRICTED（非属主）/ 401 未认证）
 *   POST /reschedule/{id}/cancel → {status}（user JWT；409 E_CONFLICT=CONFIRMED）
 *   POST /reschedule/{id}/confirm → {new_enrollment_id}（lawyer JWT；user token 403 E_ROLE_FORBIDDEN）
 * 错误体形态：infrastructure AppHttpExceptionFilter {code, message}。
 */

const HOUR = 3_600_000;
const LAWYER = 9101;
const U1 = 6101;
const U2 = 6102;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('C5 REST 契约（§5 三端点，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let reschedules: RescheduleService;
  let tokens: IdentityTokenService;

  const userToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'user', roles: ['user'] });
  const lawyerToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'lawyer', roles: ['lawyer'] });

  const authPost = async (
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<request.Response> => {
    const req = request(app.getHttpServer()).post(path).set('Content-Type', 'application/json');
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.send((body ?? {}) as object);
  };

  const seedReady = async (slot: Date): Promise<{ sourceId: number; enrollId: number }> => {
    const sourceId = await seedSessionAtRaw(pool, LAWYER, 'CREATED', slot);
    const enrollId = await seedPaidEnrollmentRaw(pool, 'session', sourceId, {
      userId: U1,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
      snapshot: {
        price_mode: 'per_head',
        unit_price: '100.00',
        share_price: null,
        session_total: '100.00',
        price_version: 1,
        snapshot_at: new Date().toISOString(),
      },
    });
    await pool.query(`UPDATE trade.sessions SET joined = 1 WHERE id = $1`, [sourceId]);
    return { sourceId, enrollId };
  };

  const seedTarget = async (): Promise<number> => {
    const id = await seedSessionAtRaw(pool, LAWYER, 'CREATED', new Date(Date.now() + 48 * HOUR));
    return id;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TradeModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    reschedules = app.get(RescheduleService);
    tokens = app.get(IdentityTokenService);
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

  it('POST /enrollments/{id}/reschedule：user JWT 属主申请 → {request}（PENDING+12h expires）', async () => {
    const { enrollId } = await seedReady(new Date(Date.now() + 25 * HOUR));
    const targetId = await seedTarget();
    const res = await authPost(`/enrollments/${enrollId}/reschedule`, await userToken(U1), {
      target_session_id: targetId,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      enrollment_id: enrollId,
      target_session_id: targetId,
      status: 'PENDING',
    });
    expect(res.body.expires_at).toBeDefined();
    expect(res.body.id).toBeGreaterThan(0);
  });

  it('2h 边界含端点（§9）：原场次 1h59m → 400 E_INVALID_ARGUMENT；2h5m → 201', async () => {
    const late = await seedReady(new Date(Date.now() + (1 + 59 / 60) * HOUR));
    const targetId = await seedTarget();
    const rejected = await authPost(
      `/enrollments/${late.enrollId}/reschedule`,
      await userToken(U1),
      { target_session_id: targetId },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe(ErrorCode.InvalidArgument);

    const ok = await seedReady(new Date(Date.now() + (2 + 5 / 60) * HOUR));
    const target2 = await seedTarget();
    const accepted = await authPost(`/enrollments/${ok.enrollId}/reschedule`, await userToken(U1), {
      target_session_id: target2,
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.status).toBe('PENDING');
  });

  it('申请守卫错误体：非属主 403 E_RESTRICTED / 目标满员 409 E_NO_SEAT / used 409 E_RESCHEDULE_USED / 缺字段 400', async () => {
    const { enrollId } = await seedReady(new Date(Date.now() + 25 * HOUR));
    const targetId = await seedTarget();

    const noField = await authPost(`/enrollments/${enrollId}/reschedule`, await userToken(U1), {});
    expect(noField.status).toBe(400);
    expect(noField.body.code).toBe(ErrorCode.InvalidArgument);

    const foreign = await authPost(`/enrollments/${enrollId}/reschedule`, await userToken(U2), {
      target_session_id: targetId,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe(ErrorCode.Restricted);

    const target2 = await seedTarget();
    await pool.query(`UPDATE trade.sessions SET joined = 5 WHERE id = $1`, [target2]);
    const noSeat = await authPost(`/enrollments/${enrollId}/reschedule`, await userToken(U1), {
      target_session_id: target2,
    });
    expect(noSeat.status).toBe(409);
    expect(noSeat.body.code).toBe(ErrorCode.NoSeat);

    await pool.query(`UPDATE trade.enrollments SET reschedule_used = true WHERE id = $1`, [
      enrollId,
    ]);
    const used = await authPost(`/enrollments/${enrollId}/reschedule`, await userToken(U1), {
      target_session_id: targetId,
    });
    expect(used.status).toBe(409);
    expect(used.body.code).toBe(ErrorCode.RescheduleUsed);

    const anon = await authPost(`/enrollments/${enrollId}/reschedule`, null, {
      target_session_id: targetId,
    });
    expect(anon.status).toBe(401);
  });

  it('POST /reschedule/{id}/cancel：user JWT → {status:CANCELLED}；lawyer token 403 E_ROLE_FORBIDDEN', async () => {
    const { enrollId } = await seedReady(new Date(Date.now() + 25 * HOUR));
    const targetId = await seedTarget();
    const view = await reschedules.apply(enrollId, U1, targetId);

    const byLawyer = await authPost(`/reschedule/${view.id}/cancel`, await lawyerToken(LAWYER));
    expect(byLawyer.status).toBe(403);
    expect(byLawyer.body.code).toBe(ErrorCode.RoleForbidden);

    const res = await authPost(`/reschedule/${view.id}/cancel`, await userToken(U1));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'CANCELLED' });
  });

  it('POST /reschedule/{id}/confirm：lawyer JWT → {new_enrollment_id}；user token 403；已确认 cancel 409 E_CONFLICT', async () => {
    const { enrollId } = await seedReady(new Date(Date.now() + 25 * HOUR));
    const targetId = await seedTarget();
    const view = await reschedules.apply(enrollId, U1, targetId);

    const byUser = await authPost(`/reschedule/${view.id}/confirm`, await userToken(U1));
    expect(byUser.status).toBe(403);
    expect(byUser.body.code).toBe(ErrorCode.RoleForbidden);

    const res = await authPost(`/reschedule/${view.id}/confirm`, await lawyerToken(LAWYER));
    expect(res.status).toBe(201);
    expect(res.body.new_enrollment_id).toBeGreaterThan(0);

    const cancelAfter = await authPost(`/reschedule/${view.id}/cancel`, await userToken(U1));
    expect(cancelAfter.status).toBe(409);
    expect(cancelAfter.body.code).toBe(ErrorCode.Conflict);
  });
});
