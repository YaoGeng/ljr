import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ENROLLMENT_PAID_TOPIC,
  ErrorCode,
  GROUP_BUY_EXPIRED_TOPIC,
  GROUP_BUY_REACHED_TOPIC,
  LAWYER_REJECTED_TOPIC,
  REFUND_COMPLETED_TOPIC,
  SESSION_FAILED_TOPIC,
  SESSION_FULL_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { PgPoolService } from '../../infrastructure/sql';
import {
  countPointsTxnsByKind,
  getPointsAccount,
  getPointsBalance,
} from '../benefits/points-fixture';
import { PointsService } from '../benefits/points.service';
import { seedRestriction } from '../credit/credit-fixture';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { IdentityTokenService } from '../identity/identity.token.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { RealnameService } from '../identity/realname.service';
import {
  countPaymentOrders,
  getPaymentOrderById,
  getPaymentOrderByKey,
  listInboxStatusesByTxnNoPrefix,
  listRefundsByOrderId,
} from '../payment/order-fixture';
import { PAYMENT_CONFIG } from '../payment/payment.config';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { RefundService } from '../payment/refund.service';
import { RuleCenterService } from '../ops/rule-center.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { EnrollmentService } from './enrollment.service';
import { enrollmentOrderKey } from './enrollment.types';
import { GroupBuyService } from './group-buy.service';
import { SessionService } from './session.service';
import { TradeModule } from './trade.module';

/**
 * C3 领域集成（需 PG；§4/§5/§7/§9/§10 + Task 7 简报）：真链驱动——报名经 EnrollmentService、
 * 支付成功经 F1 ingestCallback（HMAC 真验签）→ outbox → relay.tick 扇出（F2 两 handler + 本模块
 * 守卫消费器）→ 成团原子守卫。覆盖：
 *   闸口：R-06 未实名 402 / G1 BAN_JOIN 403 / R-05 截止前 30s 边界两侧 / 满员 409 / REACHED_LOCKED；
 *   下单：快照六键 R-03（改价不影响+版本锚）/ R-W3-I seatPriceFor 末位尾差 Σ≡total / 末位 patch<0
 *   下界守卫 400 / 幂等键=user+ref（同载荷重放原单、异载荷 409）/ R-04 50% 整与零头边界 +
 *   INSUFFICIENT 409 透传 + 同事务零残留；
 *   成团守卫：首笔回调全链（PAID+joined+STL+EnrollmentPaid+F4 settle+FROZEN+inbox CONSUMED）、
 *   **并发 2×capacity 恰 capacity**（真并发多 tick + 其余自动退款）、重复投递幂等恰一次、
 *   满员后回调自动退款分支（§10）、流标后到达同款、SessionFull/GroupBuyReached 出箱、
 *   REACHED 后加入被拒；
 *   终态协调：R-W3-M 真源批量退款全链（SessionFailed→RefundSource→F2→RefundCompleted→PAID→
 *   REFUNDED+积分还原）、R-W3-O 未支付清场（PENDING 保持+解冻+重投不双计）、C2 cancel 扩展
 *   （他人已支付 409 / 仅 PENDING 可取消+GroupBuyExpired 扫场解冻）、终态后重报=新行
 *   （ux_enroll_active 部分唯一行为）。
 */

const HOUR = 3_600_000;
const VALID_ID_NO = '11010519491231002X'; // A2 mock 通道：GB11643 校验位合法 → VERIFIED

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** B3 默认价种子（one_on_one_prices 为 B3 契约必填矩阵，值不影响本模块断言） */
const B3_ONE_ON_ONE = {
  text: { per_round: '50.00' },
  voice: { per_15min: '100.00' },
  video: { per_15min: '100.00' },
};

