import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import {
  ErrorCode,
  GROUP_BUY_CONVERTED_TOPIC,
  GROUP_BUY_LAWYER_CONFIRMED_TOPIC,
  LAWYER_REJECTED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { CreditRestrictionCache } from '../credit/credit.cache';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { creditEventRowsRaw, seedRestriction } from '../credit/credit-fixture';
import { RefundService } from '../payment/refund.service';
import { roomRowOfSessionRaw } from '../fulfillment/fulfillment-fixture';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { backdateJobDue } from '../schedule/job-fixture';
import { RuleCenterService } from '../ops/rule-center.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { SchedulerService } from '../schedule/scheduler.service';
import { SlotLockService } from '../schedule/slot-lock.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { SessionRefundSource } from './enrollment.refund-source';
import { seedPaidEnrollmentRaw } from './trade-fixture';
import { GroupBuyResponseService } from './group-buy-response.service';
import { GroupBuyService } from './group-buy.service';
import { SessionService } from './session.service';
import { EnrollmentService } from './enrollment.service';

/**
 * C4 领域层（需 PG；M2-W2 T4）：律师响应与双向转化。
 * 覆盖（C4 §7/§9/§10 + 执行计划 T4 验收）：
 *   - R-01 回归：12h 超时自动拒执行器（既有）+ G1 lawyer_reject_timeout -5 真消费（relay 链）；
 *     显式 reject 与超时同构（via_timeout=false 出箱、锁同事务释放）；
 *   - R-02 转化迁移：旧行 CONVERTED_OUT（ref_type/ref_id/快照列不动——§9 禁 UPDATE 迁移）+
 *     新行 prev 回链+快照复制；confirm 迁移同构（mode=C2B Session 生成）；
 *   - R-03 24h 退款窗：窗内 CONVERT_WINDOW 受理成功、25h 拒；退款完成收敛经迁移链重定向落新行；
 *   - R-04 rooms.session_id 统一指向：confirm 生成 Session → ROOM_OPEN 真链开房 session_id 对齐；
 *   - §8 迁移事务原子：enrollment 批量中段注入抛错 → Session/GroupBuy/enrollment 零残留；
 *   - §10①②③④逐条；幂等（confirm/reject/convert 重放）；守卫矩阵（NOT_REACHED/NOT_PENDING/
 *     NOT_CONVERTIBLE）；#36 停接拦 confirm；接单大厅；response-stats（STL 聚合口径）。
 * 驱动：调度器/relay 不自启动——手动 tick（scheduler priority/normal + relay.tick）。
 */

const HOUR = 3_600_000;
const LAWYER = 9101;
const LAWYER_OTHER = 9102;
const U1 = 6101;
const U2 = 6102;
const U3 = 6103;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** G1 规则种子（R-01 回归：lawyer_reject_timeout -5 档） */
const RULES_SEED: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    lawyer_reject_timeout: { delta: -5 },
  },
};

/** 迁移用六键快照（V26 头注⑦ 形状；share_price=分摊额=C2B 语义） */
const snapOf = (share: string) => ({
  price_mode: 'per_head',
  unit_price: share,
  share_price: share,
  session_total: share,
  price_version: 1,
  snapshot_at: new Date('2026-10-15T08:00:00.000Z').toISOString(),
});

interface EnrollmentRaw {
  id: number;
  ref_type: string;
  ref_id: number;
  user_id: number;
  pay_status: string;
  prev_enrollment_id: number | null;
  price_snapshot: Record<string, unknown>;
  cash_amount: string;
  points_amount: number;
}

