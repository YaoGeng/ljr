import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import {
  AppError,
  ErrorCode,
  ATTENDANCE_ADJUDICATED_TOPIC,
  ROOM_OPEN_FAILED_TOPIC,
  SESSION_CANCELLED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { RuleCenterService } from '../ops/rule-center.service';
import { TicketService } from '../ops/ticket.service';
import { forceResolveTicketRaw } from '../ops/ticket-fixture';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { listAllRefundsRaw, listRefundsByOrderId } from '../payment/order-fixture';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { creditEventRowsRaw, restrictionRowsRaw } from '../credit/credit-fixture';
import { penaltyReceiptsRaw } from '../settlement/settlement-fixture';
import { SlotLockModule } from '../schedule/slot-lock.module';
import { SlotLockService } from '../schedule/slot-lock.service';
import {
  enrollmentPayStatusRaw,
  seedPaidEnrollmentRaw,
  seedSessionAtRaw,
  sessionStatusRaw,
} from '../trade/trade-fixture';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { FulfillmentModule } from './fulfillment.module';
import { MockRtcProvider } from './rtc-provider';
import { RoomService } from './room.service';
import { CancellationService } from './cancellation.service';
import {
  CANCEL_MATRIX_RULE_KEY,
  DEFAULT_CANCEL_MATRIX,
  judgeCancelMatrix,
  parseCancelMatrix,
  pctOfCents,
  splitCompensationPool,
} from './cancellation.engine';

/**
 * D4 取消与违约处理（需 PG；M2-W2 T3——R-01~R-06 + §8 幂等 + §9 交叉审查面 + §10 验收）：
 *   取消矩阵全组合（角色×时间窗×选择，2h/24h 边界两侧=engine 纯函数 + API 集成）；违约金
 *   占比分配总和=基数（3 用户除不尽，分位余数归 user_id 升序首名）；律师 <24h H3 审批真链
 *   （target='d4' 回调续跑：全退-30+20% 违约金）；律师缺席分支 -50（G1 经
 *   AttendanceAdjudicated 消费）+50% 赔付（F3 applyPenalty 收据）+SessionCancelled(platform)
 *   （⚠裁定-1：缺席档零双计）；平台取消（RoomOpenFailed 消费）零信用事件；幂等（重复取消
 *   API/重复消费 AttendanceAdjudicated/RoomOpenFailed/退款单键）；30 天窗口第 2 次停接
 *   （G1 验证面：经 D4 真事件驱动 SUSPEND_TAKE_7D；第 31 天重计归 credit.spec 时间旅行——
 *   L691-755 在册）；规则表驱动（cancel.matrix 快照版本→边界移位+STL rv 注记）。
 * 驱动：relay 手动 tick（drain）；调度器不自启动。G1 规则种子=credit.rules v1（经 H7
 * 免公示通道，credit.spec 同款）。
 */

const HOUR = 3_600_000;
const LAWYER = 9501;
const LAWYER_B = 9502;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** credit.rules 种子（本 spec 触达的分值行 + violation 窗口——credit.spec 同形） */
const CREDIT_ACTIONS_SEED: Record<string, unknown> = {
  user_cancel_early: { delta: -5 },
  user_cancel_late: { delta: -15, violation: true },
  lawyer_cancel_24h_plus: { delta: -10, violation: true },
  lawyer_cancel_under_24h: { delta: -30, violation: true },
  lawyer_absent: { delta: -50, violation: true },
};

// ===========================================================================
// Engine 纯函数（无 PG）：矩阵全组合 + 边界两侧 + 占比分配分位余数
// ===========================================================================

describe('D4 取消矩阵引擎（纯函数：角色×时间窗全组合，2h/24h 边界含端点）', () => {
  const M = DEFAULT_CANCEL_MATRIX;

  it('用户档全组合：≥2h（含恰 2h 端点）→ USER_FREE；<2h（2h−1ms/已开场）→ USER_LATE（R-01）', () => {
    expect(judgeCancelMatrix({ role: 'user', msUntilStart: 25 * HOUR, matrix: M }).branch).toBe(
      'USER_FREE',
    );
    expect(judgeCancelMatrix({ role: 'user', msUntilStart: 2 * HOUR, matrix: M }).branch).toBe(
      'USER_FREE',
    ); // 恰在锚点=免费档（PRD ≥2h 含端点；G1 credit.consumer 同口径）
    const late = judgeCancelMatrix({ role: 'user', msUntilStart: 2 * HOUR - 1, matrix: M });
    expect(late.branch).toBe('USER_LATE');
    expect(late.userLateRefundPct).toBe(50); // 退 50% 档回显（choice=报名维度 API）
    expect(judgeCancelMatrix({ role: 'user', msUntilStart: -30 * 60_000, matrix: M }).branch).toBe(
      'USER_LATE',
    ); // 已开场（负值）→ <2h 档
  });

  it('律师档全组合：≥24h（含恰 24h 端点）→ LAWYER_NOTICE；<24h（24h−1ms）→ LAWYER_LT24H（R-02）', () => {
    expect(judgeCancelMatrix({ role: 'lawyer', msUntilStart: 48 * HOUR, matrix: M }).branch).toBe(
      'LAWYER_NOTICE',
    );
    expect(judgeCancelMatrix({ role: 'lawyer', msUntilStart: 24 * HOUR, matrix: M }).branch).toBe(
      'LAWYER_NOTICE',
    ); // 恰在锚点=通知档（≥24h 含端点）
    const lt = judgeCancelMatrix({ role: 'lawyer', msUntilStart: 24 * HOUR - 1, matrix: M });
    expect(lt.branch).toBe('LAWYER_LT24H');
    expect(lt.ticketCategory).toBe('cancel_lt24h'); // H3 工单类目锚
    expect(judgeCancelMatrix({ role: 'lawyer', msUntilStart: 3 * HOUR, matrix: M }).branch).toBe(
      'LAWYER_LT24H',
    );
  });

  it('规则表驱动（W2-4）：parseCancelMatrix 十键全量收窄；版本参数移位边界（窗口可配）', () => {
    const custom = parseCancelMatrix({
      userFreeCancelHours: 1,
      userLateRefundPct: 30,
      lawyerNoticeHours: 12,
      lawyerLatePenaltyCredit: 30,
      lawyerLatePenaltyPct: 25,
      lawyerAbsencePenaltyCredit: 50,
      lawyerAbsenceCompensationPct: 40,
      suspendWindowDays: 30,
      suspendCount: 2,
      suspendDays: 7,
    });
    expect(
      judgeCancelMatrix({ role: 'user', msUntilStart: 1.5 * HOUR, matrix: custom }).branch,
    ).toBe('USER_FREE'); // 1h 窗下 1.5h ≥ 1h=免费档（默认 2h 窗下 1.5h=USER_LATE——边界随版本移位）
    expect(
      judgeCancelMatrix({ role: 'user', msUntilStart: 0.5 * HOUR, matrix: custom }).branch,
    ).toBe('USER_LATE'); // 1h 窗内半程=<2h 语义
    expect(
      judgeCancelMatrix({ role: 'lawyer', msUntilStart: 13 * HOUR, matrix: custom }).branch,
    ).toBe('LAWYER_NOTICE'); // 12h 窗下 13h=通知档
    expect(DEFAULT_CANCEL_MATRIX).toMatchObject({
      userFreeCancelHours: 2,
      userLateRefundPct: 50,
      lawyerNoticeHours: 24,
      lawyerLatePenaltyPct: 20,
      lawyerAbsenceCompensationPct: 50,
      suspendWindowDays: 30,
      suspendCount: 2,
      suspendDays: 7,
    }); // 内置默认（无版本兜底=W2 计划 T3 行 seed 值逐字）
  });

  it('parseCancelMatrix 漂移显性化：缺键/非整数/pct>100 → InternalError（宁炸不降级，credit.rules 同口径）', () => {
    const full = {
      userFreeCancelHours: 2,
      userLateRefundPct: 50,
      lawyerNoticeHours: 24,
      lawyerLatePenaltyCredit: 30,
      lawyerLatePenaltyPct: 20,
      lawyerAbsencePenaltyCredit: 50,
      lawyerAbsenceCompensationPct: 50,
      suspendWindowDays: 30,
      suspendCount: 2,
      suspendDays: 7,
    };
    expect(() => parseCancelMatrix({ ...full, userFreeCancelHours: undefined })).toThrow(AppError);
    expect(() => parseCancelMatrix({ ...full, userLateRefundPct: 1.5 })).toThrow(AppError);
    expect(() => parseCancelMatrix({ ...full, lawyerLatePenaltyPct: 101 })).toThrow(AppError);
    expect(() => parseCancelMatrix({ ...full, lawyerNoticeHours: '24' })).toThrow(AppError);
  });

  it('R-04 占比分配：总和=池（分位余数归 user_id 升序首名）——3 用户除不尽场景', () => {
    // 池 100 分，支付 33.33/33.33/33.34 元（3333/3333/3334 分）：floor 33/33/33 + 余 1 → 首名 34
    const alloc = splitCompensationPool(100, [
      { user_id: 302, paid_cents: 3333 },
      { user_id: 301, paid_cents: 3333 },
      { user_id: 303, paid_cents: 3334 }, // 输入乱序——余数归升序首名 301
    ]);
    expect(alloc).toEqual([
      { user_id: 301, amount_cents: 34 }, // 余数 1 分归首名（§11 实现约定）
      { user_id: 302, amount_cents: 33 },
      { user_id: 303, amount_cents: 33 },
    ]);
    expect(alloc.reduce((s, a) => s + a.amount_cents, 0)).toBe(100); // 守恒：总和=基数
  });

  it('R-04 占比分配：守恒断言矩阵（单用户全额/大额 BigInt/比例悬殊）；非法输入显性拒绝', () => {
    expect(
      splitCompensationPool(50_00, [
        { user_id: 1, paid_cents: 30_00 },
        { user_id: 2, paid_cents: 70_00 },
      ]),
    ).toEqual([
      { user_id: 1, amount_cents: 15_00 },
      { user_id: 2, amount_cents: 35_00 },
    ]);
    // 大额：池 90_000_000_000_00 分 × 占比（>2^53 域，BigInt 承载）
    const big = splitCompensationPool(900_000_000_000, [
      { user_id: 1, paid_cents: 1_000_000_000 },
      { user_id: 2, paid_cents: 3_000_000_000 },
    ]);
    expect(big.reduce((s, a) => s + a.amount_cents, 0)).toBe(900_000_000_000);
    expect(() => splitCompensationPool(100, [])).toThrow(AppError);
    expect(() =>
      splitCompensationPool(100, [
        { user_id: 1, paid_cents: 0 },
        { user_id: 2, paid_cents: 0 },
      ]),
    ).toThrow(AppError); // 占比分母 0
    expect(() =>
      splitCompensationPool(100, [
        { user_id: 1, paid_cents: 50 },
        { user_id: 1, paid_cents: 50 },
      ]),
    ).toThrow(AppError); // user_id 重复
  });

  it('R-04 百分池：pctOfCents floor 语义（20%/50% 档；越域拒绝）', () => {
    expect(pctOfCents(10_00, 20)).toBe(2_00);
    expect(pctOfCents(99, 50)).toBe(49); // 49.5 → floor 49
    expect(pctOfCents(123_45, 20)).toBe(24_69); // 2469.0
    expect(() => pctOfCents(100, 0)).toThrow(AppError);
    expect(() => pctOfCents(100, 101)).toThrow(AppError);
    expect(() => pctOfCents(-1, 50)).toThrow(AppError);
  });
});

// ===========================================================================
// 集成（需 PG）：API/审批/消费三链 + F2/G1/F3 联动 + 幂等
// ===========================================================================

describe('D4 取消与违约处理（矩阵执行/审批回调/缺席终止/平台取消，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let cancellations: CancellationService;
  let rooms: RoomService;
  let tickets: TicketService;
  let rules: RuleCenterService;
  let payment: PaymentGatewayService;
  let relay: OutboxRelayService;
  let outbox: OutboxService;
  let poolSvc: PgPoolService;
  let locks: SlotLockService;

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  /** PAID 报名（六键快照——advanceToRefunded 出库防御兼容）+ 真实 F1 支付单
   *  （enroll/e{id}/pay 键关联——D4/F2 取数面口径） */
  const seedPaidWithOrder = async (
    sessionId: number,
    userId: number,
    o?: { cash?: string; points?: number },
  ): Promise<{ enrollmentId: number; orderId: number }> => {
    const enrollmentId = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId,
      cash: o?.cash ?? '100.00',
      points: o?.points ?? 0,
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
    const created = await payment.createOrder({
      biz_type: 'enroll',
      biz_id: enrollmentId,
      cash_amount: o?.cash ?? '100.00',
      points_amount: o?.points ?? 0,
      idempotency_key: enrollmentOrderKey(enrollmentId),
    });
    await payment.markFrozen(created.payment_order.id, `MOCK-WECHAT-D4-${enrollmentId}`);
    return { enrollmentId, orderId: created.payment_order.id };
  };

  /** credit.rules v1 种子（H7 免公示通道；G1 消费 D4/D3 事件的规则前提） */
  const seedCreditRules = (): Promise<unknown> =>
    poolSvc.withTransaction((uow: SqlExecutor) =>
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
          actions: CREDIT_ACTIONS_SEED,
        },
        effectiveAt: new Date(Date.now() - HOUR),
      }),
    );

  /** cancel.matrix 版本种子（规则表驱动面；custom 部分覆盖其余走默认值无关本断言面） */
  const seedCancelMatrix = (version: number, content: Record<string, unknown>): Promise<unknown> =>
    poolSvc.withTransaction((uow: SqlExecutor) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CANCEL_MATRIX_RULE_KEY,
        version,
        content,
        effectiveAt: new Date(Date.now() - HOUR),
      }),
    );

  /** 出箱事件播种（生产等价物直写——D1/D3 生产面在册，消费端测真实链） */
  const recordEvent = (type: string, payload: Record<string, unknown>): Promise<unknown> =>
    poolSvc.withTransaction((uow) => outbox.recordOutbox(uow, { type, payload }));

  /** relay 清空 PENDING（重试轨道行因退避不被立即重拾） */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      const r = await relay.tick();
      if (r.dispatched === 0) break;
    }
  };

  /** 直插房间行（开房失败 D1 形态：CANCELLED 直插+open_fail_reason；openRoomForSession 的失败分支等价物） */
  const seedFailedRoom = async (sessionId: number, slotStart: Date): Promise<number> => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO fulfillment.rooms
         (session_id, mode, scheduled_start, grace_end, status, open_fail_reason)
       VALUES ($1, 'text', $2, $3, 'CANCELLED', 'fixture:rtc-down') RETURNING id`,
      [sessionId, slotStart, new Date(slotStart.getTime() + 5 * 60_000)],
    );
    return Number(res.rows[0]!.id);
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    // SlotLockModule 追加装配=I-2 用例的 B2 席位锁种子面（导出面调用——测试模块级组合，
    // 生产 FulfillmentModule 不引入锁依赖）
    const moduleRef = await Test.createTestingModule({
      imports: [FulfillmentModule, SlotLockModule],
    })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app)); // D5 WSS 网关装载（attendance.spec 同款）
    await app.init(); // onModuleInit：D4 两消费器+d4 回调注册；F2/G1/F3/H3 既有消费器在册
    cancellations = app.get(CancellationService);
    rooms = app.get(RoomService);
    tickets = app.get(TicketService);
    rules = app.get(RuleCenterService);
    payment = app.get(PaymentGatewayService);
    relay = app.get(OutboxRelayService);
    outbox = app.get(OutboxService);
    poolSvc = app.get(PgPoolService);
    locks = app.get(SlotLockService);
    app.get(MockRtcProvider); // mock 通道装配断言（RTC_PROVIDER 工厂）
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await seedCreditRules();
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------------------------------------------------------------------------
  // R-01 用户矩阵（API 集成）
  // ---------------------------------------------------------------------------

  it('R-01 用户 ≥2h：场次取消（user 档）→ CANCELLED+SessionCancelled(user)+F2 全额退款真链+改期指引位+STL 留痕', async () => {
    const slotStart = new Date(Date.now() + 25 * HOUR);
    const sessionId = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', slotStart);
    const { orderId } = await seedPaidWithOrder(sessionId, 7001);

    const result = await cancellations.cancelSession(
      { sessionId, role: 'user', reason: '有事无法参加' },
      { actorUserId: 7001 },
    );
    expect(result).toMatchObject({
      result: 'CANCELLED',
      refund: 'FULL',
      reschedule_available: true, // ≥2h：免费改期一次的 C5 指引位（D4 不代做）
    });
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');

    // 载荷锚（G1 档位判定输入）：by=user、by_user=取消方账号、session_start_at=约定开始
    const events = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session_id: sessionId,
      cancelled_by: 'user',
      cancelled_by_user_id: 7001,
      session_start_at: slotStart.toISOString(),
    });
    expect(typeof events[0]!['cancelled_at']).toBe('string');

    // F2 真链（relay）：全额退款单（CANCEL_RULE / refund/po-{id}/session-cancel 键）——
    // 跨域读经 owner 夹具（payment/order-fixture，schema-refs 纪律）
    await drain();
    const refunds = await listRefundsByOrderId(pool, orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      cash_amount: '100.00',
      points_amount: 0,
      reason: 'CANCEL_RULE',
      status: 'PROCESSING', // 通道在途（REFUND_SUCCESS 回调收敛归 F2 spec）
      idempotency_key: `refund/po-${orderId}/session-cancel`,
    });

    // STL 留痕：session CANCELLED，reason=D4 分支+规则版本（无 cancel.matrix 版本=rv0 兜底）
    const stl = await pool.query<{ to_status: string; reason: string }>(
      `SELECT to_status, reason FROM platform.state_transition_log
        WHERE entity_type = 'session' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
    expect(stl.rows[0]).toMatchObject({
      to_status: 'CANCELLED',
      reason: 'd4_cancel:USER_FREE:rv=0',
    });

    // G1 联动（真事件消费）：user_cancel_early（≥2h 轻档）恰一次（credit-fixture 直读锚）
    await drain();
    expect(await creditEventRowsRaw(pool, 'user', 7001)).toEqual([
      { action: 'user_cancel_early', delta: -5, ref_id: String(sessionId) },
    ]);
  });

  it('R-01 用户 <2h 场次级取消 → 400 指引报名维度（choice 无会话级入参位）；≥2h 报名取消 → 400 >=2H_USE_RESCHEDULE', async () => {
    const near = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', new Date(Date.now() + HOUR));
    await seedPaidWithOrder(near, 7001); // 参与方身份过归属闸（matrix 400 在归属校验之后）
    await expect(
      cancellations.cancelSession({ sessionId: near, role: 'user' }, { actorUserId: 7001 }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument, httpStatus: 400 });

    const far = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', new Date(Date.now() + 25 * HOUR));
    const { enrollmentId } = await seedPaidWithOrder(far, 7002);
    await expect(
      cancellations.cancelEnrollment({ enrollmentId, choice: 'refund50' }, { actorUserId: 7002 }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument, httpStatus: 400 });
  });

  it('R-01 用户 <2h 报名取消 refund50：D4 直调 F2（50% 池 cash 先配积分兜量）+报名 REFUNDED+幂等重放', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + HOUR),
    );
    // 混合支付：cash 30.00 + points 7000（70.00）=total 100.00 → 池 50.00 = cash 30.00 + points 2000
    const { enrollmentId, orderId } = await seedPaidWithOrder(sessionId, 7003, {
      cash: '30.00',
      points: 7000,
    });

    const r1 = await cancellations.cancelEnrollment(
      { enrollmentId, choice: 'refund50' },
      { actorUserId: 7003 },
    );
    expect(r1.result).toBe('CANCELLED_REFUND50');
    expect(r1.refund_id).toBeGreaterThan(0);

    const refunds = await listRefundsByOrderId(pool, orderId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      cash_amount: '30.00',
      points_amount: 2000, // 50% 池的积分兜量（总额恰=池不破守恒）
      reason: 'CANCEL_RULE',
    });
    // 报名终态化（PAID→REFUNDED，STL）+ 场次不动（<2h=单报名维度退出，场次继续）
    expect(await enrollmentPayStatusRaw(pool, enrollmentId)).toBe('REFUNDED');
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CONFIRMED');

    // 幂等键=enrollment：重复请求返回既有结果（不再开退款单）
    const r2 = await cancellations.cancelEnrollment(
      { enrollmentId, choice: 'refund50' },
      { actorUserId: 7003 },
    );
    expect(r2).toMatchObject({ result: 'CANCELLED_REFUND50', deduplicated: true });
    expect((await listAllRefundsRaw(pool)).length).toBe(1);
  });

  it('R-01 用户 <2h 报名取消 credit：零退款+G1 user_cancel_late（enrollment ref）+重放去重；PENDING/非属主拒', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + HOUR),
    );
    const { enrollmentId } = await seedPaidWithOrder(sessionId, 7004);

    const r1 = await cancellations.cancelEnrollment(
      { enrollmentId, choice: 'credit' },
      { actorUserId: 7004 },
    );
    expect(r1).toMatchObject({ result: 'CANCELLED_CREDIT' });
    expect((await listAllRefundsRaw(pool)).length).toBe(0); // 零退款（费用不退口径）
    expect(await creditEventRowsRaw(pool, 'user', 7004)).toEqual([
      { action: 'user_cancel_late', delta: -15, ref_id: String(enrollmentId) },
    ]);
    // 报名保持 PAID（到场义务继续——信用损伤为价，PRD §8.7「或扣信用」字面）
    expect(await enrollmentPayStatusRaw(pool, enrollmentId)).toBe('PAID');

    // 幂等：emit 去重（同 owner+action+ref 唯一约束）
    const r2 = await cancellations.cancelEnrollment(
      { enrollmentId, choice: 'credit' },
      { actorUserId: 7004 },
    );
    expect(r2).toMatchObject({ result: 'CANCELLED_CREDIT', deduplicated: true });

    // 属主校验 403
    await expect(
      cancellations.cancelEnrollment({ enrollmentId, choice: 'credit' }, { actorUserId: 9999 }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden });
  });

  // ---------------------------------------------------------------------------
  // R-02 律师矩阵（直接档 + <24h H3 审批真链）
  // ---------------------------------------------------------------------------

  it('R-02 律师 ≥24h：直接取消 → CANCELLED+SessionCancelled(lawyer)+全退+G1 lawyer_cancel_24h_plus；属主外 403', async () => {
    const slotStart = new Date(Date.now() + 48 * HOUR);
    const sessionId = await seedSessionAtRaw(pool, LAWYER, 'FULL', slotStart);
    await seedPaidWithOrder(sessionId, 7101);

    await expect(
      cancellations.cancelSession({ sessionId, role: 'lawyer' }, { actorUserId: LAWYER_B }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden }); // 非属主律师 403

    const result = await cancellations.cancelSession(
      { sessionId, role: 'lawyer', reason: '日程冲突' },
      { actorUserId: LAWYER },
    );
    expect(result).toMatchObject({ result: 'CANCELLED', refund: 'FULL' });
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');

    await drain();
    const events = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(events[0]).toMatchObject({ cancelled_by: 'lawyer', cancelled_by_user_id: LAWYER });
    // F2 全额（真链）
    expect((await listAllRefundsRaw(pool)).filter((r) => r.reason === 'CANCEL_RULE')).toHaveLength(
      1,
    );
    // G1：≥24h 轻档（cancelled_at 与 session_start_at 差值=48h → 24h_plus）；无违约金指令
    expect(await creditEventRowsRaw(pool, 'lawyer', LAWYER)).toEqual([
      { action: 'lawyer_cancel_24h_plus', delta: -10, ref_id: String(sessionId) },
    ]);
    expect((await penaltyReceiptsRaw(pool)).length).toBe(0); // ≥24h 无违约金（PRD §8.6）

    // 幂等键=session+role：重复取消返回既有结果
    const again = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    expect(again).toMatchObject({ result: 'CANCELLED', deduplicated: true });
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1);
  });

  it('R-02 律师 <24h：H3 审批真链——建单（幂等 category+ref）→ approve 回调（target=d4）续跑：全退-30+20% 违约金收据+占比分配', async () => {
    const slotStart = new Date(Date.now() + 3 * HOUR);
    const sessionId = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', slotStart);
    // 三用户支付 33.33/33.33/33.34（占比分位余数面）；session_total=100.00 → 20% 池=20.00
    await seedPaidWithOrder(sessionId, 7201, { cash: '33.33' });
    await seedPaidWithOrder(sessionId, 7202, { cash: '33.33' });
    await seedPaidWithOrder(sessionId, 7203, { cash: '33.34' });

    const r1 = await cancellations.cancelSession(
      { sessionId, role: 'lawyer', reason: '突发情况' },
      { actorUserId: LAWYER },
    );
    expect(r1.result).toBe('PENDING_APPROVAL');
    const ticketId = r1.approval!.ticket_id;
    expect(r1.approval!.sla_due).toBeTruthy();
    // 工单在册（category=cancel_lt24h 挂 ref=session——H3 导出查询面读取）；场次未取消零事件
    const detail = await tickets.getTicketDetail(ticketId);
    expect(detail.ticket).toMatchObject({
      category: 'cancel_lt24h',
      ref_type: 'session',
      ref_id: sessionId,
      status: 'OPEN',
    });
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CONFIRMED');
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(0);

    // 重复取消 → 幂等（同 category+ref 工单短路）
    const r2 = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    expect(r2).toMatchObject({ result: 'PENDING_APPROVAL' });
    expect(r2.approval!.ticket_id).toBe(ticketId);
    expect((await tickets.listTickets({ category: 'cancel_lt24h' })).length).toBe(1);

    // 审批通过（H3 resolve 携 action_payload target=d4）→ 续跑：取消+20% 违约金
    await tickets.resolveTicket({
      ticketId,
      operatorId: 8801,
      approved: true,
      actionPayload: { target: 'd4', cancellation_id: sessionId },
    });
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');
    const events = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cancelled_by: 'lawyer', cancelled_by_user_id: LAWYER });

    // F3 赔付指令（applyPenalty 收据）：amount=20%×场次总价=20.00；重放恰一次
    expect(await penaltyReceiptsRaw(pool)).toEqual([
      { penalty_key: `penalty/session-${sessionId}/cancel-lt24h`, amount: '20.00' },
    ]);

    // F2 全额退款真链 + G1 <24h 档（cancelled_at≈now < slot_start−24h 窗内 → under_24h -30）
    await drain();
    expect((await listAllRefundsRaw(pool)).filter((r) => r.reason === 'CANCEL_RULE')).toHaveLength(
      3,
    );
    expect(await creditEventRowsRaw(pool, 'lawyer', LAWYER)).toEqual([
      { action: 'lawyer_cancel_under_24h', delta: -30, ref_id: String(sessionId) },
    ]);
  });

  it('R-02 律师 <24h 审批驳回：REJECTED 终态 → 场次不动零事件；重复取消返回 APPROVAL_REJECTED', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + 3 * HOUR),
    );
    const r1 = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    await tickets.resolveTicket({
      ticketId: r1.approval!.ticket_id,
      operatorId: 8801,
      approved: false,
      actionPayload: { target: 'd4', cancellation_id: sessionId },
    });
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CONFIRMED');
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(0);
    expect((await penaltyReceiptsRaw(pool)).length).toBe(0);

    const r2 = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    expect(r2.result).toBe('APPROVAL_REJECTED');
  });

  // ---------------------------------------------------------------------------
  // R-03 律师缺席自动终止（AttendanceAdjudicated 消费）
  // ---------------------------------------------------------------------------

  it('R-03 律师缺席：AttendanceAdjudicated(lawyer absent) 消费 → 场次+房间终止+SessionCancelled(platform 零双计)+50% 赔付收据+占比分配余数归首+全退', async () => {
    const slotStart = new Date(Date.now() - 20 * 60_000); // 已开场 20min（grace+15 判后）
    const sessionId = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', slotStart);
    await seedPaidWithOrder(sessionId, 7301, { cash: '33.33' });
    await seedPaidWithOrder(sessionId, 7302, { cash: '66.67' });
    // 真链开房（room OPEN+room 会话+4 job 预写=Mock RTC）
    const room = await poolSvc.withTransaction((uow) => rooms.openRoomForSession(uow, sessionId));
    expect(room.opened).toBe(true);
    // 律师缺席判定行（D3 job2 等价物直插——adjudication_id=行 id）
    const adj = await pool.query<{ id: string }>(
      `INSERT INTO fulfillment.attendances (room_id, user_id, role, status, adjudicated_at)
       VALUES ($1, $2, 'lawyer', 'ABSENT', now()) RETURNING id`,
      [room.room_id, LAWYER],
    );
    const adjudicationId = Number(adj.rows[0]!.id);

    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, {
      adjudication_id: adjudicationId,
      session_id: sessionId,
      owner_type: 'lawyer',
      owner_id: LAWYER,
      result: 'absent',
    });
    await drain();

    // 场次+房间终止；SessionCancelled=platform 档（⚠裁定-1：缺席信用由判定事件独立承载）
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');
    expect(
      (
        await pool.query<{ status: string }>(`SELECT status FROM fulfillment.rooms WHERE id = $1`, [
          room.room_id,
        ])
      ).rows[0],
    ).toMatchObject({ status: 'CANCELLED' });
    const events = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cancelled_by: 'platform',
      cancelled_by_user_id: null,
      session_start_at: slotStart.toISOString(),
    });

    // F3 赔付：50%×100.00=50.00 收据；占比分配（33.33/66.67 → 16.66/33.33，余数 1 分归 7301）
    expect(await penaltyReceiptsRaw(pool)).toEqual([
      { penalty_key: `penalty/session-${sessionId}/lawyer-absence`, amount: '50.00' },
    ]);

    // G1 侧：lawyer_absent -50（判定事件消费）；零 lawyer_cancel_under_24h（裁定-1 防双计）
    expect(await creditEventRowsRaw(pool, 'lawyer', LAWYER)).toEqual([
      { action: 'lawyer_absent', delta: -50, ref_id: String(adjudicationId) },
    ]);

    // F2 全退真链（platform 档）
    expect((await listAllRefundsRaw(pool)).filter((r) => r.reason === 'CANCEL_RULE')).toHaveLength(
      2,
    );

    // 占比分配（服务返回面）：总和=池+余数归 user_id 升序首名
    const replay = await cancellations.terminateForLawyerAbsence({
      sessionId,
      lawyerId: LAWYER,
      adjudicationId,
    });
    expect(replay.executed).toBe(false); // 终态短路（幂等=adjudication→session N:1 收敛）
    expect(replay.penalty!.replayed).toBe(true); // 收据键重放恰一次
    expect(replay.allocation).toEqual([
      { user_id: 7301, amount_cents: 1667 }, // floor(5000×3333/10000)=1666+余 1
      { user_id: 7302, amount_cents: 3333 },
    ]);
    expect(replay.allocation!.reduce((s, a) => s + a.amount_cents, 0)).toBe(50_00);
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1); // 无第二事件
  });

  it('R-03 非律师缺席判定（user absent/lawyer normal）→ 零取消路径（无副作用跳过）', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + HOUR),
    );
    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, {
      adjudication_id: 999,
      session_id: sessionId,
      owner_type: 'user',
      owner_id: 7401,
      result: 'absent',
    });
    await drain();
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CONFIRMED');
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // R-06 平台取消（RoomOpenFailed 消费；D3 全员缺席路径 T2 在册不重写——本用例补退款真链承载）
  // ---------------------------------------------------------------------------

  it('R-06 开房失败平台取消：RoomOpenFailed 消费 → CANCELLED+SessionCancelled(platform)+全退+零信用事件+幂等', async () => {
    const slotStart = new Date(Date.now() + 30 * 60_000);
    const sessionId = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', slotStart);
    await seedFailedRoom(sessionId, slotStart); // D1 失败行（CANCELLED 直插）等价物
    await seedPaidWithOrder(sessionId, 7501);

    await recordEvent(ROOM_OPEN_FAILED_TOPIC, {
      session_id: sessionId,
      reason: 'rtc:build-failed',
    });
    await drain();

    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');
    const events = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cancelled_by: 'platform', cancelled_by_user_id: null });

    // F2 全退真链（platform 开房失败档统一 CANCEL_RULE）
    expect((await listAllRefundsRaw(pool)).filter((r) => r.reason === 'CANCEL_RULE')).toHaveLength(
      1,
    );

    // 零信用事件（PRD §8.7 平台取消无信用影响——G1 跳过；两 owner 皆空）
    expect(await creditEventRowsRaw(pool, 'lawyer', LAWYER)).toEqual([]);
    expect(await creditEventRowsRaw(pool, 'user', 7501)).toEqual([]);

    // 幂等：事件重投（新 event_id 同载荷）→ 终态短路零双发零双退
    await recordEvent(ROOM_OPEN_FAILED_TOPIC, {
      session_id: sessionId,
      reason: 'rtc:build-failed',
    });
    await drain();
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1);
    expect((await listAllRefundsRaw(pool)).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // R-05 连续 2 次停接（G1 验证面：经 D4 真事件驱动；第 31 天重计=credit.spec L691-755 在册）
  // ---------------------------------------------------------------------------

  it('R-05 30 天窗口第 2 次律师取消 → G1 SUSPEND_TAKE_7D 停接令（violation_window:30d）；第 1 次不停', async () => {
    for (const userId of [7601, 7602]) {
      const sessionId = await seedSessionAtRaw(
        pool,
        LAWYER_B,
        'CONFIRMED',
        new Date(Date.now() + 48 * HOUR),
      );
      await seedPaidWithOrder(sessionId, userId);
      const r = await cancellations.cancelSession(
        { sessionId, role: 'lawyer' },
        { actorUserId: LAWYER_B },
      );
      expect(r.result).toBe('CANCELLED');
      await drain();
    }
    expect(await restrictionRowsRaw(pool, 'lawyer', LAWYER_B)).toEqual([
      { kind: 'SUSPEND_TAKE_7D', reason: 'violation_window:30d' }, // 第 2 次触发（30 天窗口）
    ]);
    // 两次取消各一次 24h_plus 档（-10；violation=true 计数）
    const evts = (await creditEventRowsRaw(pool, 'lawyer', LAWYER_B)).filter(
      (e) => e.action === 'lawyer_cancel_24h_plus',
    );
    expect(evts).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // §5 409 NOT_CANCELLABLE + 归属校验 + 规则版本化边界移位
  // ---------------------------------------------------------------------------

  it('§5 NOT_CANCELLABLE：终态场次（FAILED/已被他人取消）→ 409；非参与方 user 403', async () => {
    const failed = await seedSessionAtRaw(pool, LAWYER, 'FAILED', new Date(Date.now() + 25 * HOUR));
    await seedPaidWithOrder(failed, 7701);
    await expect(
      cancellations.cancelSession({ sessionId: failed, role: 'user' }, { actorUserId: 7701 }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict, httpStatus: 409 });

    const cancelled = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + 25 * HOUR),
    );
    await seedPaidWithOrder(cancelled, 7702);
    await cancellations.cancelSession(
      { sessionId: cancelled, role: 'user' },
      { actorUserId: 7702 },
    );
    // 场次已取消（终态）：另一角色再取消 → 409（已被 user 取消）
    await expect(
      cancellations.cancelSession(
        { sessionId: cancelled, role: 'lawyer' },
        { actorUserId: LAWYER },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });

    // 非参与方（无 PAID 报名非律师）→ 403
    const other = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + 25 * HOUR),
    );
    await expect(
      cancellations.cancelSession({ sessionId: other, role: 'user' }, { actorUserId: 7703 }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden });
  });

  it('§8 规则表驱动：cancel.matrix v2（userFreeCancelHours=1）→ 边界移位 + STL reason 记 rv=2', async () => {
    await seedCancelMatrix(2, {
      userFreeCancelHours: 1,
      userLateRefundPct: 50,
      lawyerNoticeHours: 24,
      lawyerLatePenaltyCredit: 30,
      lawyerLatePenaltyPct: 20,
      lawyerAbsencePenaltyCredit: 50,
      lawyerAbsenceCompensationPct: 50,
      suspendWindowDays: 30,
      suspendCount: 2,
      suspendDays: 7,
    });
    // 距开始 1.5h：默认矩阵=USER_LATE（400）；v2（1h 窗）=USER_FREE（直接取消）
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + 1.5 * HOUR),
    );
    await seedPaidWithOrder(sessionId, 7801);
    const r = await cancellations.cancelSession({ sessionId, role: 'user' }, { actorUserId: 7801 });
    expect(r).toMatchObject({ result: 'CANCELLED', refund: 'FULL' });
    const stl = await pool.query<{ reason: string }>(
      `SELECT reason FROM platform.state_transition_log
        WHERE entity_type = 'session' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
    expect(stl.rows[0]).toMatchObject({ reason: 'd4_cancel:USER_FREE:rv=2' }); // 行为时快照版本入 STL
  });

  it('§8 双路径边界：<2h 50% 已退后场次再全退 → F2 守恒入口拒受理该单（复合路径人工兜底面，不静默双退）', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + HOUR),
    );
    const { enrollmentId, orderId } = await seedPaidWithOrder(sessionId, 7901);
    await cancellations.cancelEnrollment(
      { enrollmentId, choice: 'refund50' },
      { actorUserId: 7901 },
    );
    // 律师 <24h 审批通过 → 取消+赔付照常；全退消费撞守恒（50%+100%>total）→ F2 受理面
    // 400 确定性拒绝（不落退款单），消费端抛错进 relay 重试轨道——资损面不静默双退，
    // 人工兜底经重试耗尽死信/H3 承载（报告 ⚠ 双路径边界注记）
    const r = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    await tickets.resolveTicket({
      ticketId: r.approval!.ticket_id,
      operatorId: 8801,
      approved: true,
      actionPayload: { target: 'd4', cancellation_id: sessionId },
    });
    await drain();
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED'); // 取消流不受退款复合影响
    expect((await penaltyReceiptsRaw(pool)).length).toBe(1); // 20% 违约金收据在册
    const rows = await listRefundsByOrderId(pool, orderId);
    expect(rows).toHaveLength(1); // 恰 50% 单——全退单被守恒入口拒（零双退）
    expect(rows[0]).toMatchObject({
      idempotency_key: `refund/po-${orderId}/cancel-user50`,
      status: 'PROCESSING',
    });
  });

  // ---------------------------------------------------------------------------
  // 修复环（M2-W2 T3 交叉评审）：C-1 开场后下界 / I-1 赔付归属闸 / I-2 prior 收敛 /
  // I-3 工单自愈 / I-4 choice 单选锚
  // ---------------------------------------------------------------------------

  it('C-1 开场后下界：slot_start 已过 → refund50/credit 均 409（开场后按缺席处理）+零退款单', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() - 30 * 60_000), // 已开场 30min（<2h 且非终态——下界独立成案）
    );
    const { enrollmentId } = await seedPaidWithOrder(sessionId, 7951);
    await expect(
      cancellations.cancelEnrollment({ enrollmentId, choice: 'refund50' }, { actorUserId: 7951 }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict, httpStatus: 409 });
    await expect(
      cancellations.cancelEnrollment({ enrollmentId, choice: 'credit' }, { actorUserId: 7951 }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect((await listAllRefundsRaw(pool)).length).toBe(0); // 零退款单
    expect(await enrollmentPayStatusRaw(pool, enrollmentId)).toBe('PAID'); // 报名不动（缺席链归 D3）
  });

  it('I-1 赔付归属闸：缺席链先落（platform+50% 赔付）后 LT24H 审批通过 → 不叠加 20% 违约金（恰 1 笔收据）', async () => {
    const slotStart = new Date(Date.now() - 20 * 60_000); // 已开场（<24h → 律师取消=LT24H 档）
    const sessionId = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', slotStart);
    await seedPaidWithOrder(sessionId, 7961);
    const room = await poolSvc.withTransaction((uow) => rooms.openRoomForSession(uow, sessionId));
    const adj = await pool.query<{ id: string }>(
      `INSERT INTO fulfillment.attendances (room_id, user_id, role, status, adjudicated_at)
       VALUES ($1, $2, 'lawyer', 'ABSENT', now()) RETURNING id`,
      [room.room_id, LAWYER],
    );
    // ① 律师先发起 <24h 取消（建单在批，场次未动）
    const r = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    expect(r.result).toBe('PENDING_APPROVAL');
    // ② 缺席判定事件消费 → platform 取消 + 50% 赔付先落地
    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, {
      adjudication_id: Number(adj.rows[0]!.id),
      session_id: sessionId,
      owner_type: 'lawyer',
      owner_id: LAWYER,
      result: 'absent',
    });
    await drain();
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');
    expect(await penaltyReceiptsRaw(pool)).toEqual([
      { penalty_key: `penalty/session-${sessionId}/lawyer-absence`, amount: '50.00' },
    ]);
    // ③ 审批通过（跨分支：prior.cancelled_by='platform' ≠ 'lawyer'）→ 20% 不叠加
    await tickets.resolveTicket({
      ticketId: r.approval!.ticket_id,
      operatorId: 8801,
      approved: true,
      actionPayload: { target: 'd4', cancellation_id: sessionId },
    });
    expect(await penaltyReceiptsRaw(pool)).toEqual([
      { penalty_key: `penalty/session-${sessionId}/lawyer-absence`, amount: '50.00' }, // 恰 1 笔
    ]);
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1); // 不二次出箱
  });

  it('I-2 prior 收敛：D3 全员缺席形态（事件在册+room CANCELLED+session 未迁移+锁占用）→ cancelForPlatform 收敛 session 行=CANCELLED+席位锁释放+不二次出箱', async () => {
    const slotStart = new Date(Date.now() + 30 * 60_000);
    const sessionId = await seedSessionAtRaw(pool, LAWYER, 'CONFIRMED', slotStart);
    await seedPaidWithOrder(sessionId, 7971);
    // B2 占用锁在册（经导出面 lockSlot 种子——I-2 断言释放锚）
    const locked = await poolSvc.withTransaction((uow) =>
      locks.lockSlot(uow, {
        lawyerId: LAWYER,
        slotStart,
        initiatorUserId: LAWYER,
        refType: 'session',
        refId: sessionId,
      }),
    );
    expect(locked.ok).toBe(true);
    // D3 全员缺席形态注入：room CANCELLED 直插 + SessionCancelled(platform) 已出箱、session 行未迁移
    await seedFailedRoom(sessionId, slotStart);
    await recordEvent(SESSION_CANCELLED_TOPIC, {
      session_id: sessionId,
      cancelled_by: 'platform',
      cancelled_by_user_id: null,
      cancelled_at: new Date().toISOString(),
      session_start_at: slotStart.toISOString(),
    });

    const out = await cancellations.cancelForPlatform(sessionId, 'fixture:d3-converge');
    expect(out.executed).toBe(false); // prior 短路（不二次出箱）
    expect(out.prior).toBe(true);
    // 收敛面：session 行 CANCELLED + STL 审计 + B2 席位锁 RELEASED（platform.state_transition_log
    // 为基座白名单表；slot_lock 行=锁迁移留痕锚）
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');
    const stl = await pool.query<{ entity_type: string; to_status: string; reason: string }>(
      `SELECT entity_type, to_status, reason FROM platform.state_transition_log
        WHERE entity_id = $1 AND entity_type IN ('session', 'slot_lock') AND to_status IN ('CANCELLED', 'RELEASED')
        ORDER BY id DESC`,
      [sessionId],
    );
    const reasons = stl.rows.map((x) => `${x.entity_type}:${x.to_status}:${x.reason}`);
    expect(reasons).toContain('session:CANCELLED:d4_cancel:PLATFORM:rv=0');
    expect(reasons).toContain('slot_lock:RELEASED:session_cancelled');
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1); // 事件不双发
  });

  it('I-3 自愈：cancel_lt24h 工单 RESOLVED 而取消未落地（漂移注入）→ 建单重放自愈续跑（取消+20% 赔付恰落地）', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + 3 * HOUR),
    );
    await seedPaidWithOrder(sessionId, 7981);
    const r1 = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    expect(r1.result).toBe('PENDING_APPROVAL');
    // 漂移注入：工单被置 RESOLVED 而取消流未生效（缺 target 处置/回调崩溃窗历史形态——
    // ticket-fixture owner 侧直写）
    await forceResolveTicketRaw(pool, r1.approval!.ticket_id);
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CONFIRMED'); // 漂移在案（未取消）

    const r2 = await cancellations.cancelSession(
      { sessionId, role: 'lawyer' },
      { actorUserId: LAWYER },
    );
    expect(r2.result).toBe('CANCELLED'); // 自愈续跑后返回取消结果
    expect(await sessionStatusRaw(pool, sessionId)).toBe('CANCELLED');
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1);
    expect(await penaltyReceiptsRaw(pool)).toEqual([
      { penalty_key: `penalty/session-${sessionId}/cancel-lt24h`, amount: '20.00' },
    ]);
  });

  it('I-4 choice 单选锚：credit 档入账后 refund50 被拒（G1 流水在册=持久锚）+零退款单+报名保持 PAID', async () => {
    const sessionId = await seedSessionAtRaw(
      pool,
      LAWYER,
      'CONFIRMED',
      new Date(Date.now() + HOUR),
    );
    const { enrollmentId } = await seedPaidWithOrder(sessionId, 7991);
    await cancellations.cancelEnrollment({ enrollmentId, choice: 'credit' }, { actorUserId: 7991 });
    await expect(
      cancellations.cancelEnrollment({ enrollmentId, choice: 'refund50' }, { actorUserId: 7991 }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict, httpStatus: 409 });
    expect((await listAllRefundsRaw(pool)).length).toBe(0); // 零退款单（未翻单双得）
    expect(await enrollmentPayStatusRaw(pool, enrollmentId)).toBe('PAID');
  });
});