describe('C3 报名与支付成团（成团原子守卫/闸口/快照/终态协调，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let enrollments: EnrollmentService;
  let sessions: SessionService;
  let groupBuys: GroupBuyService;
  let gateway: PaymentGatewayService;
  let points: PointsService;
  let pricing: PricingConfigService;
  let realname: RealnameService;
  let tokens: IdentityTokenService;
  let relay: OutboxRelayService;
  let poolSvc: PgPoolService;
  let channelSecret: string;
  let userSeq = 7000;
  let lawyerSeq = 9700;
  let txnSeq = 0;

  const nextUser = (): number => {
    userSeq += 1;
    return userSeq;
  };
  const nextLawyer = (): number => {
    lawyerSeq += 1;
    return lawyerSeq;
  };

  const seedUser = async (userId: number): Promise<void> => {
    await realname.submitRealname(userId, { name: '张三', idNo: VALID_ID_NO });
  };

  const seedPricing = async (
    lawyerId: number,
    fields: {
      per_head?: string | null;
      session_total?: string | null;
      accept_min?: number | null;
      accept_max?: number | null;
    } = {},
  ): Promise<void> => {
    const current = await pricing.getCurrentPricing(lawyerId); // 乐观锁令牌：以服务端现值递进
    await pricing.putPricing(lawyerId, {
      base_version: current.version,
      per_head: fields.per_head ?? null,
      session_total: fields.session_total ?? null,
      group_size: null,
      accept_min: fields.accept_min ?? null,
      accept_max: fields.accept_max ?? null,
      room_modes: null,
      one_on_one_prices: B3_ONE_ON_ONE,
    });
  };

  const createSession = (
    lawyerId: number,
    over: Record<string, unknown> = {},
  ): Promise<{ id: number }> =>
    sessions.create({
      lawyer_id: lawyerId,
      slot_start: new Date(Date.now() + 25 * HOUR),
      price_mode: 'per_head',
      unit_price: '50.00',
      capacity: 2,
      room_mode: 'text',
      ...over,
    } as Parameters<SessionService['create']>[0]) as unknown as Promise<{ id: number }>;

  const enroll = (
    refType: 'session' | 'groupbuy',
    refId: number,
    userId: number,
    pointsToUse = 0,
  ) =>
    enrollments.create({
      ref_type: refType,
      ref_id: refId,
      user_id: userId,
      ...(pointsToUse > 0 ? { points_to_use: pointsToUse } : {}),
    });

  /** F1 回调真验签投递（PAY_SUCCESS / REFUND_SUCCESS）——F1 HTTP 面同口径（HMAC-SHA256） */
  const ingest = async (
    orderId: number,
    eventType: 'PAY_SUCCESS' | 'REFUND_SUCCESS',
    txnNo: string,
  ): Promise<void> => {
    const raw = Buffer.from(
      JSON.stringify({ order_id: orderId, event_type: eventType, channel_txn_no: txnNo }),
    );
    await gateway.ingestCallback(
      'wechat_ecom',
      raw,
      createHmac('sha256', channelSecret).update(raw).digest('hex'),
    );
  };

  const paySuccess = async (orderId: number): Promise<void> => {
    txnSeq += 1;
    await ingest(orderId, 'PAY_SUCCESS', `MOCK-WECHAT-T7-${txnSeq}`);
  };

  const tick = (): Promise<unknown> => relay.tick();

  /** 投递清空（本用例布景事件多，单轮 batch=10 不够——drain 至整轮零动作：dispatched/retried/
   *  dead 全 0 才停，重试轨事件（无 handler 布景事件）不阻断 drain 前行） */
  const drainRelay = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) {
      const r = await relay.tick();
      if (r.dispatched === 0 && r.retried === 0 && r.dead === 0) break;
    }
  };

  // ---- 断言夹具（跨域读一律经 owner 夹具：benefits/payment 表名禁内联，schema-refs 纪律；
  //      本模块表 trade.* 与平台横切表 platform.* 直读合法） ----

  const enrollmentOf = async (id: number) => {
    const res = await pool.query<Record<string, unknown>>(
      `SELECT * FROM trade.enrollments WHERE id = $1`,
      [id],
    );
    return res.rows[0]!;
  };

  const enrollmentsOfRef = async (refType: string, refId: number) => {
    const res = await pool.query<Record<string, unknown>>(
      `SELECT * FROM trade.enrollments WHERE ref_type = $1 AND ref_id = $2 ORDER BY id`,
      [refType, refId],
    );
    return res.rows;
  };

  const sessionOf = async (id: number) => {
    const res = await pool.query<Record<string, unknown>>(
      `SELECT * FROM trade.sessions WHERE id = $1`,
      [id],
    );
    return res.rows[0]!;
  };

  const stlOf = async (entityType: string, entityId: number) => {
    const res = await pool.query<{ from_status: string; to_status: string; allowed: boolean }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`,
      [entityType, entityId],
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

  const refundsOfOrder = (orderId: number) => listRefundsByOrderId(pool, orderId);

  const orderOf = (orderId: number) => getPaymentOrderById(pool, orderId);

  const enrollOrderOf = (enrollmentId: number) =>
    getPaymentOrderByKey(pool, enrollmentOrderKey(enrollmentId));

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TradeModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // onModuleInit：退款源注册 + 消费器注册到 relay
    enrollments = app.get(EnrollmentService);
    sessions = app.get(SessionService);
    groupBuys = app.get(GroupBuyService);
    gateway = app.get(PaymentGatewayService);
    points = app.get(PointsService);
    pricing = app.get(PricingConfigService);
    realname = app.get(RealnameService);
    tokens = app.get(IdentityTokenService);
    relay = app.get(OutboxRelayService);
    poolSvc = app.get(PgPoolService);
    channelSecret = app.get(PAYMENT_CONFIG).primary.secret;
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
  // 闸口（R-06 / G1 / R-05 / 满员）
  // ===========================================================================

  it('R-06 未实名 402 E_REALNAME_REQUIRED；G1 BAN_JOIN 403 E_RESTRICTED（闸口顺序：实名先行）', async () => {
    const lawyer = nextLawyer();
    const session = await createSession(lawyer);
    const noRealname = nextUser();
    await expect(enroll('session', session.id, noRealname)).rejects.toMatchObject({
      code: ErrorCode.RealnameRequired,
      httpStatus: 402,
    });

    const banned = nextUser();
    await seedUser(banned);
    await seedRestriction(pool, 'user', banned, 'BAN_JOIN');
    await expect(enroll('session', session.id, banned)).rejects.toMatchObject({
      code: ErrorCode.Restricted,
      httpStatus: 403,
    });

    // 闸口顺序：未实名 + 被限制并存 → 实名 402 先行（简报闸口顺序逐字）
    const both = nextUser();
    await seedRestriction(pool, 'user', both, 'BAN_JOIN');
    await expect(enroll('session', session.id, both)).rejects.toMatchObject({
      code: ErrorCode.RealnameRequired,
    });
  });

  it('R-05 截止前 30s 停开新单：deadline−30s 之内 409 E_FULL_OR_DEADLINE；之外放行（边界两侧）', async () => {
    const lawyer = nextLawyer();
    const inside = nextUser();
    await seedUser(inside);
    const rejected = await createSession(lawyer, {
      enroll_deadline: new Date(Date.now() + 25_000), // 25s < 30s lead → 拒
    });
    await expect(enroll('session', rejected.id, inside)).rejects.toMatchObject({
      code: ErrorCode.FullOrDeadline,
      httpStatus: 409,
    });

    const allowed = await createSession(lawyer, {
      enroll_deadline: new Date(Date.now() + 65_000), // 65s > 30s lead → 放行
    });
    const ok = await enroll('session', allowed.id, inside);
    expect(ok.enrollment_id).toBeGreaterThan(0);
  });

  // ===========================================================================
  // 报名下单链（幂等 / 快照 / R-04 / 同事务回滚）
  // ===========================================================================

  it('幂等键=user+ref：同键同载荷重放原支付单；异载荷 409 E_ENROLL_DUP_KEY；PAID 后同载荷仍重放', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    await points.grant({ user_id: user, points: 1_000, kind: 'COMPENSATION', ref: 't7:idem' });
    const session = await createSession(lawyer);

    const first = await enroll('session', session.id, user, 100);
    const replay = await enroll('session', session.id, user, 100);
    expect(replay.payment_order.id).toBe(first.payment_order.id); // 同键同载荷=幂等返回原单
    expect(replay.enrollment_id).toBe(first.enrollment_id);
    expect(await countPaymentOrders(pool)).toBe(1); // 不重复开单

    await expect(enroll('session', session.id, user, 200)).rejects.toMatchObject({
      code: ErrorCode.EnrollDuplicateKey,
      httpStatus: 409,
    });

    // 支付后（PAID 仍在活跃唯一索引域）同载荷仍重放原单
    await paySuccess(first.payment_order.id);
    await tick();
    const afterPaid = await enroll('session', session.id, user, 100);
    expect(afterPaid.payment_order.id).toBe(first.payment_order.id);
    expect(await countPaymentOrders(pool)).toBe(1);
  });

  it('R-03 快照价：session_total 模式 seatPriceFor 本席价（Σ≡total）+ 律师改价不影响快照 + price_version 锚 B3 报名时点版本', async () => {
    const lawyer = nextLawyer();
    await seedPricing(lawyer, { session_total: '100.01' });
    const session = (await sessions.create({
      lawyer_id: lawyer,
      slot_start: new Date(Date.now() + 25 * HOUR),
      price_mode: 'session_total',
      capacity: 3,
      room_mode: 'text',
    } as Parameters<SessionService['create']>[0])) as unknown as { id: number };
    const current = await pricing.getCurrentPricing(lawyer);

    const u1 = nextUser();
    const u2 = nextUser();
    await seedUser(u1);
    await seedUser(u2);
    const e1 = await enroll('session', session.id, u1);
    const e2 = await enroll('session', session.id, u2);

    // 前位席=半分向上分摊 33.34；快照六键形状（§3 逐字；share_price=null=B2C 场次）
    expect(e1.paid_amount).toBe('33.34');
    expect(e1.pay_params).toBeTruthy();
    const row1 = await enrollmentOf(e1.enrollment_id);
    const snap1 = row1['price_snapshot'] as Record<string, unknown>;
    expect(snap1).toMatchObject({
      price_mode: 'session_total',
      unit_price: '33.34',
      share_price: null,
      session_total: '100.01',
      price_version: current.version,
    });
    expect(typeof snap1['snapshot_at']).toBe('string');

    // 律师改价（B3 新版本）：已建场次价格不变 → 新用户报名快照仍 33.34，price_version=新版本
    await seedPricing(lawyer, { session_total: '200.00' });
    const u3 = nextUser();
    await seedUser(u3);
    const e3 = await enroll('session', session.id, u3);
    expect(e3.paid_amount).toBe('33.34'); // R-03：改价不影响快照口径（场次价格在开团时固化）
    const snap3 = (await enrollmentOf(e3.enrollment_id))['price_snapshot'] as Record<
      string,
      unknown
    >;
    expect(snap3['price_version']).toBe(current.version + 1); // 版本锚=报名时点 B3 当前版本
    expect(snap3['unit_price']).toBe('33.34');

    // 末位席（seatNo=capacity）=patch 差额：席位序=报名时点 joined+1（支付推进）——先付两席，
    // 第三席报名即末位：seatPriceFor 末位 patch=100.01−33.34×2=33.33，Σ(1..3) ≡ session_total
    await paySuccess(e1.payment_order.id);
    await paySuccess(e2.payment_order.id);
    await Promise.all([tick(), tick()]);
    expect((await sessionOf(session.id))['joined']).toBe(2);
    const u4 = nextUser();
    await seedUser(u4);
    const e4 = await enroll('session', session.id, u4);
    expect(e4.paid_amount).toBe('33.33'); // 末位 patch，少收方向（R-W3-I）
    const paidSum = Number(e1.paid_amount) + Number(e3.paid_amount) + Number(e4.paid_amount);
    expect(paidSum.toFixed(2)).toBe('100.01');
  });

  it('per_head 模式本席单价恒 unit_price；末位 patch 下界守卫（T4 minor①）：patch<0 → 400 拒绝该场报名', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    const session = await createSession(lawyer, { unit_price: '50.00' });
    const ok = await enroll('session', session.id, user);
    expect(ok.paid_amount).toBe('50.00');
    const snap = (await enrollmentOf(ok.enrollment_id))['price_snapshot'] as Record<
      string,
      unknown
    >;
    expect(snap).toMatchObject({ price_mode: 'per_head', unit_price: '50.00' });

    // 数据退化场（直改行构造现实价格域不可达形态）：末位 patch=10.00−9.00×2<0
    const degraded = await createSession(lawyer, { capacity: 3 });
    await pool.query(
      `UPDATE trade.sessions SET price_mode = 'session_total', unit_price = 9.00,
         session_total = 10.00 WHERE id = $1`,
      [degraded.id],
    );
    await expect(enroll('session', degraded.id, user)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
    const rows = await enrollmentsOfRef('session', degraded.id);
    expect(rows).toHaveLength(0); // 拒绝该场报名：零业务行
  });

  it('R-04 50% 整/零头边界：恰 floor(应付/2) 放行、+1 拒 400；cash+points=应付（F1 拆分+冻结额核对）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    await points.grant({ user_id: user, points: 10_000, kind: 'COMPENSATION', ref: 't7:r04' });
    // 应付 10.01（1001 分）→ 上限 floor(1001/2)=500：零头边界（501 分=5002>1001 拒）
    const session = await createSession(lawyer, { unit_price: '10.01' });
    await expect(enroll('session', session.id, user, 501)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
    const ok = await enroll('session', session.id, user, 500); // 恰 50% 放行
    expect(ok.points_amount).toBe(500);
    expect(ok.cash_amount).toBe('5.01'); // cash+points=应付：501 分现金 + 500 积分 = 1001 分
    expect(ok.payment_order.cash_amount).toBe('5.01');
    expect(ok.payment_order.points_amount).toBe(500);
    expect(await getPointsAccount(pool, user)).toMatchObject({ balance: 9_500, frozen: 500 });
  });

  it('R-04 INSUFFICIENT 409 透传 + 同事务零残留（enrollment/支付单/冻结全回滚）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    await points.grant({ user_id: user, points: 100, kind: 'COMPENSATION', ref: 't7:ins' });
    const session = await createSession(lawyer);
    const before = await countPaymentOrders(pool);
    // points 200：恰在 50% 上限内（应付 50.00=5000 分 → 上限 2500）而超余额 100 → INSUFFICIENT
    await expect(enroll('session', session.id, user, 200)).rejects.toMatchObject({
      code: ErrorCode.InsufficientFunds,
      httpStatus: 409,
    });
    const rows = await enrollmentsOfRef('session', session.id);
    expect(rows).toHaveLength(0); // 零残留：报名行回滚
    expect(await countPaymentOrders(pool)).toBe(before); // 支付单回滚（不烧幂等键）
    expect(await getPointsBalance(pool, user)).toBe(100); // 余额原封
    expect(await countPointsTxnsByKind(pool, user, 'FREEZE')).toBe(0); // 冻结回滚（「含冻结」逐字）
  });

  // ===========================================================================
  // 成团原子守卫（§4 灵魂；先 UPDATE 后 INSERT 铁律 / 并发 / 幂等 / 自动退款）
  // ===========================================================================

  it('首笔回调全链：F1 FROZEN→席位+1→PAID(STL)→F4 settle→EnrollmentPaid 出箱→inbox CONSUMED（§4 语句序）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    await points.grant({ user_id: user, points: 1_000, kind: 'COMPENSATION', ref: 't7:first' });
    const session = await createSession(lawyer);
    const e = await enroll('session', session.id, user, 100);

    await paySuccess(e.payment_order.id);
    await tick();

    const row = await enrollmentOf(e.enrollment_id);
    expect(row['pay_status']).toBe('PAID');
    const sessionRow = await sessionOf(session.id);
    expect(sessionRow['joined']).toBe(1); // 席位计数唯一写点=守卫 SQL
    const order = await orderOf(e.payment_order.id);
    expect(order['status']).toBe('FROZEN'); // R-01 支付即冻结（CREATED→FROZEN）
    expect(await getPointsAccount(pool, user)).toMatchObject({ balance: 900, frozen: 0 }); // settle：冻结→核销
    expect(await countPointsTxnsByKind(pool, user, 'REDEEM')).toBe(1);

    const paid = outboxOf(ENROLLMENT_PAID_TOPIC);
    expect((await paid).length).toBe(1);
    expect((await paid)[0]!.payload).toMatchObject({
      ref_type: 'session',
      ref_id: session.id,
      user_id: user,
      amounts: { paid: '50.00', cash: '49.00', points: 100 },
    });
    // inbox 消费标记（读数经 payment owner 夹具，schema-refs 纪律）
    expect(await listInboxStatusesByTxnNoPrefix(pool, 'MOCK-WECHAT-T7-')).toEqual(['CONSUMED']);
    // STL：enrollment PENDING→PAID 全迁移可查（§10）
    const stl = await stlOf('enrollment', e.enrollment_id);
    expect(stl).toContainEqual(
      expect.objectContaining({ from_status: 'PENDING', to_status: 'PAID', allowed: true }),
    );
  });

  it('§9/§10 并发 2×capacity 恰 capacity 成功+其余自动退款（真并发多 tick；SessionFull 恰一次）', async () => {
    const lawyer = nextLawyer();
    const session = await createSession(lawyer, { capacity: 2 });
    const users = [nextUser(), nextUser(), nextUser(), nextUser()];
    for (const u of users) await seedUser(u);
    const es: { enrollment_id: number; payment_order: { id: number } }[] = [];
    for (const u of users) es.push(await enroll('session', session.id, u));
    expect((await enrollmentsOfRef('session', session.id)).length).toBe(4);

    // 4 笔回调真并发：多 tick 各持连接（SKIP LOCKED 抢占），守卫事务在场次行锁上串行
    await Promise.all(users.map((_, i) => paySuccess(es[i]!.payment_order.id)));
    await Promise.all([tick(), tick(), tick(), tick(), tick()]);

    const rows = await enrollmentsOfRef('session', session.id);
    const paid = rows.filter((r) => r['pay_status'] === 'PAID');
    const refunded = rows.filter((r) => r['pay_status'] === 'REFUNDED');
    expect(paid).toHaveLength(2); // 恰 capacity 成功（超卖=0）
    expect(refunded).toHaveLength(2); // 其余全部自动退款

    const sessionRow = await sessionOf(session.id);
    expect(sessionRow['joined']).toBe(2);
    expect(sessionRow['status']).toBe('FULL'); // joined==capacity → markFull
    expect(await outboxOf(SESSION_FULL_TOPIC)).toHaveLength(1); // SessionFull 恰一次

    // 自动退款分支：每笔退款单在册（现金原路退受理；积分 UNFREEZE 原额回摆——本例 0 分）
    for (const r of refunded) {
      const order = await enrollOrderOf(Number(r['id']));
      expect(order['status']).toBe('REFUNDING');
      const rf = await refundsOfOrder(order['id'] as number);
      expect(rf).toHaveLength(1);
      expect(rf[0]).toMatchObject({ cash_amount: '50.00', points_amount: 0, reason: 'GROUP_FAIL' });
      const stl = await stlOf('enrollment', Number(r['id']));
      expect(stl).toContainEqual(
        expect.objectContaining({
          from_status: 'PENDING',
          to_status: 'REFUNDED',
          allowed: true,
        }),
      );
    }
    // EnrollmentPaid 恰 capacity 条（退款不出箱）
    expect(await outboxOf(ENROLLMENT_PAID_TOPIC)).toHaveLength(2);
  });

  it('幂等：同一回调重复投递恰一次（outbox 重投→守卫短路：joined 不变/无新退款/无新事件）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    const session = await createSession(lawyer, { capacity: 2 });
    const e = await enroll('session', session.id, user);
    await paySuccess(e.payment_order.id);
    await tick();
    const joined1 = (await sessionOf(session.id))['joined'];
    const stlCount1 = (await stlOf('enrollment', e.enrollment_id)).length;

    // 手工注入同一载荷的重投事件（新 event_id）——relay at-least-once 的崩溃窗口等价形态
    await pool.query(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES (gen_random_uuid(), 'payment.callback.inboxed', $1::jsonb, 'PENDING')`,
      [
        JSON.stringify({
          biz_idempotency_key: `enroll/e${e.enrollment_id}/pay:PAY_SUCCESS`,
          event: 'PAY_SUCCESS',
        }),
      ],
    );
    await tick();
    expect((await sessionOf(session.id))['joined']).toBe(joined1); // 席位不双计
    expect((await stlOf('enrollment', e.enrollment_id)).length).toBe(stlCount1); // 无新迁移
    expect(await outboxOf(ENROLLMENT_PAID_TOPIC)).toHaveLength(1); // 无新事件
  });

  it('§10 满员后回调自动退款分支 100% 触发（资损不变量）；终态后重报=新行且历史行保留（部分唯一索引）', async () => {
    const lawyer = nextLawyer();
    const session = await createSession(lawyer, { capacity: 2 });
    const [u1, u2, u3] = [nextUser(), nextUser(), nextUser()];
    for (const u of [u1, u2, u3]) await seedUser(u);
    const e1 = await enroll('session', session.id, u1);
    const e2 = await enroll('session', session.id, u2);
    const e3 = await enroll('session', session.id, u3); // 满员前报名（PENDING）
    await paySuccess(e1.payment_order.id);
    await paySuccess(e2.payment_order.id);
    await Promise.all([tick(), tick()]);
    expect((await sessionOf(session.id))['status']).toBe('FULL');

    // 满员后 u3 的回调到达 → 自动退款分支
    await paySuccess(e3.payment_order.id);
    await tick();
    const row3 = await enrollmentOf(e3.enrollment_id);
    expect(row3['pay_status']).toBe('REFUNDED');
    const order3 = await enrollOrderOf(e3.enrollment_id);
    expect(order3['status']).toBe('REFUNDING');
    expect(await refundsOfOrder(order3['id'] as number)).toHaveLength(1);
    expect((await sessionOf(session.id))['joined']).toBe(2); // 溢出回调零席位影响

    // 重投不重退（幂等）：REFUNDED 后同载荷重放短路
    const refundCount = (await refundsOfOrder(order3['id'] as number)).length;
    await pool.query(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES (gen_random_uuid(), 'payment.callback.inboxed', $1::jsonb, 'PENDING')`,
      [
        JSON.stringify({
          biz_idempotency_key: `enroll/e${e3.enrollment_id}/pay:PAY_SUCCESS`,
          event: 'PAY_SUCCESS',
        }),
      ],
    );
    await tick();
    expect(await refundsOfOrder(order3['id'] as number)).toHaveLength(refundCount);

    // §10-6 终态后重报=新行：REFUNDED 行不占活跃唯一槽（夹具构造 REFUNDED 历史行于未满员的
    // 新场次 + 新报名成功——终态后重报同场次可达形态）
    const u4 = nextUser();
    await seedUser(u4);
    const reopen = await createSession(lawyer, { capacity: 2 });
    await pool.query(
      `INSERT INTO trade.enrollments (ref_type, ref_id, user_id, price_snapshot, unit_price,
         paid_amount, cash_amount, points_amount, price_version_id, pay_status, credit_used)
       VALUES ('session', $1, $2, '{}'::jsonb, '50.00', '50.00', '50.00', 0, 0, 'REFUNDED', 0)`,
      [reopen.id, u4],
    );
    const reEnroll = await enroll('session', reopen.id, u4); // 历史行保留 + 新行可建
    expect(reEnroll.enrollment_id).toBeGreaterThan(0);
    const all = await enrollmentsOfRef('session', reopen.id);
    expect(all.filter((r) => Number(r['user_id']) === u4)).toHaveLength(2); // 历史 REFUNDED 行 + 新 PENDING 行并存
  });

  it('流标后到达：SessionFailed 终态后回调 → 自动退款分支（R-05 下半句）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    const session = await createSession(lawyer, { capacity: 4 });
    const e = await enroll('session', session.id, user);
    // 截止流标（C1 failOnDeadline：PENDING 不计 joined → FAILED）
    await poolSvc.withTransaction((uow) => sessions.failOnDeadline(uow, session.id));
    expect((await sessionOf(session.id))['status']).toBe('FAILED');

    await paySuccess(e.payment_order.id);
    await tick();
    const row = await enrollmentOf(e.enrollment_id);
    expect(row['pay_status']).toBe('REFUNDED'); // 终态后到达 → 自动退款 100%
    const order = await enrollOrderOf(e.enrollment_id);
    expect(await refundsOfOrder(order['id'] as number)).toHaveLength(1);
  });

  // ===========================================================================
  // groupbuy join：REACHED 守卫 + 达线推进 + REACHED_LOCKED
  // ===========================================================================

  it('groupbuy join：PAID 计数达 sub_min → REACHED→PENDING_LAWYER+12h job+GroupBuyReached 恰一次；REACHED 后新加入 409；链内回调照常 PAID 不重复达线', async () => {
    const lawyer = nextLawyer();
    const initiator = nextUser();
    await seedUser(initiator);
    await seedPricing(lawyer, { session_total: '100.00', accept_min: 2, accept_max: 3 });
    const gb = await groupBuys.create({
      initiator_id: initiator,
      lawyer_id: lawyer,
      specialty: 'labor_arbitration',
      slot_start: new Date(Date.now() + 25 * HOUR),
      sub_min: 2,
      sub_max: 3,
      question_tags: ['劳动仲裁时效'],
    });
    const [u1, u2, u3] = [nextUser(), nextUser(), nextUser()];
    for (const u of [u1, u2, u3]) await seedUser(u);
    const gbId = gb.group_buy.id;
    const j1 = await enroll('groupbuy', gbId, u1);
    const j2 = await enroll('groupbuy', gbId, u2);
    const j3 = await enroll('groupbuy', gbId, u3); // 达线前报名（PENDING）

    await paySuccess(j1.payment_order.id);
    await tick();
    expect(await outboxOf(GROUP_BUY_REACHED_TOPIC)).toHaveLength(0); // 1<sub_min 不达线

    await paySuccess(j2.payment_order.id);
    await tick();
    // PAID 计数=2 ≥ sub_min → C2 守卫：REACHED→PENDING_LAWYER+12h job+出箱（一次跨两边）
    const gbRow = await pool.query<Record<string, unknown>>(
      `SELECT status, lawyer_confirm_by FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    expect(gbRow.rows[0]!['status']).toBe('PENDING_LAWYER');
    expect(gbRow.rows[0]!['lawyer_confirm_by']).not.toBeNull();
    expect(await outboxOf(GROUP_BUY_REACHED_TOPIC)).toHaveLength(1);
    const stlGb = await stlOf('group_buy', gbId);
    expect(stlGb).toContainEqual(
      expect.objectContaining({ from_status: 'PUBLISHED', to_status: 'REACHED', allowed: true }),
    );
    expect(stlGb).toContainEqual(
      expect.objectContaining({
        from_status: 'REACHED',
        to_status: 'PENDING_LAWYER',
        allowed: true,
      }),
    );

    // REACHED 后新加入被拒（assertJoinable → 409 E_REACHED_LOCKED）
    const u4 = nextUser();
    await seedUser(u4);
    await expect(enroll('groupbuy', gbId, u4)).rejects.toMatchObject({
      code: ErrorCode.ReachedLocked,
      httpStatus: 409,
    });

    // 链内已受理者的回调照常 PAID（先于锁人的报名不拒），不重复达线（C2 守卫幂等短路）
    await paySuccess(j3.payment_order.id);
    await tick();
    const row3 = await enrollmentOf(j3.enrollment_id);
    expect(row3['pay_status']).toBe('PAID');
    expect(await outboxOf(GROUP_BUY_REACHED_TOPIC)).toHaveLength(1); // 不重复
    const j1Row = await enrollmentOf(j1.enrollment_id);
    expect(j1Row['pay_status']).toBe('PAID');
  });

  // ===========================================================================
  // 终态协调（R-W3-M 真源批量退款全链 / R-W3-O 清场 / C2 cancel 扩展）
  // ===========================================================================

  it('R-W3-M 真源全链：SessionFailed→RefundSource(已注册)→F2 批量退款→RefundCompleted→PAID→REFUNDED+积分还原；R-W3-O 清场=PENDING 保持+UNFREEZE（重投不双计）', async () => {
    const lawyer = nextLawyer();
    const paidUser = nextUser();
    const pendingUser = nextUser();
    await seedUser(paidUser);
    await seedUser(pendingUser);
    await points.grant({ user_id: paidUser, points: 1_000, kind: 'COMPENSATION', ref: 't7:wm1' });
    await points.grant({
      user_id: pendingUser,
      points: 1_000,
      kind: 'COMPENSATION',
      ref: 't7:wm2',
    });
    const session = await createSession(lawyer, { capacity: 4, unit_price: '30.00' });
    const ePaid = await enroll('session', session.id, paidUser, 500); // PAID：cash 25.00 + points 500
    const ePending = await enroll('session', session.id, pendingUser, 300); // PENDING：冻结 300

    await paySuccess(ePaid.payment_order.id);
    await tick();
    expect((await enrollmentOf(ePaid.enrollment_id))['pay_status']).toBe('PAID');

    // 截止流标（真事件 SessionFailed；PENDING 不计 joined<capacity）
    await poolSvc.withTransaction((uow) => sessions.failOnDeadline(uow, session.id));
    await tick(); // 扇出：F2 批量退款（真源）+ 本模块清场

    // ① R-W3-M 真源：PAID 单全额退款受理（原支付拆分逐字段：cash 25.00 + points 500）
    const refunds = await refundsOfOrder(ePaid.payment_order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      user_id: paidUser,
      cash_amount: '25.00',
      points_amount: 500,
      reason: 'GROUP_FAIL',
    });
    // ② R-W3-O 清场：PENDING 保持 PENDING（三态词汇无「钱没收」终态）+ 积分解冻原额回摆
    const pendingRow = await enrollmentOf(ePending.enrollment_id);
    expect(pendingRow['pay_status']).toBe('PENDING');
    expect(await getPointsBalance(pool, pendingUser)).toBe(1_000); // 冻结 300 已解冻
    const pendingOrder = await enrollOrderOf(ePending.enrollment_id);
    expect(pendingOrder['status']).toBe('CREATED'); // F1 单保持 CREATED（不发明关单指令）

    // ③ REFUND_SUCCESS 回调 → DONE → RefundCompleted → 本模块收敛 PAID→REFUNDED + R-03 还原
    txnSeq += 1;
    await ingest(ePaid.payment_order.id, 'REFUND_SUCCESS', `MOCK-WECHAT-T7R-${txnSeq}`);
    await tick(); // F2 收敛 DONE
    expect((await refundsOfOrder(ePaid.payment_order.id))[0]!['status']).toBe('DONE');
    await tick(); // RefundCompleted 出箱 → 收敛消费
    expect(await outboxOf(REFUND_COMPLETED_TOPIC)).toHaveLength(1);
    const paidRow = await enrollmentOf(ePaid.enrollment_id);
    expect(paidRow['pay_status']).toBe('REFUNDED'); // PAID→REFUNDED（STL）
    const stl = await stlOf('enrollment', ePaid.enrollment_id);
    expect(stl).toContainEqual(
      expect.objectContaining({ from_status: 'PAID', to_status: 'REFUNDED', allowed: true }),
    );
    expect(await getPointsBalance(pool, paidUser)).toBe(1_000); // 1000 授予 − 500 核销 + 500 R-03 还原 = 1000（守恒）
    // 重投清场事件：解冻幂等不双计（pendingUser 仍 1000）
    await pool.query(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES (gen_random_uuid(), $1, $2::jsonb, 'PENDING')`,
      [SESSION_FAILED_TOPIC, JSON.stringify({ id: session.id, reason: 'ENROLL_DEADLINE_PASSED' })],
    );
    await tick();
    expect(await getPointsBalance(pool, pendingUser)).toBe(1_000);
  });

  it('C2 cancel 检查点扩展（T5 评审 F1 交接）：他人已支付后发起人取消 409 E_HAS_JOINED；仅 PENDING 可取消且 GroupBuyExpired 扫场解冻', async () => {
    const lawyer = nextLawyer();
    await seedPricing(lawyer, { session_total: '100.00', accept_min: 2, accept_max: 3 });
    const publishGb = async (): Promise<{ id: number; initiator: number }> => {
      const initiator = nextUser();
      await seedUser(initiator);
      const gb = await groupBuys.create({
        initiator_id: initiator,
        lawyer_id: lawyer,
        specialty: 'labor_arbitration',
        slot_start: new Date(Date.now() + 25 * HOUR),
        sub_min: 2,
        sub_max: 3,
        question_tags: ['劳动仲裁时效'],
      });
      const view = gb.group_buy as unknown as { id: number };
      return { id: view.id, initiator };
    };

    // ① 他人已支付（PAID）→ 取消被拒 409 HAS_JOINED（扩展判定：锁态 PENDING_PAYMENT 不再充分）
    const gb1 = await publishGb();
    const joiner1 = nextUser();
    await seedUser(joiner1);
    const j1 = await enroll('groupbuy', gb1.id, joiner1);
    await paySuccess(j1.payment_order.id);
    await tick();
    await expect(groupBuys.cancel(gb1.id, gb1.initiator)).rejects.toMatchObject({
      code: ErrorCode.HasJoined,
      httpStatus: 409,
    });

    // ② 仅 PENDING 加入者（未支付）→ 可取消；GroupBuyExpired 出箱 → 扫场解冻（R-W3-O 扩展）
    const gb2 = await publishGb();
    const joiner2 = nextUser();
    await seedUser(joiner2);
    await points.grant({ user_id: joiner2, points: 800, kind: 'COMPENSATION', ref: 't7:cx' });
    const j2 = await enroll('groupbuy', gb2.id, joiner2, 300);
    expect(await getPointsBalance(pool, joiner2)).toBe(500); // 冻结 300
    await groupBuys.cancel(gb2.id, gb2.initiator); // 取消成功（PENDING 不拦）
    await tick(); // GroupBuyExpired → 扫场解冻
    expect((await outboxOf(GROUP_BUY_EXPIRED_TOPIC)).length).toBeGreaterThanOrEqual(1);
    expect(await getPointsBalance(pool, joiner2)).toBe(800); // 解冻原额回摆
    const row2 = await enrollmentOf(j2.enrollment_id);
    expect(row2['pay_status']).toBe('PENDING'); // R-W3-O：保持 PENDING（晚到回调走退款分支）
  });

  it('I-1 登记项兑现（M2-W3 T5）：LAWYER_REJECTED（载荷 group_id）→ 该团 PENDING 冻结积分 sweep 解冻（UNFREEZE 台账恰一）+他人团/他 session 不受扰+重放幂等（unfreeze 台账判重短路）', async () => {
    const lawyer = nextLawyer();
    await seedPricing(lawyer, { session_total: '100.00', accept_min: 2, accept_max: 3 });
    // G1 同 topic 扇出前提：credit.rules 生效版本（lawyer_reject_timeout -5 档——缺规则 G1
    // handler 抛错会把整事件打入重试轨道，本面 sweep 随扇出序受害）
    const rules = app.get(RuleCenterService);
    await poolSvc.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: {
          violation: {
            window_days: 30,
            threshold: 2,
            restriction_by_owner: {
              user: { kind: 'BAN_JOIN', days: 7 },
              lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
            },
          },
          actions: { lawyer_reject_timeout: { delta: -5 } },
        },
        effectiveAt: new Date(Date.now() - HOUR),
      }),
    );
    const publishGb = async (): Promise<{ id: number }> => {
      const initiator = nextUser();
      await seedUser(initiator);
      const gb = await groupBuys.create({
        initiator_id: initiator,
        lawyer_id: lawyer,
        specialty: 'labor_arbitration',
        slot_start: new Date(Date.now() + 25 * HOUR),
        sub_min: 2,
        sub_max: 3,
        question_tags: ['劳动仲裁时效'],
      });
      return { id: (gb.group_buy as unknown as { id: number }).id };
    };
    const userWithPoints = async (ref: string): Promise<number> => {
      const u = nextUser();
      await seedUser(u);
      await points.grant({ user_id: u, points: 1_000, kind: 'COMPENSATION', ref });
      return u;
    };
    const injectRejected = async (groupId: number): Promise<void> => {
      await pool.query(
        `INSERT INTO platform.outbox (event_id, topic, payload, status)
         VALUES (gen_random_uuid(), $1, $2::jsonb, 'PENDING')`,
        [
          LAWYER_REJECTED_TOPIC,
          JSON.stringify({ group_id: groupId, lawyer_id: lawyer, via_timeout: false }),
        ],
      );
    };

    // 布局：目标团 PENDING 冻结 300 + 他人团 PENDING 冻结 200 + 他 session PENDING 冻结 100
    const gbTarget = await publishGb();
    const targetUser = await userWithPoints('t5:lr-a');
    const targetEnroll = await enroll('groupbuy', gbTarget.id, targetUser, 300);
    expect(await getPointsBalance(pool, targetUser)).toBe(700); // 冻结 300
    const gbOther = await publishGb();
    const otherGbUser = await userWithPoints('t5:lr-b');
    await enroll('groupbuy', gbOther.id, otherGbUser, 200);
    const sessOther = await createSession(lawyer, { capacity: 4, unit_price: '30.00' });
    const otherSessUser = await userWithPoints('t5:lr-c');
    await enroll('session', sessOther.id, otherSessUser, 100);

    // 拒绝事件（C4 显式拒形态；载荷键=group_id 非 id）→ relay 投递 → sweep 消费
    await injectRejected(gbTarget.id);
    await drainRelay();

    // 该团 PENDING：冻结积分解冻回摆（UNFREEZE 台账恰一）+ pay_status 保持 PENDING（三态词汇无「钱没收」终态）
    expect(await getPointsBalance(pool, targetUser)).toBe(1_000);
    expect(await countPointsTxnsByKind(pool, targetUser, 'UNFREEZE')).toBe(1);
    expect((await enrollmentOf(targetEnroll.enrollment_id))['pay_status']).toBe('PENDING');

    // 他人团/他 session 的 PENDING 冻结不受扰
    expect(await getPointsBalance(pool, otherGbUser)).toBe(800); // 仍冻结 200
    expect(await getPointsBalance(pool, otherSessUser)).toBe(900); // 仍冻结 100

    // 重放幂等（at-least-once 重投）：报名行保持 PENDING 会被重选——逐行被 UNFREEZE 台账判重短路，余额不双计、台账不增行
    await injectRejected(gbTarget.id);
    await drainRelay();
    expect(await getPointsBalance(pool, targetUser)).toBe(1_000);
    expect(await countPointsTxnsByKind(pool, targetUser, 'UNFREEZE')).toBe(1);
  });

  // ===========================================================================
  // GET /enrollments/mine 数据面（§5：{status, amounts, refund_status}）
  // ===========================================================================

  it('mine：status/amounts 逐字段；refund_status 映射（NONE/PROCESSING/REFUNDED）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    await points.grant({ user_id: user, points: 1_000, kind: 'COMPENSATION', ref: 't7:mine' });
    const s1 = await createSession(lawyer, { capacity: 2 });
    const s2 = await createSession(lawyer, { capacity: 2 });
    const paid = await enroll('session', s1.id, user, 100);
    const pending = await enroll('session', s2.id, user, 0);

    let mine = await enrollments.listMine(user);
    expect(mine).toHaveLength(2);
    const pendingItem = mine.find((m) => m.enrollment_id === pending.enrollment_id)!;
    expect(pendingItem).toMatchObject({
      ref_type: 'session',
      status: 'PENDING',
      amounts: { paid: '50.00', cash: '50.00', points: 0 },
      refund_status: 'NONE',
    });
    const paidItem = mine.find((m) => m.enrollment_id === paid.enrollment_id)!;
    expect(paidItem.status).toBe('PENDING'); // 未回调前仍 PENDING

    await paySuccess(paid.payment_order.id);
    await tick();
    // 制造退款在途：直接受理一笔部分退款（F2 面）→ mine 显示 PROCESSING
    const refunds = app.get(RefundService);
    await refunds.accept({
      order_id: paid.payment_order.id,
      user_id: user,
      cash: '10.00',
      points: 0,
      reason: 'CANCEL_RULE',
      idempotency_key: 'refund/po-mine/partial',
    });
    mine = await enrollments.listMine(user);
    expect(mine.find((m) => m.enrollment_id === paid.enrollment_id)!.refund_status).toBe(
      'PROCESSING',
    );
    // 别人的报名不出现在 mine（user 维度过滤）：s1 满员前他人可报名，mine 仍只 2 条本人行
    const other = nextUser();
    await seedUser(other);
    await enroll('session', s1.id, other);
    mine = await enrollments.listMine(user);
    expect(mine).toHaveLength(2);
    expect(mine.every((m) => m.ref_id === s1.id || m.ref_id === s2.id)).toBe(true);
  });

  // ===========================================================================
  // user Token REST 面（鉴权形状；领域面已全覆盖——HTTP 契约只钉鉴权与出参包键）
  // ===========================================================================

  it('REST /enrollments/mine：user token 200；lawyer token 403；无 token 401（A1 守卫双向）', async () => {
    const user = nextUser();
    await seedUser(user);
    const userTok = await tokens.signAccessToken({ userId: user, role: 'user', roles: ['user'] });
    const lawyerTok = await tokens.signAccessToken({
      userId: nextLawyer(),
      role: 'lawyer',
      roles: ['lawyer'],
    });

    const ok = await request(app.getHttpServer())
      .get('/enrollments/mine')
      .set('Authorization', `Bearer ${userTok}`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);

    const forbidden = await request(app.getHttpServer())
      .get('/enrollments/mine')
      .set('Authorization', `Bearer ${lawyerTok}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe(ErrorCode.RoleForbidden);

    const anon = await request(app.getHttpServer()).get('/enrollments/mine');
    expect(anon.status).toBe(401);
  });

  it('REST POST /sessions/{id}/enroll：{enrollment, payment_order, pay_params} 出参 + 未实名 402 错误体', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedUser(user);
    const session = await createSession(lawyer);
    const userTok = await tokens.signAccessToken({ userId: user, role: 'user', roles: ['user'] });

    const ok = await request(app.getHttpServer())
      .post(`/sessions/${session.id}/enroll`)
      .set('Authorization', `Bearer ${userTok}`)
      .send({ points_to_use: 0 });
    expect(ok.status).toBe(201);
    expect(Object.keys(ok.body)).toEqual(['enrollment', 'payment_order', 'pay_params']);
    expect(ok.body.payment_order.cash_amount).toBe('50.00');
    expect(ok.body.enrollment.ref_type).toBe('session');

    const noRealname = nextUser();
    const tok2 = await tokens.signAccessToken({
      userId: noRealname,
      role: 'user',
      roles: ['user'],
    });
    const rejected = await request(app.getHttpServer())
      .post(`/sessions/${session.id}/enroll`)
      .set('Authorization', `Bearer ${tok2}`)
      .send({});
    expect(rejected.status).toBe(402);
    expect(rejected.body.code).toBe(ErrorCode.RealnameRequired);
  });
});
