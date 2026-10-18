import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { grantUserRoles, seedLawyerProfile, seedUserShell } from '../identity/lawyer-fixture';
import { IdentityTokenService } from '../identity/identity.token.service';
import { seedPaymentOrderRaw } from '../payment/order-fixture';
import { SchedulerService } from '../schedule/scheduler.service';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from '../trade/trade-fixture';
import { FulfillmentModule } from './fulfillment.module';

/**
 * D1 REST 契约（§5 + T1 评审 Important-1+Minor-7 归属校验落位）：
 *   POST /rooms/{session_id}/close → {closed_at}（§5 逐字包键）；
 *   403 E_ROLE_FORBIDDEN 双面——user token 打律师面（角色守卫）+ lawyer B 关 lawyer A 场次
 *   （归属校验：actor=JWT claims userId 与场次属主 lawyer_id 比对）；
 *   404 E_NOT_FOUND（未开房）；409 E_CONFLICT（重复 close=已终态 NOT_OPEN）。
 * 错误体形态：infrastructure AppHttpExceptionFilter {code, message}；形态抄 trade
 * session.http.spec（supertest+IdentityTokenService 铸 token）。
 */

const FIRM_ID = 8801;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('D1 HTTP 契约（POST /rooms/{session_id}/close，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let tokens: IdentityTokenService;

  const lawyerToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'lawyer', roles: ['lawyer'] });
  const userToken = (userId: number): Promise<string> =>
    tokens.signAccessToken({ userId, role: 'user', roles: ['user'] });

  const postClose = (token: string | null, sessionId: number) => {
    const req = request(app.getHttpServer())
      .post(`/rooms/${sessionId}/close`)
      .set('Content-Type', 'application/json');
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.send();
  };

  /** 律师账号壳+角色+档案（firm 绑定）→ CONFIRMED 场次+PAID 报名/支付单 → ROOM_OPEN 真链开房 */
  const seedOpenRoom = async (tag: string): Promise<{ sessionId: number; lawyerId: number }> => {
    const lawyerId = await seedUserShell(pool, tag);
    await grantUserRoles(pool, lawyerId, ['lawyer']);
    await seedLawyerProfile(pool, lawyerId, 'PASSED', tag, undefined, FIRM_ID);
    const slotStart = new Date(Date.now() - 5_000);
    const sessionId = await seedSessionAtRaw(pool, lawyerId, 'CONFIRMED', slotStart, 'text');
    const e1 = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 7301,
      cash: '60.00',
      points: 0,
      unitPrice: '60.00',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(e1),
      bizId: e1,
      cash: '60.00',
      points: 0,
    });
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, {
        jobType: 'ROOM_OPEN',
        refType: 'session',
        refId: sessionId,
        dueAt: slotStart,
      }),
    );
    const ticked = await scheduler.tick('priority');
    expect(ticked.done).toBe(1);
    return { sessionId, lawyerId };
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    // D5 WSS 网关随模块注册后（M2-W1 T3），init 前须挂 ws 适配器（同 room.spec 注记）
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
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

  it('属主律师 close：{closed_at} 出参（§5 逐字）；重复 close 409 E_CONFLICT（已终态 NOT_OPEN）', async () => {
    const { sessionId, lawyerId } = await seedOpenRoom('d1-http-owner');
    const ok = await postClose(await lawyerToken(lawyerId), sessionId);
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body)).toEqual(['closed_at']); // §5：→ {closed_at}
    expect(Number.isNaN(Date.parse(ok.body.closed_at))).toBe(false);

    const again = await postClose(await lawyerToken(lawyerId), sessionId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe(ErrorCode.Conflict);
  });

  it('user token 打律师面 403 E_ROLE_FORBIDDEN（角色守卫双向，A1 §10-5 同款）', async () => {
    const { sessionId } = await seedOpenRoom('d1-http-role');
    const asUser = await postClose(await userToken(7402), sessionId);
    expect(asUser.status).toBe(403);
    expect(asUser.body.code).toBe(ErrorCode.RoleForbidden);
  });

  it('归属校验：lawyer B 关 lawyer A 场次 403 E_ROLE_FORBIDDEN（actor=JWT claims 与场次属主比对）', async () => {
    const { sessionId } = await seedOpenRoom('d1-http-a');
    const lawyerB = await seedUserShell(pool, 'd1-http-b'); // 另一律师（档案非必需——403 先于构成校验命中）
    await grantUserRoles(pool, lawyerB, ['lawyer']);
    const foreign = await postClose(await lawyerToken(lawyerB), sessionId);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe(ErrorCode.RoleForbidden);
    // 房间未被关闭（拒绝零副作用）
    const room = await pool.query<{ status: string }>(
      `SELECT status FROM fulfillment.rooms WHERE session_id = $1`,
      [sessionId],
    );
    expect(room.rows[0]!.status).toBe('OPEN');
  });

  it('未开房场次 close 404 E_NOT_FOUND；路径参非法 400', async () => {
    const lawyerId = await seedUserShell(pool, 'd1-http-404');
    await grantUserRoles(pool, lawyerId, ['lawyer']);
    await seedLawyerProfile(pool, lawyerId, 'PASSED', 'd1-http-404', undefined, FIRM_ID);
    await seedSessionAtRaw(pool, lawyerId, 'CONFIRMED', new Date(Date.now() - 5_000), 'text');

    const token = await lawyerToken(lawyerId);
    const missing = await request(app.getHttpServer())
      .post('/rooms/987654/close')
      .set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ErrorCode.NotFound);

    const badParam = await request(app.getHttpServer())
      .post('/rooms/abc/close')
      .set('Authorization', `Bearer ${token}`);
    expect(badParam.status).toBe(400);
    expect(badParam.body.code).toBe(ErrorCode.InvalidArgument);
  });
});