describe('C4 律师响应与双向转化（confirm/reject/convert/24h 窗/response-stats，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let responses: GroupBuyResponseService;
  let groupBuys: GroupBuyService;
  let sessions: SessionService;
  let enrollments: EnrollmentService;
  let pricing: PricingConfigService;
  let rules: RuleCenterService;
  let scheduler: SchedulerService;
  let relay: OutboxRelayService;
  let locks: SlotLockService;
  let creditCache: CreditRestrictionCache;
  let poolSvc: PgPoolService;

  const hourAfter = (h: number): Date => new Date(Date.now() + h * HOUR);

  const seedPricing = (
    lawyerId: number,
    fields: {
      per_head?: string | null;
      session_total?: string | null;
      accept_min?: number | null;
      accept_max?: number | null;
    } = {},
  ): Promise<unknown> =>
    pricing.putPricing(lawyerId, {
      base_version: 0,
      per_head: fields.per_head ?? null,
      session_total: fields.session_total ?? '100.00',
      group_size: null,
      accept_min: fields.accept_min ?? null,
      accept_max: fields.accept_max ?? null,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });

  const createInput = (over: Record<string, unknown> = {}) =>
    ({
      initiator_id: U1,
      lawyer_id: LAWYER,
      specialty: 'labor_arbitration',
      slot_start: hourAfter(25),
      sub_min: 3,
      sub_max: 6,
      question_tags: ['劳动仲裁时效'],
      ...over,
    }) as Parameters<GroupBuyService['create']>[0];

  /** 建 PENDING 报名行+F1 真单（支付链快进 PAID）——晚到回调（C-1）与迁移源装配共用件；
   *  返回 {enrollId, orderId} */
  const seedPendingEnrollmentWithOrder = async (
    gbId: number,
    userId: number,
  ): Promise<{ enrollId: number; orderId: number }> => {
    const gateway = app.get(PaymentGatewayService);
    const enrollId = (
      await pool.query<{ id: string }>(
        `INSERT INTO trade.enrollments
           (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
            points_amount, price_version_id, pay_status, credit_used)
         VALUES ('groupbuy', $1, $2, $3::jsonb, '33.33', '33.33', '33.33', 0, 1, 'PENDING', 0)
         RETURNING id`,
        [gbId, userId, JSON.stringify(snapOf('33.33'))],
      )
    ).rows[0]!;
    const id = Number(enrollId.id);
    const out = await poolSvc.withTransaction((uow) =>
      gateway.createOrderInTx(uow, {
        biz_type: 'enroll',
        biz_id: id,
        cash_amount: '33.33',
        points_amount: 0,
        idempotency_key: `enroll/e${id}/pay`,
      }),
    );
    return { enrollId: id, orderId: out.payment_order.id };
  };

  /** 建拼团+三名已支付参与者（各配 F1 真单，幂等键=enroll/e{id}/pay）+达线推进 → PENDING_LAWYER。
   *  发起人支付单核销（PENDING_PAYMENT→LOCKED）——B2 R-03 滥用计数集只数 PENDING_PAYMENT，
   *  多任务同测试组装不撞「每用户同律师 ≤1」护栏（真实链=发起人支付核销，语义一致） */
  const pendingLawyerGroup = async (slotStart?: Date): Promise<number> => {
    const gateway = app.get(PaymentGatewayService);
    const result = await groupBuys.create(createInput(slotStart ? { slot_start: slotStart } : {}));
    const gbId = result.group_buy.id;
    await poolSvc.withTransaction((uow) => locks.confirmPayment(uow, result.payment_order.id));
    for (const uid of [U1, U2, U3]) {
      const enrollId = await seedPaidEnrollmentRaw(pool, 'groupbuy', gbId, {
        userId: uid,
        cash: '33.33',
        points: 0,
        unitPrice: '33.33',
        snapshot: snapOf('33.33'),
      });
      await poolSvc.withTransaction((uow) =>
        gateway.createOrderInTx(uow, {
          biz_type: 'enroll',
          biz_id: enrollId,
          cash_amount: '33.33',
          points_amount: 0,
          idempotency_key: `enroll/e${enrollId}/pay`,
        }),
      );
      // 支付链快进到 PAID（markFrozen→markPaid）：R-03 退款窗与退款源需要「已支付」原单
      const order = (await gateway.findOrderByIdempotencyKey(`enroll/e${enrollId}/pay`))!;
      await gateway.markFrozen(order.id, null);
      await gateway.markPaid(order.id);
    }
    await groupBuys.groupBuyReachedGuard(gbId, 3);
    return gbId;
  };

  const countOutbox = async (topic: string): Promise<number> => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [topic],
    );
    return res.rows[0]!.n;
  };

  const outboxPayload = async (topic: string): Promise<Record<string, unknown>> => {
    // 序列 id 定序（event_id=随机 UUID，ORDER BY event_id 非确定——同 topic 多事件时取最新）
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id DESC LIMIT 1`,
      [topic],
    );
    return res.rows[0]!.payload;
  };

  const groupBuyStatus = async (gbId: number): Promise<string> => {
    const res = await pool.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    return res.rows[0]!.status;
  };

  const sessionRow = async (sessionId: number) => {
    const res = await pool.query<{
      mode: string;
      status: string;
      price_mode: string;
      capacity: number;
      joined: number;
      unit_price: string;
      session_total: string;
      slot_start: Date;
      specialty: string;
      city: string;
      enroll_deadline: Date;
    }>(
      `SELECT mode, status, price_mode, capacity, joined, unit_price::text AS unit_price,
              session_total::text AS session_total, slot_start, specialty, city, enroll_deadline
         FROM trade.sessions WHERE id = $1`,
      [sessionId],
    );
    return res.rows[0];
  };

  const enrollmentRows = async (
    where: string,
    params: unknown[] = [],
  ): Promise<EnrollmentRaw[]> => {
    const res = await pool.query(
      `SELECT id::int AS id, ref_type, ref_id::int AS ref_id, user_id::int AS user_id,
              pay_status, prev_enrollment_id::int AS prev_enrollment_id, price_snapshot,
              cash_amount::text AS cash_amount, points_amount
         FROM trade.enrollments ${where} ORDER BY id`,
      params,
    );
    return res.rows as unknown as EnrollmentRaw[];
  };

  const seedRules = (): Promise<unknown> =>
    poolSvc.withTransaction((uow: SqlExecutor) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: RULES_SEED,
        effectiveAt: new Date(Date.now() - 10 * HOUR),
      }),
    );

  /** #36 用：律师停接限制令（credit-fixture 域主夹具）+ 缓存失效 */
  const suspendTake = async (lawyerId: number, kind = 'SUSPEND_TAKE_7D'): Promise<void> => {
    await seedRestriction(pool, 'lawyer', lawyerId, kind, 7);
    creditCache.invalidateOwner({ ownerType: 'lawyer', ownerId: lawyerId });
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    // FulfillmentModule（内含 TradeModule）：ROOM_OPEN 执行器装配=R-04 rooms 真链锚
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app)); // FulfillmentModule 携 D5 WSS 网关（attendance.spec 同款）
    await app.init();
    responses = app.get(GroupBuyResponseService);
    groupBuys = app.get(GroupBuyService);
    sessions = app.get(SessionService);
    enrollments = app.get(EnrollmentService);
    pricing = app.get(PricingConfigService);
    rules = app.get(RuleCenterService);
    scheduler = app.get(SchedulerService);
    relay = app.get(OutboxRelayService);
    locks = app.get(SlotLockService);
    creditCache = app.get(CreditRestrictionCache);
    poolSvc = app.get(PgPoolService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    creditCache.invalidateOwner({ ownerType: 'lawyer', ownerId: LAWYER });
    creditCache.invalidateOwner({ ownerType: 'lawyer', ownerId: LAWYER_OTHER });
    await seedPricing(LAWYER, { accept_min: 2, accept_max: 8 });
    await seedPricing(LAWYER_OTHER, { accept_min: 2, accept_max: 8 });
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ===========================================================================
  // confirm（§5/§10/R-04/R-02 迁移）
  // ===========================================================================

  it('confirm 主链：PENDING_LAWYER→CONFIRMED+mode=C2B Session（capacity=joined=参与者数、快照价/时段迁移）+参与者新行迁移（旧行 CONVERTED_OUT+新行 prev 回链+快照复制）+LawyerConfirmed 出箱+job 预写，全同事务', async () => {
    const slotStart = hourAfter(25);
    const gbId = await pendingLawyerGroup(slotStart);
    const oldRows = await enrollmentRows(`WHERE ref_type = 'groupbuy' AND ref_id = $1`, [gbId]);
    expect(oldRows).toHaveLength(3);

    const out = await responses.confirm(gbId, LAWYER);
    expect(out.session_id).toBeGreaterThan(0);

    // GroupBuy 推进（守卫+STL）
    expect(await groupBuyStatus(gbId)).toBe('CONFIRMED');
    const stl = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'group_buy' AND entity_id = $1 AND to_status = 'CONFIRMED' AND allowed`,
      [gbId],
    );
    expect(stl.rows[0]!.n).toBe(1);

    // Session：mode=C2B、满员闭环（capacity=joined=3=FULL）、价格=share 快照×capacity、时段迁移
    const s = await sessionRow(out.session_id);
    expect(s!.mode).toBe('C2B');
    expect(s!.status).toBe('FULL'); // markFull 同事务（成团链）
    expect(s!.capacity).toBe(3);
    expect(s!.joined).toBe(3);
    expect(s!.unit_price).toBe('33.33');
    expect(s!.session_total).toBe('99.99');
    expect(new Date(s!.slot_start).getTime()).toBe(slotStart.getTime());

    // R-02 迁移（§9 禁 UPDATE：旧行仅 pay_status 翻转，业务列原样）
    const after = await enrollmentRows(`WHERE ref_type = 'groupbuy' AND ref_id = $1`, [gbId]);
    for (const row of after) {
      expect(row.pay_status).toBe('CONVERTED_OUT');
      const before = oldRows.find((o) => o.id === row.id)!;
      expect(row.ref_type).toBe('groupbuy'); // 业务列不迁移（新行承载）
      expect(row.ref_id).toBe(gbId);
      expect(row.price_snapshot).toEqual(before.price_snapshot);
      expect(row.cash_amount).toBe('33.33');
    }
    // 新行：session 型+PAID 出生态+prev 回链+快照逐字复制
    const migrated = await enrollmentRows(`WHERE ref_type = 'session' AND ref_id = $1`, [
      out.session_id,
    ]);
    expect(migrated).toHaveLength(3);
    for (const row of migrated) {
      expect(row.pay_status).toBe('PAID');
      const prev = after.find((o) => o.id === row.prev_enrollment_id)!;
      expect(prev).toBeDefined();
      expect(prev.pay_status).toBe('CONVERTED_OUT');
      expect(row.user_id).toBe(prev.user_id);
      expect(row.price_snapshot).toEqual(prev.price_snapshot); // R-02 快照价维持
      expect(row.cash_amount).toBe(prev.cash_amount);
      expect(row.points_amount).toBe(prev.points_amount);
    }
    // enrollment 迁移 STL 留痕（PAID→CONVERTED_OUT ×3）
    const stlEnroll = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'enrollment' AND to_status = 'CONVERTED_OUT' AND allowed`,
    );
    expect(stlEnroll.rows[0]!.n).toBe(3);

    // LawyerConfirmed 出箱（附录 A.1 冻结形状）
    expect(await countOutbox(GROUP_BUY_LAWYER_CONFIRMED_TOPIC)).toBe(1);
    expect(await outboxPayload(GROUP_BUY_LAWYER_CONFIRMED_TOPIC)).toEqual({
      gb_id: gbId,
      session_id: out.session_id,
      lawyer_id: LAWYER,
    });

    // job 预写同款（REMIND×4+ENROLL_DEADLINE+ROOM_OPEN，refType=session 锚=R-04 半边）
    const jobRows = await scheduler.listJobs({ limit: 500 });
    const sessionJobs = jobRows
      .filter((j) => j.refType === 'session' && j.refId === out.session_id)
      .map((j) => j.jobType);
    expect(sessionJobs.sort()).toEqual(
      [
        'ENROLL_DEADLINE',
        'REMIND_24H',
        'REMIND_1H',
        'REMIND_10MIN',
        'REMIND_1MIN',
        'ROOM_OPEN',
      ].sort(),
    );

    // D2 提醒锚（listPaidEnrollmentUsers）：迁移行 PAID → 提醒分发可达（R-04 参与半边）
    const remindTargets = await enrollments.listPaidEnrollmentUsers(poolSvc, out.session_id);
    expect(remindTargets.map((t) => t.user_id).sort()).toEqual([U1, U2, U3]);

    // 幂等重放（幂等键=gb）：目标态短路，同 session_id、不二次出箱
    const replay = await responses.confirm(gbId, LAWYER);
    expect(replay.session_id).toBe(out.session_id);
    expect(await countOutbox(GROUP_BUY_LAWYER_CONFIRMED_TOPIC)).toBe(1);
  });

  it('confirm 守卫矩阵：非 PENDING_LAWYER → 409 E_NOT_REACHED；非本人/不存在 → 404', async () => {
    const gb = await groupBuys.create(createInput({ initiator_id: U2 })); // PUBLISHED（未达线）
    await expect(responses.confirm(gb.group_buy.id, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.NotReached,
      httpStatus: 409,
    });
    const gbId = await pendingLawyerGroup();
    await expect(responses.confirm(gbId, LAWYER_OTHER)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
      httpStatus: 404,
    });
    await expect(responses.confirm(999999, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
      httpStatus: 404,
    });
  });

  it('#36 停接拦截（⚠W2-5=拦 confirm 时点）：SUSPEND_TAKE_7D 生效 → 403 E_RESTRICTED、状态不动、零 Session', async () => {
    const gbId = await pendingLawyerGroup();
    await suspendTake(LAWYER);
    await expect(responses.confirm(gbId, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.Restricted,
      httpStatus: 403,
    });
    expect(await groupBuyStatus(gbId)).toBe('PENDING_LAWYER');
    const s = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trade.sessions`);
    expect(s.rows[0]!.n).toBe(0);
    // convert/reject 不拦（W2-5 维持现状——停接只拦 confirm）
    const converted = await responses.convert(gbId, LAWYER);
    expect(converted.session_id).toBeGreaterThan(0);
  });

  // ===========================================================================
  // R-04 rooms.session_id 统一指向（mode=C2B 也一样）
  // ===========================================================================

  it('R-04：confirm 生成 Session → ROOM_OPEN 真链开房，rooms.session_id 统一指向该 Session', async () => {
    const gbId = await pendingLawyerGroup();
    const { session_id: sessionId } = await responses.confirm(gbId, LAWYER);
    await backdateJobDue(pool, 'ROOM_OPEN', 'session', sessionId);
    const ticked = await scheduler.tick('priority');
    expect(ticked.done).toBe(1);
    // fulfillment 域主夹具（查询按 session_id 过滤——返回即「房间挂在该履约 Session 上」）
    const room = await roomRowOfSessionRaw(pool, sessionId);
    expect(room.id).toBeGreaterThan(0);
  });

  // ===========================================================================
  // reject（§5/R-01 显式分支+G1 消费回归）
  // ===========================================================================

  it('reject 主链：PENDING_LAWYER→REJECTED+LawyerRejected(via_timeout=false) 出箱+锁同事务释放+幂等重放 {status}；非 PENDING_LAWYER → 409 E_NOT_PENDING', async () => {
    const gbId = await pendingLawyerGroup();
    const out = await responses.reject(gbId, LAWYER, '档期冲突');
    expect(out).toEqual({ status: 'REJECTED' });
    expect(await groupBuyStatus(gbId)).toBe('REJECTED');
    expect(await outboxPayload(LAWYER_REJECTED_TOPIC)).toEqual({
      group_id: gbId,
      lawyer_id: LAWYER,
      via_timeout: false, // 显式拒判别字段（超时路径=既有 via_timeout:true）
    });
    // 锁同事务释放探针（confirmTimeout 用例同款）：再释放 → ALREADY_RELEASED
    const release = await poolSvc.withTransaction((uow) =>
      locks.releaseSlot(uow, { refType: 'groupbuy', refId: gbId, reason: 'probe' }),
    );
    expect(release).toEqual({ ok: false, reason: 'ALREADY_RELEASED' });
    // 幂等重放
    expect(await responses.reject(gbId, LAWYER)).toEqual({ status: 'REJECTED' });
    expect(await countOutbox(LAWYER_REJECTED_TOPIC)).toBe(1);
    // 守卫：PUBLISHED 上拒 → 409 E_NOT_PENDING
    const gb = await groupBuys.create(createInput());
    await expect(responses.reject(gb.group_buy.id, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.NotPending,
      httpStatus: 409,
    });
  });

  it('R-01 回归：12h 超时自动拒（既有执行器）via_timeout=true 出箱 + G1 真消费 lawyer_reject_timeout -5（relay 链）', async () => {
    await seedRules();
    const gbId = await pendingLawyerGroup();
    await backdateJobDue(pool, 'C2B_CONFIRM_TIMEOUT', 'groupbuy', gbId);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBe(1);
    expect(await groupBuyStatus(gbId)).toBe('REJECTED');
    expect(await outboxPayload(LAWYER_REJECTED_TOPIC)).toMatchObject({
      group_id: gbId,
      lawyer_id: LAWYER,
      via_timeout: true,
    });
    // G1 消费面真链（credit.consumer 注册于 relay；规则种子 -5 档；直读走 credit 域主夹具）
    await relay.tick();
    const events = await creditEventRowsRaw(pool, 'lawyer', LAWYER);
    const mine = events.find((e) => Number(e.ref_id) === gbId);
    expect(mine).toMatchObject({ delta: -5, action: 'lawyer_reject_timeout' });
  });

  // ===========================================================================
  // convert（§5/R-02/§10②）
  // ===========================================================================

  it('convert 主链（R-02）：PENDING_LAWYER→CONVERTED+新 B2C Session（capacity 默认 sub_max/价格=B3 现值/B3C 价待新加入）+旧行 CONVERTED_OUT+新行 prev 回链+快照复制+GroupBuyConverted 出箱+锁承接+groupbuy 锚 job 作废', async () => {
    const slotStart = hourAfter(25);
    const gbId = await pendingLawyerGroup(slotStart);
    const oldRows = await enrollmentRows(`WHERE ref_type = 'groupbuy' AND ref_id = $1`, [gbId]);

    const out = await responses.convert(gbId, LAWYER);
    expect(out.session_id).toBeGreaterThan(0);
    expect(await groupBuyStatus(gbId)).toBe('CONVERTED');

    // 新 B2C 场次：capacity 默认=sub_max(6)、joined=迁移 3（开放 3 席按 B2C 价）、双维物化带出
    const s = await sessionRow(out.session_id);
    expect(s!.mode).toBe('B2C');
    expect(s!.status).toBe('CREATED');
    expect(s!.capacity).toBe(6);
    expect(s!.joined).toBe(3);
    expect(s!.specialty).toBe('labor_arbitration');
    // B3 现值解算：per_head 缺省 null → session_total '100.00' 模式（分摊半分向上 10000/6）
    expect(s!.price_mode).toBe('session_total');
    expect(s!.session_total).toBe('100.00');
    expect(s!.unit_price).toBe('16.67');
    const detail = await sessions.getDetail(out.session_id);
    expect(detail.remaining).toBe(3); // 新加入开放面

    // R-02 迁移：旧行 CONVERTED_OUT（业务列不动）+新行 prev 回链+快照价维持
    const after = await enrollmentRows(`WHERE ref_type = 'groupbuy' AND ref_id = $1`, [gbId]);
    expect(after.every((r) => r.pay_status === 'CONVERTED_OUT')).toBe(true);
    for (const row of after) {
      expect(row.price_snapshot).toEqual(oldRows.find((o) => o.id === row.id)!.price_snapshot);
    }
    const migrated = await enrollmentRows(`WHERE ref_type = 'session' AND ref_id = $1`, [
      out.session_id,
    ]);
    expect(migrated).toHaveLength(3);
    for (const row of migrated) {
      const prev = after.find((o) => o.id === row.prev_enrollment_id)!;
      expect(row.price_snapshot).toEqual(prev.price_snapshot); // 参与者维持快照价（R-02 前半）
      expect(row.pay_status).toBe('PAID');
    }

    // GroupBuyConverted 出箱（附录 A.1 冻结形状：migrated_users=user_id 数组）
    expect(await countOutbox(GROUP_BUY_CONVERTED_TOPIC)).toBe(1);
    expect(await outboxPayload(GROUP_BUY_CONVERTED_TOPIC)).toEqual({
      gb_id: gbId,
      session_id: out.session_id,
      capacity: 6,
      migrated_users: [U1, U2, U3],
    });

    // 锁承接：groupbuy 锁出、session 锁接管（同段唯一防线连续）
    const gbRelease = await poolSvc.withTransaction((uow) =>
      locks.releaseSlot(uow, { refType: 'groupbuy', refId: gbId, reason: 'probe' }),
    );
    expect(gbRelease).toEqual({ ok: false, reason: 'ALREADY_RELEASED' });
    const sessionLock = await poolSvc.withTransaction((uow) =>
      locks.activeStatusOf(uow, 'session', out.session_id),
    );
    expect(sessionLock).toBe('LOCKED');

    // groupbuy 锚未发 job 作废（幽灵执行禁令；读经 schedule 服务查询面）
    const gbJobs = await scheduler.listJobs({ limit: 500 });
    const byType = new Map(
      gbJobs
        .filter((j) => j.refType === 'groupbuy' && j.refId === gbId)
        .map((j) => [j.jobType, j.status]),
    );
    expect(byType.get('C2B_CONFIRM_TIMEOUT')).toBe('CANCELLED');
    expect(byType.get('ENROLL_DEADLINE')).toBe('CANCELLED');

    // 幂等重放（幂等键=gb）
    const replay = await responses.convert(gbId, LAWYER);
    expect(replay.session_id).toBe(out.session_id);
    expect(await countOutbox(GROUP_BUY_CONVERTED_TOPIC)).toBe(1);
  });

  it('convert 入参变体：显式 price 覆盖=per_head；capacity 显式；PUBLISHED 认领（零参与迁移 migrated_users=[]）；容量低于参与者 → 400', async () => {
    const gbId = await pendingLawyerGroup();
    // 显式 price=per_head 覆盖 + capacity=10
    const a = await responses.convert(gbId, LAWYER, { capacity: 10, price: '120.00' });
    const sa = await sessionRow(a.session_id);
    expect(sa!.price_mode).toBe('per_head');
    expect(sa!.unit_price).toBe('120.00');
    expect(sa!.session_total).toBe('1200.00'); // 120.00×10 整数分
    expect(sa!.capacity).toBe(10);

    // PUBLISHED 认领（零支付参与者）：直接从发布态转化，migrated_users=[]
    const gb2 = await groupBuys.create(
      createInput({ slot_start: hourAfter(26), initiator_id: U2 }),
    );
    const b = await responses.convert(gb2.group_buy.id, LAWYER);
    const sb = await sessionRow(b.session_id);
    expect(sb!.mode).toBe('B2C');
    expect(sb!.joined).toBe(0);
    expect(await outboxPayload(GROUP_BUY_CONVERTED_TOPIC)).toMatchObject({
      gb_id: gb2.group_buy.id,
      migrated_users: [],
    });

    // 容量 < 已支付参与者 → 400（被迁移者不可丢弃）
    const gbId3 = await pendingLawyerGroup(hourAfter(27));
    await expect(responses.convert(gbId3, LAWYER, { capacity: 2 })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
  });

  it('convert 守卫：CONFIRMED/REJECTED → 409 E_NOT_CONVERTIBLE（CONFIRMED 后转化语义未定义=不收）', async () => {
    const gbId = await pendingLawyerGroup();
    await responses.confirm(gbId, LAWYER);
    await expect(responses.convert(gbId, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.NotConvertible,
      httpStatus: 409,
    });
    const gbId3 = await pendingLawyerGroup(hourAfter(27));
    await responses.reject(gbId3, LAWYER);
    await expect(responses.convert(gbId3, LAWYER)).rejects.toMatchObject({
      code: ErrorCode.NotConvertible,
      httpStatus: 409,
    });
  });

  // ===========================================================================
  // §8 迁移事务原子（中段失败全回滚——注入）
  // ===========================================================================

  it('§8 原子性注入：enrollment 批量迁移中段抛错（session 型 INSERT 触发器）→ Session/GroupBuy/enrollment 全回滚零残留', async () => {
    const gbId = await pendingLawyerGroup();
    // 注入：session 型报名 INSERT 抛错（首行迁移成功、后续行中段失败）
    await pool.query(`
      CREATE FUNCTION trade.tmp_block_migrate() RETURNS trigger AS $$
      BEGIN
        IF NEW.ref_type = 'session' AND NEW.prev_enrollment_id IS NOT NULL THEN
          RAISE EXCEPTION 'injected mid-migration failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query(
      `CREATE TRIGGER tmp_block_migrate_trg BEFORE INSERT ON trade.enrollments
        FOR EACH ROW EXECUTE FUNCTION trade.tmp_block_migrate()`,
    );
    try {
      await expect(responses.confirm(gbId, LAWYER)).rejects.toThrow(/injected mid-migration/);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS tmp_block_migrate_trg ON trade.enrollments`);
      await pool.query(`DROP FUNCTION IF EXISTS trade.tmp_block_migrate()`);
    }
    // 全回滚断言：GroupBuy 未推进/零 Session/报名零迁移零残留/零出箱/零 session 锚 job
    expect(await groupBuyStatus(gbId)).toBe('PENDING_LAWYER');
    const s = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trade.sessions`);
    expect(s.rows[0]!.n).toBe(0);
    const rows = await enrollmentRows(`WHERE ref_type = 'groupbuy' AND ref_id = $1`, [gbId]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.pay_status === 'PAID')).toBe(true); // 旧行未被标记
    expect((await enrollmentRows(`WHERE ref_type = 'session'`)).length).toBe(0);
    expect(await countOutbox(GROUP_BUY_LAWYER_CONFIRMED_TOPIC)).toBe(0);
    const allJobs = await scheduler.listJobs({ limit: 500 });
    expect(allJobs.filter((j) => j.refType === 'session')).toHaveLength(0);
    // 注入清除后重试成功（回滚未毒化幂等面）
    const ok = await responses.confirm(gbId, LAWYER);
    expect(ok.session_id).toBeGreaterThan(0);
  });

  // ===========================================================================
  // 修复环（M2-W2 T4 评审 Needs fixes）
  // ===========================================================================

  it('修复环 C-1：confirm 后晚到的 PENDING 加入者支付回调 → 自动退款分支（REFUNDED+F2 受理）+零 session 席位行（无孤儿已付款行）', async () => {
    const gateway = app.get(PaymentGatewayService);
    const gbId = await pendingLawyerGroup();
    // 第 4 名：PENDING_LAWYER 前已报名（PENDING）未支付，确认后支付成功回调到达
    const late = await seedPendingEnrollmentWithOrder(gbId, 6104);
    await gateway.markFrozen(late.orderId, null); // 回调链先冻结（createEnrollPayCallbackHandler 同序）

    const { session_id: sessionId } = await responses.confirm(gbId, LAWYER);
    // CHAIN 移除 CONFIRMED 后：晚到回调 → {processed:false, refund:true}（不放行 PENDING→PAID）
    const outcome = await enrollments.onPaySuccess(late.enrollId, late.orderId);
    expect(outcome).toEqual({ processed: false, refund: true, enrollment_id: late.enrollId });
    // 自动退款分支：REFUNDED + F2 受理（GROUP_FAIL 全额）——无「已付款无座位」孤儿行
    await enrollments.refundIfRejected(late.enrollId, late.orderId);
    expect((await enrollmentRows(`WHERE id = $1`, [late.enrollId]))[0]!.pay_status).toBe(
      'REFUNDED',
    );
    const refunds = app.get(RefundService);
    const refundRows = await refunds.listByOrderId(late.orderId);
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({ reason: 'GROUP_FAIL', cash_amount: '33.33' });
    // 零 session 席位行：晚到者不在迁移集合（capacity=joined=3 满员无座）
    const migrated = await enrollmentRows(`WHERE ref_type = 'session' AND ref_id = $1`, [
      sessionId,
    ]);
    expect(migrated).toHaveLength(3);
    expect(migrated.every((r) => r.user_id !== 6104)).toBe(true);
    const s = await sessionRow(sessionId);
    expect(s!.joined).toBe(3);
  });

  it('修复环 C-2：session_id 回链列落值（confirm/convert 同事务）+幂等重放直查列——零参与 convert 重放返回 session_id（非 500）+3 参与者重放回归', async () => {
    // 零参与转化（PUBLISHED 认领）：重放不再依赖迁移链（链上无行——修复前 500）
    const gb0 = await groupBuys.create(
      createInput({ slot_start: hourAfter(40), initiator_id: U2 }),
    );
    const first0 = await responses.convert(gb0.group_buy.id, LAWYER);
    expect(first0.session_id).toBeGreaterThan(0);
    const replay0 = await responses.convert(gb0.group_buy.id, LAWYER);
    expect(replay0.session_id).toBe(first0.session_id);

    // 3 参与者：confirm 落值列 + 重放同值
    const gbId = await pendingLawyerGroup(hourAfter(41));
    const out = await responses.confirm(gbId, LAWYER);
    const colConfirm = await pool.query<{ session_id: string | null }>(
      `SELECT session_id::text AS session_id FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    expect(Number(colConfirm.rows[0]!.session_id)).toBe(out.session_id);
    expect((await responses.confirm(gbId, LAWYER)).session_id).toBe(out.session_id);

    // 3 参与者：convert 落值列 + 重放同值
    const gb2 = await pendingLawyerGroup(hourAfter(42));
    const out2 = await responses.convert(gb2, LAWYER);
    const colConvert = await pool.query<{ session_id: string | null }>(
      `SELECT session_id::text AS session_id FROM trade.group_buys WHERE id = $1`,
      [gb2],
    );
    expect(Number(colConvert.rows[0]!.session_id)).toBe(out2.session_id);
    expect((await responses.convert(gb2, LAWYER)).session_id).toBe(out2.session_id);
  });

  it('修复环 I-1：达线后退款缩员至 [2,sub_min) 属合法形态——sub_min=3 退 1 人后 confirm 成功（capacity=2）', async () => {
    const gbId = await pendingLawyerGroup();
    // 达线事实已发生（PENDING_LAWYER 在册）——一名参与者退款完成（PAID→REFUNDED，服务面）
    const rows = await enrollmentRows(
      `WHERE ref_type = 'groupbuy' AND ref_id = $1 AND pay_status = 'PAID'`,
      [gbId],
    );
    expect(rows).toHaveLength(3);
    await enrollments.advanceToRefunded(rows[0]!.id, 'test:shrink_after_reach');
    // 缩员后 confirm：参与者 2 人（≥契约下界 2）成功——场次按实际 2 人闭环
    const out = await responses.confirm(gbId, LAWYER);
    const s = await sessionRow(out.session_id);
    expect(s!.capacity).toBe(2);
    expect(s!.joined).toBe(2);
    const migrated = await enrollmentRows(`WHERE ref_type = 'session' AND ref_id = $1`, [
      out.session_id,
    ]);
    expect(migrated).toHaveLength(2);
    expect(migrated.every((r) => r.id !== rows[0]!.id)).toBe(true); // 退款者不迁移
  });

  // ===========================================================================
  // R-03 24h 转化退款窗
  // ===========================================================================

  it('R-03：被迁移用户 24h 窗内 CONVERT_WINDOW 全额退款受理成功；25h 被拒；退款完成收敛经迁移链重定向落新行 PAID→REFUNDED', async () => {
    const gbId = await pendingLawyerGroup();
    const { session_id: sessionId } = await responses.convert(gbId, LAWYER);
    const migrated = await enrollmentRows(`WHERE ref_type = 'session' AND ref_id = $1`, [
      sessionId,
    ]);
    const first = migrated[0]!;
    const second = migrated[1]!;

    // 24h 窗内（迁移即刻）：受理成功（reason=CONVERT_WINDOW、全额、原单定位；读经 F2 导出面）
    const out = await responses.requestConvertRefund(first.id, first.user_id);
    expect(out.refund_id).toBeGreaterThan(0);
    const refunds = app.get(RefundService);
    const mine = (await refunds.listMine(first.user_id)).find((r) => r.refund_id === out.refund_id);
    expect(mine).toMatchObject({
      reason: 'CONVERT_WINDOW',
      cash_amount: '33.33',
      points_amount: 0,
    });

    // 非迁移行/非本人/状态不符守卫（plain 行用未迁移用户 6104——ux_enroll_active 活跃唯一不撞）
    const plain = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 6104,
      cash: '10.00',
      points: 0,
      unitPrice: '10.00',
      snapshot: snapOf('10.00'),
    });
    await expect(responses.requestConvertRefund(plain, 6104)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    await expect(responses.requestConvertRefund(second.id, U1)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
      httpStatus: 404,
    });

    // 25h：回拨迁移行 created_at 超窗 → 拒
    await pool.query(
      `UPDATE trade.enrollments SET created_at = now() - interval '25 hours' WHERE id = $1`,
      [second.id],
    );
    await expect(responses.requestConvertRefund(second.id, second.user_id)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    // 23h59m：窗内边界（另一行回拨 23h59m 仍可受理）
    const third = migrated[2]!;
    await pool.query(
      `UPDATE trade.enrollments SET created_at = now() - interval '23 hours 59 minutes' WHERE id = $1`,
      [third.id],
    );
    const inWindow = await responses.requestConvertRefund(third.id, third.user_id);
    expect(inWindow.refund_id).toBeGreaterThan(0);

    // 退款完成收敛（RefundCompleted 消费等价直调）：迁移链重定向——新行 PAID→REFUNDED、旧行保持 CONVERTED_OUT
    await enrollments.advanceToRefunded(first.prev_enrollment_id!, 'refund_completed:test');
    const afterMigrated = await enrollmentRows(`WHERE id = $1`, [first.id]);
    expect(afterMigrated[0]!.pay_status).toBe('REFUNDED');
    const afterOld = await enrollmentRows(`WHERE id = $1`, [first.prev_enrollment_id!]);
    expect(afterOld[0]!.pay_status).toBe('CONVERTED_OUT');
    // 幂等：二次收敛不抛不改态
    await enrollments.advanceToRefunded(first.prev_enrollment_id!, 'refund_completed:test');
    expect((await enrollmentRows(`WHERE id = $1`, [first.id]))[0]!.pay_status).toBe('REFUNDED');
  });

  it('R-W3-M 退款源迁移行回链：F2 批量退款源（session 键）对转化场次解析到原单付款人清单', async () => {
    const gbId = await pendingLawyerGroup(); // 参与者各配 F1 真单（enroll/e{id}/pay）
    const oldRows = await enrollmentRows(`WHERE ref_type = 'groupbuy' AND ref_id = $1`, [gbId]);
    const gateway = app.get(PaymentGatewayService);
    const orderIds: number[] = [];
    for (const row of oldRows) {
      const order = await gateway.findOrderByIdempotencyKey(`enroll/e${row.id}/pay`);
      expect(order).not.toBeNull();
      orderIds.push(order!.id);
    }
    const { session_id: sessionId } = await responses.convert(gbId, LAWYER);
    const source = app.get(SessionRefundSource);
    const orders = await source.listPaidPaymentOrders(sessionId);
    expect(orders).toHaveLength(3);
    expect(orders.map((o) => o.payment_order_id).sort()).toEqual([...orderIds].sort());
    expect(orders.every((o) => o.cash_amount === '33.33' && o.points_amount === 0)).toBe(true);
  });

  // ===========================================================================
  // 接单大厅 + response-stats
  // ===========================================================================

  it('接单大厅：仅本人 PENDING_LAWYER 任务（含子范围/标签/截止/joined=PAID 计数），排除他人与已推进态', async () => {
    const mine = await pendingLawyerGroup();
    const others = await groupBuys.create(
      createInput({ lawyer_id: LAWYER_OTHER, slot_start: hourAfter(30), initiator_id: U2 }),
    );
    await seedPaidEnrollmentRaw(pool, 'groupbuy', others.group_buy.id, {
      userId: U2,
      cash: '33.33',
      points: 0,
      unitPrice: '33.33',
      snapshot: snapOf('33.33'),
    });
    await seedPaidEnrollmentRaw(pool, 'groupbuy', others.group_buy.id, {
      userId: U3,
      cash: '33.33',
      points: 0,
      unitPrice: '33.33',
      snapshot: snapOf('33.33'),
    });
    await seedPaidEnrollmentRaw(pool, 'groupbuy', others.group_buy.id, {
      userId: U1,
      cash: '33.33',
      points: 0,
      unitPrice: '33.33',
      snapshot: snapOf('33.33'),
    });
    await groupBuys.groupBuyReachedGuard(others.group_buy.id, 3);
    await responses.confirm(others.group_buy.id, LAWYER_OTHER); // 他人已确认 → 不入本人大厅

    const list = await responses.listPendingForLawyer(LAWYER);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(mine);
    expect(list[0]!.status).toBe('PENDING_LAWYER');
    expect(list[0]!.sub_min).toBe(3);
    expect(list[0]!.sub_max).toBe(6);
    expect(list[0]!.question_tags).toEqual(['劳动仲裁时效']);
    expect(list[0]!.lawyer_confirm_by).not.toBeNull();
    expect(list[0]!.joined).toBe(3); // PAID 计数接线（T7 事实源）
    // 空面：其他律师视角
    expect(await responses.listPendingForLawyer(9999)).toEqual([]);
  });

  it('response-stats：CONFIRMED 迁移 STL 聚合（时长=CONFIRMED−PENDING_LAWYER），本人过滤+窗界+avg；无样本 null', async () => {
    // 用例 1：PENDING_LAWYER 起点回拨 2h → confirm 时长 ≈120min
    const gb1 = await pendingLawyerGroup();
    await pool.query(
      `UPDATE platform.state_transition_log SET created_at = now() - interval '2 hours'
        WHERE entity_type = 'group_buy' AND entity_id = $1 AND to_status = 'PENDING_LAWYER'`,
      [gb1],
    );
    await responses.confirm(gb1, LAWYER);
    // 用例 2：回拨 1h
    const gb2 = await pendingLawyerGroup(hourAfter(26 + 24)); // 错开 slot（B2 锁同段防撞）
    await pool.query(
      `UPDATE platform.state_transition_log SET created_at = now() - interval '1 hour'
        WHERE entity_type = 'group_buy' AND entity_id = $1 AND to_status = 'PENDING_LAWYER'`,
      [gb2],
    );
    await responses.confirm(gb2, LAWYER);

    // 上海日界窗口（+08:00）：today 取上海当日（UTC slice 在 UTC16 后会落到前一日——窗口错位）
    const today = new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10);
    const stats = await responses.responseStats(LAWYER, today, today);
    expect(stats.samples).toHaveLength(2);
    const sample1 = stats.samples.find((s) => s.gb_id === gb1)!;
    const sample2 = stats.samples.find((s) => s.gb_id === gb2)!;
    expect(sample1.confirm_minutes).toBeGreaterThanOrEqual(119.9);
    expect(sample1.confirm_minutes).toBeLessThanOrEqual(120.1);
    expect(sample2.confirm_minutes).toBeGreaterThanOrEqual(59.9);
    expect(sample2.confirm_minutes).toBeLessThanOrEqual(60.1);
    expect(stats.avg_confirm_minutes).toBeGreaterThanOrEqual(89.9);
    expect(stats.avg_confirm_minutes).toBeLessThanOrEqual(90.1);
    expect(sample1.confirmed_at).toBeTruthy();

    // 他人过滤 + 无样本 null
    expect((await responses.responseStats(LAWYER_OTHER, today, today)).samples).toEqual([]);
    expect(
      (await responses.responseStats(LAWYER_OTHER, today, today)).avg_confirm_minutes,
    ).toBeNull();
    // 区间倒置 400
    await expect(responses.responseStats(LAWYER, '2026-10-19', '2026-10-18')).rejects.toMatchObject(
      { code: ErrorCode.InvalidArgument, httpStatus: 400 },
    );
  });
});
