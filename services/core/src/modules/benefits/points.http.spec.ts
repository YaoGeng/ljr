import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { BenefitsModule } from './points.module';
import { PointsService } from './points.service';

/**
 * F4 ①切片 REST 面 e2e（需 PG）：GET /points/mine（§5 契约表逐字 {balance, frozen,
 * expiring_soon[]}）——JWT 本人（@CurrentIdentity claims 注入 user_id，A1/credit 先例）+
 * @RequireRole('user')（F4 §5 鉴权列：否→本人语义面，双角色同 App 下要求 user 激活角色，
 * Task 2 简报口径）+ AppHttpExceptionFilter 统一错误体。
 */
const USER = 601;
const LAWYER = 9101;

const DAY = 86_400_000;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('F4 ①切片 REST 面：GET /points/mine（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let jwt: JwtService;
  let userToken: string;
  let lawyerToken: string;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [BenefitsModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
    userToken = await jwt.signAsync({ sub: String(USER), role: 'user', roles: ['user'] });
    lawyerToken = await jwt.signAsync({
      sub: String(LAWYER),
      role: 'lawyer',
      roles: ['user', 'lawyer'],
    });
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

  it('未认证 401；非 user 激活角色 403 E_ROLE_FORBIDDEN（@RequireRole user）', async () => {
    const anon = await request(app.getHttpServer()).get('/points/mine');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const asLawyer = await request(app.getHttpServer())
      .get('/points/mine')
      .set('Authorization', `Bearer ${lawyerToken}`);
    expect(asLawyer.status).toBe(403);
    expect(asLawyer.body.code).toBe(ErrorCode.RoleForbidden);
  });

  it('user 本人：空账户 {balance:0, frozen:0, expiring_soon:[]}；授予+冻结后余额/冻结/即将过期逐字', async () => {
    const empty = await request(app.getHttpServer())
      .get('/points/mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ balance: 0, frozen: 0, expiring_soon: [] });

    const db = app.get(PgPoolService);
    // 夹具：7d 窗口内 100 + 窗口外 50（直插本 schema 表，expires 用 SQL 表达式锚定 DB 时钟）
    await db.query(
      `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref, expires_at)
       VALUES ($1, 100, 'COMPENSATION', 'fixture:1', now() + interval '2 days')`,
      [USER],
    );
    await db.query(
      `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref, expires_at)
       VALUES ($1, 50, 'COMPENSATION', 'fixture:2', now() + interval '30 days')`,
      [USER],
    );
    await db.query(
      `INSERT INTO benefits.points_accounts (user_id, balance) VALUES ($1, 150)
       ON CONFLICT (user_id) DO UPDATE SET balance = 150`,
      [USER],
    );
    await app.get(PointsService).freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 30,
      order_payable_cents: 100000,
    });

    const mine = await request(app.getHttpServer())
      .get('/points/mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.balance).toBe(120); // 物理 150−冻结 30=120，无过期未扣
    expect(mine.body.frozen).toBe(30);
    expect(mine.body.expiring_soon).toHaveLength(1);
    expect(mine.body.expiring_soon[0]).toMatchObject({ points: 100 });
    expect(
      Math.abs(new Date(mine.body.expiring_soon[0].expires_at).getTime() - (Date.now() + 2 * DAY)),
    ).toBeLessThan(10_000);
  });
});
