import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { COUPON_GRANTED_TOPIC, ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { RuleCenterService } from '../ops/rule-center.service';
import { BenefitsModule } from './points.module';
import { CouponService } from './coupon.service';
import { COUPON_PRICE_COMP_RULE_KEY } from './coupon.types';

/**
 * F4 ②全量券面 e2e（需 PG，M2-W2 T6）：发券（PRICE_COUPON_INSTRUCTED 消费核 grantPriceComp
 * ——幂等 UNIQUE(source,source_ref)）+CouponGranted 出箱（面额快照）+到期 EXPIRED 双路径
 * （惰性 GET /coupons/mine 读时翻转+POINTS_EXPIRE 日扫槽 sweepExpired）+核销最小面
 * （redeemInTx USED 翻转幂等/过期 409/属主 403）+券定义解析（H7 coupon.price_comp 现行版
 * 优先→V43 seed 行回退）。
 *
 * 种子依赖：benefits.coupons 不入清场清单（V43 PRICE_COMP 种子行 id=1 面额 50.00/90 天）；
 * H7 规则现行版用例在其后（currentVersion 进程内缓存——先跑回退用例再 seed 规则，序敏感）。
 */
const USER = 721;
const USER_B = 722;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('F4 ②全量券面（发券/到期/核销/定义解析，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let jwt: JwtService;
  let coupons: CouponService;
  let userToken: string;

  const grantsRaw = async () => {
    const res = await pool.query<{
      id: string;
      user_id: string;
      coupon_id: string;
      source: string;
      source_ref: string;
      status: string;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `SELECT id, user_id::text AS user_id, coupon_id::text AS coupon_id, source, source_ref,
              status, expires_at, used_at
         FROM benefits.coupon_grants ORDER BY id`,
    );
    return res.rows;
  };

  const couponEvents = async () => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [COUPON_GRANTED_TOPIC],
    );
    return res.rows.map((r) => r.payload);
  };

  const seedRule = async (faceValue: string, validityDays: number): Promise<void> => {
    // H7 免公示通道（cancellation.spec cancel-matrix 同款）——跨域经导出面，不直写 ops 表
    const rules = app.get(RuleCenterService);
    const db = app.get(PgPoolService);
    await db.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: COUPON_PRICE_COMP_RULE_KEY,
        version: 1,
        content: { face_value: faceValue, validity_days: validityDays },
        effectiveAt: new Date(Date.now() - 86_400_000),
      }),
    );
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [BenefitsModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
    coupons = app.get(CouponService);
    userToken = await jwt.signAsync({ sub: String(USER), role: 'user', roles: ['user'] });
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

  // ---------- 发放（幂等 + 事件 + 定义回退） ----------

  it('grantPriceComp：ACTIVE 行（source=price_compensation/source_ref=price_change:{id}:u{user}）+ CouponGranted 出箱（面额快照=seed 50.00）；指令重放幂等（零新行零新事件）', async () => {
    const r = await coupons.grantPriceComp({ price_change_id: 41, user_id: USER });
    expect(r.deduplicated).toBe(false);
    expect(r.grant.status).toBe('ACTIVE');
    expect(r.grant.coupon_id).toBe(1);
    expect(r.grant.face_value).toBe('50.00');
    expect(r.grant.used_at).toBeNull();

    const rows = await grantsRaw();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: String(USER),
      source: 'price_compensation',
      source_ref: 'price_change:41:u721',
      status: 'ACTIVE',
    });
    // expires_at≈now+90d（seed 有效期）
    expect(
      Math.abs(new Date(rows[0]!.expires_at).getTime() - (Date.now() + 90 * 86_400_000)),
    ).toBeLessThan(60_000);

    const events = await couponEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      grant_id: Number(rows[0]!.id),
      user_id: USER,
      coupon_id: 1,
      face_value: '50.00',
    });
    expect(typeof (events[0] as { expires_at: string }).expires_at).toBe('string');

    // at-least-once 指令重放：同键短路
    const replay = await coupons.grantPriceComp({ price_change_id: 41, user_id: USER });
    expect(replay.deduplicated).toBe(true);
    expect(replay.grant.id).toBe(r.grant.id);
    expect(await grantsRaw()).toHaveLength(1);
    expect(await couponEvents()).toHaveLength(1);
  });

  it('券定义解析：H7 coupon.price_comp 现行版优先（面额/有效期取规则值）；规则缺内容键回退 seed 行', async () => {
    await seedRule('88.00', 30);
    const r = await coupons.grantPriceComp({ price_change_id: 42, user_id: USER });
    expect(r.grant.face_value).toBe('88.00');
    const rows = await grantsRaw();
    expect(
      Math.abs(new Date(rows[0]!.expires_at).getTime() - (Date.now() + 30 * 86_400_000)),
    ).toBeLessThan(60_000);
    const events = await couponEvents();
    expect(events[0]).toMatchObject({ face_value: '88.00' });
    // 规则行随 TRUNCATE 清场（后续用例回 seed 回退）；snapshotAt 无进程缓存=即时可见
  });

  it('grantPriceComp 入参校验：非正整数 400（载荷非法进重试轨道由消费器承载，服务面显性拒绝）', async () => {
    await expect(coupons.grantPriceComp({ price_change_id: 0, user_id: USER })).rejects.toThrow();
    await expect(coupons.grantPriceComp({ price_change_id: 1, user_id: -5 })).rejects.toThrow();
    expect(await grantsRaw()).toHaveLength(0);
  });

  // ---------- GET /coupons/mine（惰性到期） ----------

  it('GET /coupons/mine：ACTIVE 券回显（face_value join 定义行）；过期 ACTIVE 行读时翻转 EXPIRED（守卫+STL）', async () => {
    await coupons.grantPriceComp({ price_change_id: 43, user_id: USER });
    // 时间旅行：回拨过期时刻
    await pool.query(
      `UPDATE benefits.coupon_grants SET expires_at = now() - interval '1 day' WHERE user_id = $1`,
      [USER],
    );
    const mine = await request(app.getHttpServer())
      .get('/coupons/mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({
      coupon_id: 1,
      status: 'EXPIRED',
      face_value: '50.00',
    });
    const stl = await pool.query<{ to_status: string }>(
      `SELECT to_status FROM platform.state_transition_log
        WHERE entity_type = 'coupon_grant' ORDER BY id`,
    );
    expect(stl.rows).toEqual([{ to_status: 'EXPIRED' }]);
  });

  it('GET /coupons/mine 鉴权：未认证 401；非 user 激活角色 403', async () => {
    const anon = await request(app.getHttpServer()).get('/coupons/mine');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);
    const lawyerToken = await jwt.signAsync({
      sub: '9911',
      role: 'lawyer',
      roles: ['user', 'lawyer'],
    });
    const asLawyer = await request(app.getHttpServer())
      .get('/coupons/mine')
      .set('Authorization', `Bearer ${lawyerToken}`);
    expect(asLawyer.status).toBe(403);
  });

  // ---------- 周期到期（POINTS_EXPIRE 日扫槽 sweepExpired） ----------

  it('sweepExpired：过期 ACTIVE 行批量翻转 EXPIRED（周期半边）；未过期/终态行不动', async () => {
    await coupons.grantPriceComp({ price_change_id: 44, user_id: USER });
    await coupons.grantPriceComp({ price_change_id: 45, user_id: USER_B });
    await pool.query(
      `UPDATE benefits.coupon_grants SET expires_at = now() - interval '2 hours' WHERE user_id = $1`,
      [USER],
    );
    const poolSvc = app.get(PgPoolService);
    const r = await poolSvc.withTransaction((uow) => coupons.sweepExpired(uow));
    expect(r).toEqual({ coupons_expired: 1 });
    const rows = await grantsRaw();
    const byUser = new Map(rows.map((x) => [Number(x.user_id), x.status]));
    expect(byUser.get(USER)).toBe('EXPIRED');
    expect(byUser.get(USER_B)).toBe('ACTIVE');
    // 重扫幂等
    const again = await poolSvc.withTransaction((uow) => coupons.sweepExpired(uow));
    expect(again).toEqual({ coupons_expired: 0 });
  });

  // ---------- 核销最小面（C3 联动预留接口位） ----------

  it('redeemInTx：ACTIVE→USED（守卫+STL reason=redeem:{order_ref}+used_at 落位）；重放幂等 deduplicated', async () => {
    const g = await coupons.grantPriceComp({ price_change_id: 46, user_id: USER });
    const poolSvc = app.get(PgPoolService);
    const r = await poolSvc.withTransaction((uow) =>
      coupons.redeemInTx(uow, { grant_id: g.grant.id, user_id: USER, order_ref: 'order:901' }),
    );
    expect(r.deduplicated).toBe(false);
    expect(r.grant.status).toBe('USED');
    expect(r.grant.used_at).not.toBeNull();
    const stl = await pool.query<{ reason: string }>(
      `SELECT reason FROM platform.state_transition_log WHERE entity_type = 'coupon_grant'`,
    );
    expect(stl.rows[0]!.reason).toBe('redeem:order:901');

    const replay = await poolSvc.withTransaction((uow) =>
      coupons.redeemInTx(uow, { grant_id: g.grant.id, user_id: USER, order_ref: 'order:901' }),
    );
    expect(replay.deduplicated).toBe(true);
    expect(replay.grant.status).toBe('USED');
  });

  it('redeemInTx 边界：EXPIRED→409；非属主→403；无行→404', async () => {
    const g = await coupons.grantPriceComp({ price_change_id: 47, user_id: USER });
    await pool.query(`UPDATE benefits.coupon_grants SET expires_at = now() - interval '1 day'`);
    const poolSvc = app.get(PgPoolService);
    await poolSvc.withTransaction((uow) => coupons.sweepExpired(uow));
    await expect(
      poolSvc.withTransaction((uow) =>
        coupons.redeemInTx(uow, { grant_id: g.grant.id, user_id: USER, order_ref: 'order:902' }),
      ),
    ).rejects.toThrow(/已过期/);
    await expect(
      poolSvc.withTransaction((uow) =>
        coupons.redeemInTx(uow, { grant_id: g.grant.id, user_id: USER_B, order_ref: 'order:902' }),
      ),
    ).rejects.toThrow(/属主/);
    await expect(
      poolSvc.withTransaction((uow) =>
        coupons.redeemInTx(uow, { grant_id: 99999, user_id: USER, order_ref: 'order:902' }),
      ),
    ).rejects.toThrow();
  });

  it('修复环 I-1：过期未扫的 ACTIVE 行核销被拒（409 与 EXPIRED 分支同语义）——不翻状态不复活', async () => {
    const g = await coupons.grantPriceComp({ price_change_id: 48, user_id: USER });
    // 回拨过期时刻但**不触发**惰性/周期翻转（status 仍 ACTIVE）
    await pool.query(
      `UPDATE benefits.coupon_grants SET expires_at = now() - interval '2 hours' WHERE id = $1`,
      [g.grant.id],
    );
    const poolSvc = app.get(PgPoolService);
    await expect(
      poolSvc.withTransaction((uow) =>
        coupons.redeemInTx(uow, { grant_id: g.grant.id, user_id: USER, order_ref: 'order:903' }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    // 未被核销复活：行仍 ACTIVE（翻转归读路径/日扫），无 USED 留痕
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM benefits.coupon_grants WHERE id = $1`,
      [g.grant.id],
    );
    expect(row.rows[0]!.status).toBe('ACTIVE');
    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log WHERE entity_type = 'coupon_grant'`,
    );
    expect(stl.rows[0]!.n).toBe(0);
  });
});
