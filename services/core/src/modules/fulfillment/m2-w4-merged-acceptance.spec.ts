import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import {
  ATTENDANCE_ADJUDICATED_TOPIC,
  DRAFT_ACTIONED_TOPIC,
  DRAFT_GENERATED_TOPIC,
  ONE_ON_ONE_ACCEPTED_TOPIC,
  ONE_ON_ONE_DIFF_PENDING_TOPIC,
  ONE_ON_ONE_FINISHED_TOPIC,
  ONE_ON_ONE_PAID_TOPIC,
  ONE_ON_ONE_SETTLED_TOPIC,
  POINTS_GRANTED_TOPIC,
  PRESENCE_JOINED_TOPIC,
  PRICE_CHANGE_APPROVED_TOPIC,
  PRICE_COUPON_INSTRUCTED_TOPIC,
  REFUND_COMPLETED_TOPIC,
  ROOM_CLOSED_TOPIC,
  ROOM_OPEN_FAILED_TOPIC,
  SESSION_CANCELLED_TOPIC,
  SPLIT_SETTLED_TOPIC,
  type PresencePayload,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { RealnameService } from '../identity/realname.service';
import { grantUserRoles, seedLawyerProfile, seedUserShell } from '../identity/lawyer-fixture';
import { SchedulerService } from '../schedule/scheduler.service';
import {
  backdateRoomJobsDue,
  cancelPendingJobsByType,
  listJobsByType,
} from '../schedule/job-fixture';
import { PAYMENT_CONFIG } from '../payment/payment.config';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { seedFirmMerchant } from '../payment/firm-merchant.fixture';
import {
  getPaymentOrderById,
  listLedgersByDirection,
  listRefundsByOrderId,
  seedPaymentOrderRaw,
} from '../payment/order-fixture';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { seedPaidEnrollmentRaw, seedSessionAtRaw, seedSessionRaw } from '../trade/trade-fixture';
import {
  deductionDetailByRefRaw,
  penaltyReceiptsRaw,
  settlementByRefRaw,
  settlementIdByRefRaw,
  travelHoldCreated,
} from '../settlement/settlement-fixture';
import { SettlementService } from '../settlement/settlement.service';
import { creditEventRowsRaw, restrictionRowsRaw } from '../credit/credit-fixture';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { RuleCenterService } from '../ops/rule-center.service';
import { MetricsService } from '../ops/metrics.service';
import { PointsService } from '../benefits/points.service';
import { CouponService } from '../benefits/coupon.service';
import { getPointsAccount } from '../benefits/points-fixture';
import { PricingConfigService } from '../pricing/pricing.service';
import { PriceChangeService } from '../pricing/price-change.service';
import { NotifyDispatcherService } from '../notify/notify-dispatcher.service';
import { listNotificationsRaw } from '../notify/notify-fixture';
import { draftRowsRaw, CapturingLlmAdapter } from '../agent-assist/draft-fixture';
import { DraftService } from '../agent-assist/draft.service';
import { LLM_ADAPTER } from '../agent-assist/llm.adapter';
import { DraftModule } from '../agent-assist/draft.module';
import { PricingChangeModule } from '../pricing/price-change.module';
import { MetricsModule } from '../ops/metrics.module';
import { FulfillmentModule } from './fulfillment.module';
import { MockRtcProvider } from './rtc-provider';
import { RoomService } from './room.service';
import { ConversationService } from './conversation.service';
import { OneOnOneService } from './one-on-one.service';
import {
  attendanceRowsRaw,
  conversationMessagesRaw,
  roomConversationIdRaw,
} from './fulfillment-fixture';
import { seedRoomRaw } from './one-on-one-fixture';

/**
 * M2-W4 T2 ①+② 合并端到端验收 spec（docs/05 §6.1 W4 行 + §6.2 口径；04 §5 六链/§6 事件清单）：
 * 六链路 API 级 E2E（W4-4 裁决：core 内集成 spec，不起 HTTP 服务，直调 service/consumer 面；
 * supertest 形态归 M1-W4 w4-acceptance 先例）。链路与断言对象（断言=跨模块账面终态）：
 *
 *   A 链①缺席 70/30（链 1 履约段）：开房→job1 律师 NORMAL→律师提前关房（RoomClosed→F3 进
 *     结算 HOLD）→job2 用户 ABSENT 补判→AttendanceAdjudicated→F3 share_mode=ABSENCE_7030
 *     →冻结期满（created_at 回拨+SETTLE_HOLD_RELEASE job 重注册）→RUN 分账→SplitSettled
 *     splits 70/30（律所 70%=floor、平台备付 30%=尾差桶，F3 §7 R-03）+F1 单 SPLIT+SPLIT
 *     指令流水；末尾重放幂等抽验（RoomClosed 重投恰一行/分账指令恰一笔）。
 *     ⚠真实主流时序（判定先于关房）下 F3 标记丢失=NO_SETTLEMENT warn 路径——实现缺口
 *     （settlement.consumer.ts 自认「M2 D3/D1 联调换装位」未落位），本 spec 以文档在册的
 *     「律师提前关房+判定补判」真实流（⚠W2-10 判定与房间生命周期正交）贯通，缺口列 triage
 *     （T2-报告 BLOCKER-1），不迁就实现改断言。
 *   B 链⑤无人到场退款：双方均未到场→job1 全员缺席→room CANCELLED(no_show)+SessionCancelled
 *     (platform)→F2 全额退款×2（含积分还原）→REFUND_SUCCESS→DONE；零结算行（全退+无结算
 *     口径）；律师侧 D4 缺席联动（50% 赔付走保证金专户+G1 lawyer_absent——PRD §8.6「律师
 *     缺席=宽限期未进场」含此形态；D1 R-02/D4 §4「全员缺席无信用影响」字面与 PRD 冲突=
 *     文档漂移 triage）；NO_SHOW_CLOSE 兜底 job 幂等无操作。
 *   C 链④律师违约金扣减：job2 律师 ABSENT→D4 terminateForLawyerAbsence（SessionCancelled
 *     platform+场次/房间终止）→F3 applyPenalty 50%×session_total→待结算余额 FIFO 摊扣
 *     （settlement 腿）+不足走保证金专户（deposit 腿）→F1 /pay/deduct 双腿流水+收据+
 *     deduction_detail 留痕；F2 关联全额退款 DONE；G1 lawyer_absent -50 在册。
 *   D 链③改价补偿发放（链 3 补偿段补验）：B3 v1→在团（PAID 报名）→C6 降 20%>10%→
 *     PENDING_APPROVAL→approve→EFFECTED→F4 积分直发（grantInTx COMPENSATION，#39 收口=
 *     生效事务内联+comp_snapshots granted）+券指令事件→CouponInstructionConsumer 券账面
 *     →I1 话术 PRICE_DOWN_BIG 经 dispatcher processPending SENT。（补偿「24h job 驱动」为
 *     M1 文档口径——#39 收口后已内联生效事务、24h SLA 由巡检⑤兜底，w4-acceptance 段 14
 *     在册；本链按现行实现断言账面。）
 *   E 链1 D6 段·1对1 实结多退少补（含 T1 净额闭合面）：申请→预付→接单→服务（计量注入：
 *     voice 0 信标 / text 轮次消息）→实结双确认——多退路（settle 40<prepaid 100→F2
 *     SETTLE_REFUND 退差 60+OneOnOneSettled net=40）与少补路（settle 100>prepaid 50→补差
 *     单→settle-diff/pay→PAY_SUCCESS→SETTLED net=100）；断言 F3 settlements.gross 列=
 *     净额构成基（W4-1 裁决：one_on_one 行 gross 列承载实结净额，T1 换基语义）。
 *   F 链⑥律师缺席前置校验（开房 job 校验分支）：RTC 失败注入→ROOM_OPEN job→room CANCELLED
 *     (open_fail_reason)+RoomOpenFailed→D4 平台取消→F2 全额退款 DONE；零判定行零信用事件
 *     （D3 R-04 开房不成功不判律师缺席）+零宽限 job 预写。
 *   H 链5 AI 辅助贯通：用户消息→E1 草稿（mock LLM 捕获件，脱敏进 LLM 载荷）→律师
 *     action(send) 经 D5 sendMessage 真链落律师消息→DraftActioned→H4 采用率聚合可查
 *     （getMetrics core 组 draft_adoption_rate=1）。
 *
 * G 项（D3 §10 三项核验）=既有 spec 引用（attendance.spec 13 用例+room.spec 在册，验收报告
 * 列用例名），本 spec 不重写。
 *
 * 装配：FulfillmentModule（链 1/2/4/5 主链：房间/判定/取消/D6+F2/F3/G1/H3/I2 全消费者）+
 * PricingChangeModule（C6+Benefits F4+Notify I1）+ MetricsModule（H4）+ DraftModule（E1）；
 * LLM_ADAPTER=CapturingLlmAdapter（mock LLM 驱动+载荷抽检）。调度器/relay 均不自启动——
 * 手动 tick（priority=ROOM_OPEN 通道/normal=其余）+drain（dead=0 断言；无 handler 的机制
 * topic 进重试轨道不阻塞不炸——本 spec 不做全 outbox SENT 收口，逐 topic 断言）。
 *
 * owner 纪律（check-schema-refs；w4-acceptance 同款）：本 spec 归 fulfillment（六链主实体
 * 房间/判定/取消在此）；直查面=fulfillment.*（owner：rooms/attendances/conversations/
 * one_on_one_orders）+platform 白名单（outbox/死信/STL）；trade/payment/settlement/
 * credit/benefits/notify/agent_assist/schedule 断言一律经 owner 夹具（trade-fixture/
 * order-fixture/settlement-fixture/credit-fixture/points-fixture/notify-fixture/
 * draft-fixture/job-fixture）或导出服务面，禁直查他域表。
 *
 * credit.rules 种子（beforeEach）：A/B/C/D 链 G1 消费真链所需（无生效版本 credit.emit 显性
 * 抛进重试轨道——w4-acceptance 段 12 同款前置）；fee_versions 0% 种子（V27）与话术模板
 * （V4）不入 TRUNCATE 清单，参照数据常在。金额断言全 Money 字符串/分整数，禁 float。
 */
const MIN = 60_000;
const FIRM_ID = 8801;
const VALID_ID_NO = '11010519491231002X'; // A2 mock 通道：GB11643 校验位合法 → VERIFIED

/** B3 1对1 矩阵种（text 50/轮、voice 100/15min——E 链金额锚） */
const B3_ONE_ON_ONE = {
  text: { per_round: '50.00' },
  voice: { per_15min: '100.00' },
  video: { per_15min: '100.00' },
};

/** credit.rules 种子（A/B/C/D 链触达的分值行+violation 窗口；cancellation.spec 同形） */
const CREDIT_RULES_SEED: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    user_participated: { delta: 0 },
    user_absent: { delta: -5, violation: true },
    lawyer_participated: { delta: 0 },
    lawyer_absent: { delta: -50, violation: true },
    lawyer_price_down_gt10: {
      delta: -30,
      restriction: { kind: 'SUSPEND_TAKE_3D', days: 3 },
    },
  },
};

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('M2-W4 ①+② 合并端到端验收（缺席 70/30/无人到场/律师违约金/改价补偿/1对1 实结/开房校验/AI 辅助，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let poolSvc: PgPoolService;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let scheduler: SchedulerService;
  let rtc: MockRtcProvider;
  let rooms: RoomService;
  let conversations: ConversationService;
  let orders: OneOnOneService;
  let payment: PaymentGatewayService;
  let settlements: SettlementService;
  let realname: RealnameService;
  let rules: RuleCenterService;
  let pricing: PricingConfigService;
  let priceChanges: PriceChangeService;
  let points: PointsService;
  let coupons: CouponService;
  let metrics: MetricsService;
  let dispatcher: NotifyDispatcherService;
  let drafts: DraftService;
  let llm: CapturingLlmAdapter;
  let channelSecret: string;
  let lawyerSeq = 20_000;
  let userSeq = 30_000;
  let sessionSeq = 0;
  let txnSeq = 0;

  const nextLawyer = (): number => {
    lawyerSeq += 1;
    return lawyerSeq;
  };
  const nextUser = (): number => {
    userSeq += 1;
    return userSeq;
  };

  // ---- 通用断言/驱动件（w4-acceptance/attendance.spec 同款手法） ----

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  /** relay 排空：tick 至 dispatched=0（无 handler 的机制 topic 进重试轨道不阻塞）；每轮 dead=0 */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 15; i += 1) {
      const tick = await relay.tick();
      expect(tick.dead).toBe(0);
      if (tick.dispatched === 0) return;
    }
    throw new Error('relay 十五轮未排空（级联链异常）');
  };

  /** platform.outbox 合成事件直投（presence 播种=D5 生产链的 outbox 事实源等价物） */
  const recordEvent = async (topic: string, payload: Record<string, unknown>): Promise<void> => {
    await poolSvc.withTransaction((uow) => outbox.recordOutbox(uow, { type: topic, payload }));
  };

  /** 律师全档播种：账号壳+角色+档案（PASSED，firm 绑定——RoomClosed/OneOnOneSettled 聚合锚）
   *  +A3b 商户行 ACTIVE（F3 R-07 分账前置） */
  const seedLawyerWithFirm = async (lawyerId: number): Promise<void> => {
    await seedUserShell(pool, `m2w4-lawyer-${lawyerId}`, lawyerId);
    await grantUserRoles(pool, lawyerId, ['user', 'lawyer']);
    await seedLawyerProfile(pool, lawyerId, 'PASSED', `m2w4-${lawyerId}`, undefined, FIRM_ID);
    await seedFirmMerchant(pool, FIRM_ID, 'ACTIVE');
  };

  /** PAID 报名+配对 F1 支付单（enroll/e{id}/pay 键）经 F1 真状态机推进至 PAID（CREATED→FROZEN→PAID） */
  const seedPaidSeat = async (
    sessionId: number,
    userId: number,
    cash: string,
    pointsAmount: number,
  ): Promise<{ enrollmentId: number; orderId: number }> => {
    const enrollmentId = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId,
      cash,
      points: pointsAmount,
      unitPrice: '100.00',
    });
    const orderId = await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(enrollmentId),
      bizId: enrollmentId,
      cash,
      points: pointsAmount,
    });
    await payment.markFrozen(orderId, `MOCK-WECHAT-M2W4-${orderId}`);
    await payment.markPaid(orderId);
    return { enrollmentId, orderId };
  };

  /** 独立 PAID 支付单（C 链前置待结算余额的 F1 单锚——settlement.consumer.spec 同款） */
  const createPaidOrder = async (cash: string): Promise<number> => {
    txnSeq += 1;
    const res = await payment.createOrder({
      biz_type: 'enroll',
      biz_id: 900_000 + txnSeq,
      cash_amount: cash,
      points_amount: 0,
      idempotency_key: `payment/m2w4-order-${txnSeq}/pay`,
    });
    await payment.markFrozen(res.payment_order.id, `MOCK-WECHAT-M2W4-P${txnSeq}`);
    await payment.markPaid(res.payment_order.id);
    return res.payment_order.id;
  };

  /** 经调度器真链开房（ROOM_OPEN 预写→priority tick）；返回房间行 */
  const openRoomViaScheduler = async (
    sessionId: number,
    slotStart: Date,
  ): Promise<{ id: number; grace_end: Date; status: string }> => {
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
    const res = await pool.query<{ id: string; grace_end: Date; status: string }>(
      `SELECT id, grace_end, status FROM fulfillment.rooms WHERE session_id = $1`,
      [sessionId],
    );
    const row = res.rows[0]!;
    return { id: Number(row.id), grace_end: row.grace_end, status: row.status };
  };

  /** presence join 事件播种（D5 生产链 outbox 直写；at=房间时刻锚） */
  const seedPresence = async (
    roomId: number,
    userId: number,
    role: 'user' | 'lawyer',
    at: Date,
  ): Promise<void> => {
    const convId = await roomConversationIdRaw(pool, roomId);
    expect(convId).not.toBeNull();
    await recordEvent(PRESENCE_JOINED_TOPIC, {
      conversation_id: convId!,
      ref_id: roomId,
      user_id: userId,
      role,
      at: at.toISOString(),
    } satisfies PresencePayload);
  };

  /** D2 提醒类 job 静默（REMIND_GRACE_END executor=notify 域——链内噪音隔离，D3 spec 同款） */
  const silenceReminders = (): Promise<void> => cancelPendingJobsByType(pool, ['REMIND_GRACE_END']);

  /** SETTLE_HOLD_RELEASE 时间注入（settlement 夹具回拨+I2 API 重注册过去时刻→tick 真通路） */
  const releaseHold = async (settlementId: number): Promise<void> => {
    await travelHoldCreated(pool, settlementId);
    const cancelled = await scheduler.cancelJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: settlementId,
    });
    expect(cancelled.cancelled).toBe(true);
    await scheduler.registerJob(pool, {
      jobType: 'SETTLE_HOLD_RELEASE',
      refType: 'settlement',
      refId: settlementId,
      dueAt: new Date(Date.now() - 1_000),
    });
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBe(1);
  };

  /** mock 通道回调驱动（F1 HMAC 真验签入口——PAY_SUCCESS/REFUND_SUCCESS） */
  const ingest = async (
    orderId: number,
    eventType: 'PAY_SUCCESS' | 'REFUND_SUCCESS',
    txnNo: string,
  ): Promise<void> => {
    const raw = Buffer.from(
      JSON.stringify({ order_id: orderId, event_type: eventType, channel_txn_no: txnNo }),
    );
    await payment.ingestCallback(
      'wechat_ecom',
      raw,
      createHmac('sha256', channelSecret).update(raw).digest('hex'),
    );
  };

  const paySuccess = async (orderId: number): Promise<void> => {
    txnSeq += 1;
    await ingest(orderId, 'PAY_SUCCESS', `MOCK-WECHAT-M2W4-${txnSeq}`);
    await drain();
  };

  const refundSuccess = async (orderId: number): Promise<void> => {
    txnSeq += 1;
    await ingest(orderId, 'REFUND_SUCCESS', `MOCK-WECHAT-M2W4-${txnSeq}R`);
    await drain();
  };

  /** credit.rules 种子（H7 免公示通道——A/B/C/D 链 G1 消费前置） */
  const seedCreditRules = async (): Promise<void> => {
    await poolSvc.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: CREDIT_RULES_SEED,
        effectiveAt: new Date(Date.now() - 24 * 60 * MIN),
      }),
    );
  };

  /** 订单的退款单（order-fixture 包装：断言面统一） */
  const refundOfOrder = async (orderId: number): Promise<Record<string, unknown> | undefined> => {
    const rows = await listRefundsByOrderId(pool, orderId);
    return rows[0];
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    llm = new CapturingLlmAdapter();
    const moduleRef = await Test.createTestingModule({
      // 全链装配（头注）：Fulfillment（D1/D3/D4/D5/D6+F2/F3/G1/H3/I2 消费者）+ C6/F4/I1 + H4 + E1
      imports: [FulfillmentModule, PricingChangeModule, MetricsModule, DraftModule],
    })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(LLM_ADAPTER)
      .useValue(llm)
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app)); // ConversationGateway（D5 WSS）init 前置
    await app.init(); // onModuleInit：全部消费者/执行器注册（topic 扇出并存）
    poolSvc = app.get(PgPoolService);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxRelayService);
    scheduler = app.get(SchedulerService);
    rtc = app.get(MockRtcProvider);
    rooms = app.get(RoomService);
    conversations = app.get(ConversationService);
    orders = app.get(OneOnOneService);
    payment = app.get(PaymentGatewayService);
    settlements = app.get(SettlementService);
    realname = app.get(RealnameService);
    rules = app.get(RuleCenterService);
    pricing = app.get(PricingConfigService);
    priceChanges = app.get(PriceChangeService);
    points = app.get(PointsService);
    coupons = app.get(CouponService);
    metrics = app.get(MetricsService);
    dispatcher = app.get(NotifyDispatcherService);
    drafts = app.get(DraftService);
    channelSecret = app.get(PAYMENT_CONFIG).primary.secret;
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

  // ===========================================================================
  // A. 链①缺席 70/30（链 1 履约段）：关房→判定补判→ABSENCE_7030→冻结期满→RUN 分账 70/30
  // ===========================================================================
  it('链①缺席 70/30：开房→job1 律师 NORMAL→律师关房（RoomClosed→F3 HOLD）→job2 用户 ABSENT→ABSENCE_7030→冻结期满释放→SETTLED+splits 70/30+F1 SPLIT+重放幂等', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedLawyerWithFirm(lawyer);
    const slotStart = new Date(Date.now() - 10 * MIN);
    sessionSeq += 1;
    const sessionId = await seedSessionAtRaw(pool, lawyer, 'CONFIRMED', slotStart, 'text');
    const seat = await seedPaidSeat(sessionId, user, '100.00', 0);

    const room = await openRoomViaScheduler(sessionId, slotStart);
    expect(room.status).toBe('OPEN');
    await seedPresence(room.id, lawyer, 'lawyer', new Date(room.grace_end.getTime() - 60_000));
    await silenceReminders();

    // job1（grace_end 快照）：律师在场→NORMAL；用户未进不判（job2 边界）；律师在场无用户→房间留 OPEN
    await scheduler.tick('normal');
    await drain();
    expect(await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC)).toHaveLength(1); // 仅律师 NORMAL
    expect((await attendanceRowsRaw(pool, room.id)).map((r) => r.status)).toEqual(['NORMAL']);

    // 律师提前关房（D1 close API 真链；⚠W2-10：判定与生命周期正交，用户缺席此后照常补判）
    await rooms.closeRoom(sessionId);
    await drain();
    const closed = await outboxPayloads(ROOM_CLOSED_TOPIC);
    expect(closed).toEqual([
      {
        session_id: sessionId,
        lawyer_id: lawyer,
        firm_id: FIRM_ID,
        gross: '100.00', // Σ(cash 分+points)=10000 分（D19 全额口径）
        payment_order_id: seat.orderId,
      },
    ]);
    // F3 进结算：PENDING→HOLD（R-02 冻结期）+ SETTLE_HOLD_RELEASE 预写
    let row = await settlementByRefRaw(pool, 'session', sessionId);
    expect(row).toMatchObject({
      gross: '100.00',
      net: '100.00',
      platform_fee: '0.00', // fee_versions 0%（V27 种子）
      status: 'HOLD',
      share_mode: 'FULL_TO_LAWYER', // 判定未达：建行缺省构成（标记位=job2 后）
    });
    const settlementId = await settlementIdByRefRaw(pool, 'session', sessionId);
    expect(settlementId).not.toBeNull();

    // job2（grace_end+15min）：用户 ABSENT 补判→AttendanceAdjudicated→F3 标记 ABSENCE_7030
    await backdateRoomJobsDue(pool, ['ABSENT_15M', 'NO_SHOW_CLOSE'], room.id);
    await scheduler.tick('normal');
    await drain();
    const adjudications = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(adjudications).toHaveLength(2);
    expect(adjudications[1]).toMatchObject({
      owner_type: 'user',
      owner_id: user,
      result: 'absent',
    });
    expect(await settlementByRefRaw(pool, 'session', sessionId)).toMatchObject({
      share_mode: 'ABSENCE_7030', // R-03 触发位
      status: 'HOLD',
    });
    // G1 联动（链内信用面）：律师 NORMAL=参与 0 分行（审计留痕）、用户缺席 -5 在册
    expect(await creditEventRowsRaw(pool, 'lawyer', lawyer)).toEqual([
      { action: 'lawyer_participated', delta: 0, ref_id: expect.any(String) },
    ]);
    expect(await creditEventRowsRaw(pool, 'user', user)).toEqual([
      { action: 'user_absent', delta: -5, ref_id: expect.any(String) },
    ]);

    // 冻结期满释放（时间注入）→ RUN 分账：SETTLED+SPLIT_SETTLED splits 70/30
    await releaseHold(settlementId!);
    await drain();
    row = await settlementByRefRaw(pool, 'session', sessionId);
    expect(row).toMatchObject({
      gross: '100.00',
      net: '100.00', // penalty=0：70/30 切分不改变净额（Σsplits=net 恒等）
      status: 'SETTLED',
      escrow_status: 'SPLIT',
      share_mode: 'ABSENCE_7030',
    });

    // splits 断言 70/30（律所 70% floor=70.00；平台备付 30%=30.00 尾差桶）
    const splits = await outboxPayloads(SPLIT_SETTLED_TOPIC);
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({
      settlement_id: settlementId,
      ref_type: 'session',
      ref_id: sessionId,
      net: '100.00',
      fee: '0.00',
    });
    expect(splits[0]!['splits']).toEqual([
      { payee_type: 'lawyer_firm', payee_id: FIRM_ID, amount: '70.00' },
      { payee_type: 'platform', payee_id: 0, amount: '30.00' },
    ]);
    // F1 账面：支付单 PAID→SPLIT（R-01 唯一解冻节点）+ SPLIT 指令流水一笔（金额=Σsplits）
    expect((await getPaymentOrderById(pool, seat.orderId))['status']).toBe('SPLIT');
    const splitLedgers = await listLedgersByDirection(pool, 'SPLIT');
    expect(splitLedgers).toHaveLength(1);
    expect(splitLedgers[0]).toMatchObject({ status: 'CONFIRMED', amount: '100.00' });
    expect((splitLedgers[0]!.detail as { splits: unknown[] })['splits']).toEqual([
      { payee_type: 'lawyer_firm', payee_id: FIRM_ID, amount: '70.00' },
      { payee_type: 'platform', payee_id: 0, amount: '30.00' },
    ]);

    // 重放幂等抽验：RoomClosed 重投→UNIQUE(ref) 短路不重建；分账指令恰一笔不双扣
    await recordEvent(ROOM_CLOSED_TOPIC, closed[0]! as Record<string, unknown>);
    await drain();
    expect(await settlementIdByRefRaw(pool, 'session', sessionId)).toBe(settlementId);
    expect(await listLedgersByDirection(pool, 'SPLIT')).toHaveLength(1);
  });

  it('链①真实时序（T2-B1 修复）：判定先于关房（主流时序）→job2 用户 ABSENT 在册→closeRoom→F3 回查建行 ABSENCE_7030→70/30 splits 终态+判定事件重放幂等（HOLD 态/SETTLED 态）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedLawyerWithFirm(lawyer);
    const slotStart = new Date(Date.now() - 10 * MIN);
    sessionSeq += 1;
    const sessionId = await seedSessionAtRaw(pool, lawyer, 'CONFIRMED', slotStart, 'text');
    const seat = await seedPaidSeat(sessionId, user, '100.00', 0);

    const room = await openRoomViaScheduler(sessionId, slotStart);
    await seedPresence(room.id, lawyer, 'lawyer', new Date(room.grace_end.getTime() - 60_000));
    await silenceReminders();

    // job1：律师 NORMAL（律师在场无用户→房间留 OPEN）
    await scheduler.tick('normal');
    await drain();
    expect((await attendanceRowsRaw(pool, room.id)).map((r) => r.status)).toEqual(['NORMAL']);

    // 真实主流时序（PRD §8.5：缺席处理→房间结束→结算）——判定先于关房：job2 补判用户 ABSENT
    await backdateRoomJobsDue(pool, ['ABSENT_15M', 'NO_SHOW_CLOSE'], room.id);
    await scheduler.tick('normal');
    await drain();
    const adjudications = await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC);
    expect(adjudications).toHaveLength(2);
    expect(adjudications[1]).toMatchObject({
      owner_type: 'user',
      owner_id: user,
      result: 'absent',
    });
    // 结算行未建（RoomClosed 未达）：AttendanceAdjudicated 先至 F3=NO_SETTLEMENT warn（不炸不静默）
    expect(await settlementIdByRefRaw(pool, 'session', sessionId)).toBeNull();

    // 服务结束关房（RoomClosed 后至）→ F3 回查 D3 缺席判定建行：ABSENCE_7030
    //（修复前=FULL_TO_LAWYER——70/30 标记丢失，T2-报告 §4 B-1 先红探针同形态）
    await rooms.closeRoom(sessionId);
    await drain();
    const settlementId = await settlementIdByRefRaw(pool, 'session', sessionId);
    expect(settlementId).not.toBeNull();
    expect(await settlementByRefRaw(pool, 'session', sessionId)).toMatchObject({
      status: 'HOLD',
      share_mode: 'ABSENCE_7030', // B-1 修复位：回查建行口径（与既有「关房先→判定后」标记路双覆盖）
    });

    // 判定事件重放（行已在+已 ABSENCE_7030）：markAbsenceShare 幂等 no-op（一行一构成不漂移）
    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, adjudications[1]! as Record<string, unknown>);
    await drain();
    expect(await settlementByRefRaw(pool, 'session', sessionId)).toMatchObject({
      status: 'HOLD',
      share_mode: 'ABSENCE_7030',
    });

    // 冻结期满释放→RUN：SETTLED+splits 70/30（先红探针转绿=B-1 收口证据）
    await releaseHold(settlementId!);
    await drain();
    expect(await settlementByRefRaw(pool, 'session', sessionId)).toMatchObject({
      gross: '100.00',
      net: '100.00',
      status: 'SETTLED',
      escrow_status: 'SPLIT',
      share_mode: 'ABSENCE_7030',
    });
    const splits = await outboxPayloads(SPLIT_SETTLED_TOPIC);
    expect(splits).toHaveLength(1);
    expect(splits[0]!['splits']).toEqual([
      { payee_type: 'lawyer_firm', payee_id: FIRM_ID, amount: '70.00' },
      { payee_type: 'platform', payee_id: 0, amount: '30.00' },
    ]);
    expect((await getPaymentOrderById(pool, seat.orderId))['status']).toBe('SPLIT');

    // 判定事件再重放（行已 SETTLED）：既有 warn 分支回归——不炸、不改账面、零新 splits
    await recordEvent(ATTENDANCE_ADJUDICATED_TOPIC, adjudications[1]! as Record<string, unknown>);
    await drain();
    expect(await settlementByRefRaw(pool, 'session', sessionId)).toMatchObject({
      status: 'SETTLED',
      share_mode: 'ABSENCE_7030',
    });
    expect(await outboxPayloads(SPLIT_SETTLED_TOPIC)).toHaveLength(1);
    expect(await listLedgersByDirection(pool, 'SPLIT')).toHaveLength(1);
  });

  // ===========================================================================
  // B. 链⑤无人到场退款：全员缺席→平台取消兜底链→全额退款×2+零结算行+D4 缺席联动
  // ===========================================================================
  it('链⑤无人到场退款：双方均未到场→job1 全员 ABSENT+room CANCELLED(no_show)+SessionCancelled(platform)→F2 全额退款×2 DONE（含积分还原）+零结算行+律师缺席联动（50% 赔付保证金腿+G1）+NO_SHOW_CLOSE 幂等', async () => {
    const lawyer = nextLawyer();
    const u1 = nextUser();
    const u2 = nextUser();
    await seedLawyerWithFirm(lawyer);
    const slotStart = new Date(Date.now() - 10 * MIN);
    sessionSeq += 1;
    const sessionId = await seedSessionAtRaw(pool, lawyer, 'CONFIRMED', slotStart, 'text');
    const seat1 = await seedPaidSeat(sessionId, u1, '100.00', 0);
    const seat2 = await seedPaidSeat(sessionId, u2, '50.00', 2000);

    const room = await openRoomViaScheduler(sessionId, slotStart);
    await silenceReminders();

    // job1：全员缺席（律师+两用户）→平台取消路径（room CANCELLED+SessionCancelled(platform)）
    await scheduler.tick('normal');
    await drain();

    const roomRow = await pool.query<{ status: string }>(
      `SELECT status FROM fulfillment.rooms WHERE id = $1`,
      [room.id],
    );
    expect(roomRow.rows[0]!.status).toBe('CANCELLED');
    expect((await attendanceRowsRaw(pool, room.id)).map((r) => r.status)).toEqual([
      'ABSENT',
      'ABSENT',
      'ABSENT',
    ]); // 律师+u1+u2（user_id 升序：律师号段<用户号段）
    const cancelled = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      session_id: sessionId,
      cancelled_by: 'platform',
      cancelled_by_user_id: null,
    });

    // F2 全额退款×2（CANCEL_RULE 档）→REFUND_SUCCESS 回调→DONE+积分还原
    const r1 = (await refundOfOrder(seat1.orderId))!;
    expect(r1).toMatchObject({
      user_id: u1,
      cash_amount: '100.00',
      points_amount: 0,
      reason: 'CANCEL_RULE',
      status: 'PROCESSING',
    });
    const r2 = (await refundOfOrder(seat2.orderId))!;
    expect(r2).toMatchObject({
      user_id: u2,
      cash_amount: '50.00',
      points_amount: 2000,
      reason: 'CANCEL_RULE',
      status: 'PROCESSING',
    });
    await refundSuccess(seat1.orderId);
    await refundSuccess(seat2.orderId);
    expect((await refundOfOrder(seat1.orderId))!['status']).toBe('DONE');
    expect((await refundOfOrder(seat2.orderId))!['status']).toBe('DONE');
    expect(await outboxPayloads(REFUND_COMPLETED_TOPIC)).toHaveLength(2);
    expect(await getPointsAccount(pool, u2)).toEqual({ balance: 2000, frozen: 0 }); // R-03 积分还原

    // 结算出口：无人到场=平台取消，room CANCELLED 无 RoomClosed→零结算行（「全退+无结算」口径）
    expect(await settlementIdByRefRaw(pool, 'session', sessionId)).toBeNull();

    // D4 缺席联动（PRD §8.6 律师缺席=宽限期未进场，含此形态）：50%×session_total=50.00
    // 走保证金专户（无待结算余额）+收据恰一张；G1 lawyer_absent -50 + 两用户 user_absent
    const deducts = (await listLedgersByDirection(pool, 'DEDUCT')).filter(
      (l) => l.status === 'CONFIRMED',
    );
    expect(deducts).toHaveLength(1);
    expect(deducts[0]).toMatchObject({ amount: '50.00' });
    expect(deducts[0]!.detail).toMatchObject({ from: 'deposit', lawyer_id: lawyer });
    expect(await penaltyReceiptsRaw(pool)).toEqual([
      { penalty_key: `penalty/session-${sessionId}/lawyer-absence`, amount: '50.00' },
    ]);
    expect(await creditEventRowsRaw(pool, 'lawyer', lawyer)).toEqual([
      { action: 'lawyer_absent', delta: -50, ref_id: expect.any(String) },
    ]);
    const userEvents = [
      ...(await creditEventRowsRaw(pool, 'user', u1)),
      ...(await creditEventRowsRaw(pool, 'user', u2)),
    ];
    expect(userEvents.map((e) => e.action)).toEqual(['user_absent', 'user_absent']);

    // NO_SHOW_CLOSE 兜底 job 到期：room 已 CANCELLED→recheck=false→CANCELLED 无操作零新事件
    await backdateRoomJobsDue(pool, ['NO_SHOW_CLOSE', 'ABSENT_15M'], room.id);
    const ticked = await scheduler.tick('normal');
    expect(ticked.cancelled).toBeGreaterThanOrEqual(2);
    await drain();
    expect(await outboxPayloads(SESSION_CANCELLED_TOPIC)).toHaveLength(1);
    expect(await outboxPayloads(ATTENDANCE_ADJUDICATED_TOPIC)).toHaveLength(3);
  });

  // ===========================================================================
  // C. 链④律师违约金扣减：律师缺席→F3 applyPenalty 待结算摊扣+保证金专户补足+退款+G1
  // ===========================================================================
  it('链④律师违约金扣减：前置待结算余额 20→job2 律师 ABSENT→D4 终止+50% 赔付（settlement 腿 20 FIFO 摊扣+deposit 腿 30 补足）→F1 双腿 DEDUCT 流水+收据+deduction_detail→F2 全退 DONE+G1 -50', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedLawyerWithFirm(lawyer);
    // 前置待结算余额：另一场次结算行 HOLD net=20.00（penalty FIFO 摊扣第一腿的事实源）
    const priorOrderId = await createPaidOrder('20.00');
    await settlements.enterSettlement({
      ref_type: 'session',
      ref_id: 990_001,
      lawyer_id: lawyer,
      firm_id: FIRM_ID,
      gross: '20.00',
      payment_order_id: priorOrderId,
    });

    const slotStart = new Date(Date.now() - 10 * MIN);
    sessionSeq += 1;
    const sessionId = await seedSessionAtRaw(pool, lawyer, 'CONFIRMED', slotStart, 'text');
    const seat = await seedPaidSeat(sessionId, user, '100.00', 0);

    const room = await openRoomViaScheduler(sessionId, slotStart);
    await seedPresence(room.id, user, 'user', new Date(room.grace_end.getTime() - 60_000));
    await silenceReminders();

    // job1：用户在场→NORMAL；律师未进不判（job2 边界）——房间留 OPEN（律师不在场）
    await scheduler.tick('normal');
    await drain();
    expect((await attendanceRowsRaw(pool, room.id)).map((r) => r.status)).toEqual(['NORMAL']);

    // job2：律师 ABSENT→D4 律师缺席分支（自动终止+50% 赔付）
    await backdateRoomJobsDue(pool, ['ABSENT_15M'], room.id);
    await scheduler.tick('normal');
    await drain();

    // 场次/房间终止+SessionCancelled(platform)（裁定-1：G1 零双计路径）
    const roomRow = await pool.query<{ status: string }>(
      `SELECT status FROM fulfillment.rooms WHERE id = $1`,
      [room.id],
    );
    expect(roomRow.rows[0]!.status).toBe('CANCELLED');
    const cancelled = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      session_id: sessionId,
      cancelled_by: 'platform',
      cancelled_by_user_id: null,
    });

    // F3 applyPenalty（50%×session_total=50.00）：待结算 20（FIFO 摊扣）+保证金专户 30 补足
    const deducts = (await listLedgersByDirection(pool, 'DEDUCT')).filter(
      (l) => l.status === 'CONFIRMED',
    );
    expect(deducts.map((l) => ({ from: l.detail?.['from'], amount: l.amount }))).toEqual([
      { from: 'settlement', amount: '20.00' },
      { from: 'deposit', amount: '30.00' },
    ]); // R-04 扣减顺序两腿（F1 /pay/deduct from=settlement→deposit 流水断言）
    expect(await settlementByRefRaw(pool, 'session', 990_001)).toMatchObject({
      gross: '20.00',
      penalty: '20.00', // FIFO 吃满
      net: '0.00',
      status: 'HOLD',
    });
    const detail = (await deductionDetailByRefRaw(pool, 'session', 990_001))!;
    expect(detail).toMatchObject({
      amount: '50.00',
      idempotency_key: `penalty/session-${sessionId}/lawyer-absence`,
      debt: '0.00',
    });
    expect(
      (detail['items'] as { leg: string; amount: string; status: string }[]).map((i) => ({
        leg: i.leg,
        amount: i.amount,
        status: i.status,
      })),
    ).toEqual([
      { leg: 'settlement', amount: '20.00', status: 'CONFIRMED' },
      { leg: 'deposit', amount: '30.00', status: 'CONFIRMED' },
    ]);
    // 幂等收据恰一张（penalty/ 域键+金额）
    expect(await penaltyReceiptsRaw(pool)).toEqual([
      { penalty_key: `penalty/session-${sessionId}/lawyer-absence`, amount: '50.00' },
    ]);

    // F2 关联退款：全额 CANCEL_RULE→REFUND_SUCCESS→DONE
    const refund = (await refundOfOrder(seat.orderId))!;
    expect(refund).toMatchObject({
      cash_amount: '100.00',
      points_amount: 0,
      reason: 'CANCEL_RULE',
      status: 'PROCESSING',
    });
    await refundSuccess(seat.orderId);
    expect((await refundOfOrder(seat.orderId))!['status']).toBe('DONE');

    // G1 信用事件在册：律师 -50（缺席档）；用户 NORMAL=参与 0 分行（审计留痕）
    expect(await creditEventRowsRaw(pool, 'lawyer', lawyer)).toEqual([
      { action: 'lawyer_absent', delta: -50, ref_id: expect.any(String) },
    ]);
    expect(await creditEventRowsRaw(pool, 'user', user)).toEqual([
      { action: 'user_participated', delta: 0, ref_id: expect.any(String) },
    ]);
  });

  // ===========================================================================
  // D. 链③改价补偿发放（链 3 补偿段补验）：B3→C6 降>10%→审批→F4 积分/券+I1 话术
  // ===========================================================================
  it('链③改价补偿：B3 v1→在团降 20%（GT10）→PENDING_APPROVAL→approve→EFFECTED→F4 积分 2000 直发+券账面 ACTIVE+I1 话术 SENT（PRICE_DOWN_BIG）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedLawyerWithFirm(lawyer);

    // B3 v1（per_head 100.00）
    await pricing.putPricing(lawyer, {
      base_version: 0,
      per_head: '100.00',
      session_total: null,
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
      one_on_one_prices: B3_ONE_ON_ONE,
    });
    // 在团：活跃场次+PAID 报名（补偿对象=paid 全额 10000 分）
    sessionSeq += 1;
    await seedSessionRaw(pool, lawyer, 'CREATED', sessionSeq, {
      userId: user,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });

    // C6 改价（DOWN 20%>10%→在团审批档）
    const requested = await priceChanges.requestChange(lawyer, {
      base_version: 1,
      per_head: '80.00',
      session_total: null,
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
      one_on_one_prices: B3_ONE_ON_ONE,
    });
    expect(requested.result).toBe('PENDING_APPROVAL');
    const historyId = requested.history_id as number;

    // 审批通过→EFFECTED（①期人工兜底）
    const approved = await priceChanges.approve(historyId, { approved: true, approval_id: 1 });
    expect(approved).toMatchObject({ result: 'EFFECTED', approval_source: 'MANUAL' });
    expect((await outboxPayloads(PRICE_CHANGE_APPROVED_TOPIC)).at(-1)).toMatchObject({
      kind: 'PRICE_DOWN_GT10',
      lawyer_id: lawyer,
    });

    // F4 积分直发（#39 收口=生效事务内联）：(100−80)×10000/10000=2000 分
    expect((await points.getMine(user)).balance).toBe(2000);
    const granted = await outboxPayloads(POINTS_GRANTED_TOPIC);
    expect(granted.at(-1)).toMatchObject({ user_id: user, kind: 'COMPENSATION', delta: 2000 });

    // 券指令→CouponInstructionConsumer 真消费→券账面（PRICE_COMP 定义=V43 种子 50 元/90 天）
    await drain();
    const instructed = await outboxPayloads(PRICE_COUPON_INSTRUCTED_TOPIC);
    expect(instructed).toEqual([
      {
        price_change_id: historyId,
        lawyer_id: lawyer,
        user_id: user,
        coupon_kind: 'PRICE_COMP',
      },
    ]);
    const mineCoupons = await coupons.listMine(user);
    expect(mineCoupons).toHaveLength(1);
    expect(mineCoupons[0]).toMatchObject({ status: 'ACTIVE', face_value: '50.00' });

    // I1 话术（GT10 档=PRICE_DOWN_BIG）：dispatcher 真链下发 SENT
    await dispatcher.processPending();
    const notifications = await listNotificationsRaw(pool, user, 'PRICE_DOWN_BIG');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.status).toBe('SENT');

    // G1 联动在册（M1 已覆盖引用面）：-30+SUSPEND_TAKE_3D
    expect(await creditEventRowsRaw(pool, 'lawyer', lawyer)).toEqual([
      { action: 'lawyer_price_down_gt10', delta: -30, ref_id: String(historyId) },
    ]);
    expect(await restrictionRowsRaw(pool, 'lawyer', lawyer)).toEqual([
      { kind: 'SUSPEND_TAKE_3D', reason: 'action:lawyer_price_down_gt10' },
    ]);
  });

  // ===========================================================================
  // E. 链1 D6 段·1对1 实结多退少补（含 T1 净额闭合面：settlements.gross 列=净额构成基）
  // ===========================================================================
  /** E 链公共播种：律师（B3 1v1 矩阵+firm 绑定）+实名用户+房间锚（seedRoomRaw） */
  const seedOooParties = async (): Promise<{ lawyer: number; user: number; roomId: number }> => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedLawyerWithFirm(lawyer);
    const current = await pricing.getCurrentPricing(lawyer);
    await pricing.putPricing(lawyer, {
      base_version: current.version,
      per_head: '100.00',
      session_total: null,
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
      one_on_one_prices: B3_ONE_ON_ONE,
    });
    await realname.submitRealname(user, { name: '周壹', idNo: VALID_ID_NO });
    sessionSeq += 1;
    const sessionId = await seedSessionAtRaw(
      pool,
      lawyer,
      'FINISHED',
      new Date(Date.now() - 60 * MIN),
    );
    const roomId = await seedRoomRaw(pool, sessionId);
    return { lawyer, user, roomId };
  };

  it('E-多退路：voice 预付 100→接单→0 信标计量→实结 40（<预付）→F2 SETTLE_REFUND 退差 60 DONE+F3 settlements.gross=40（net 构成基，T1 换基）', async () => {
    const { lawyer, user, roomId } = await seedOooParties();
    const created = await orders.create({
      room_id: roomId,
      service_type: 'deep_answer',
      mode: 'voice',
      user_id: user,
    });
    expect(created.order.prepaid).toBe('100.00'); // voice=1 个 15min 起付
    await paySuccess(created.payment_order.id);
    expect((await outboxPayloads(ONE_ON_ONE_PAID_TOPIC)).at(-1)).toMatchObject({
      order_id: created.order.id,
      user_id: user,
      lawyer_id: lawyer,
    });
    await orders.accept(created.order.id, { actorLawyerId: lawyer });
    expect((await outboxPayloads(ONE_ON_ONE_ACCEPTED_TOPIC)).at(-1)).toMatchObject({
      order_id: created.order.id,
    });
    await orders.recordDuration(created.order.id, 0); // 0 信标：IN_SERVICE+consumed=0
    await orders.finish(created.order.id, 0, { actorLawyerId: lawyer });
    expect((await outboxPayloads(ONE_ON_ONE_FINISHED_TOPIC)).at(-1)).toMatchObject({
      order_id: created.order.id,
    });

    // 实结双确认 40.00<prepaid 100.00 → 多退：SETTLED+OneOnOneSettled{gross=100,net=40}
    await orders.settleConfirm(
      created.order.id,
      { role: 'user', settle_amount: '40.00' },
      { actorUserId: user },
    );
    const done = await orders.settleConfirm(
      created.order.id,
      { role: 'lawyer', settle_amount: '40.00' },
      { actorUserId: lawyer },
    );
    expect(done.status).toBe('SETTLED');
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({
      order_id: created.order.id,
      lawyer_id: lawyer,
      firm_id: FIRM_ID,
      gross: '100.00', // 预付参考（载荷语义）
      net: '40.00', // 实结净额
      payment_order_id: created.payment_order.id,
    });

    // F2 退差：SETTLE_REFUND 恰一张（100−40=60.00）→REFUND_SUCCESS→DONE
    const refund = (await refundOfOrder(created.payment_order.id))!;
    expect(refund).toMatchObject({
      cash_amount: '60.00',
      points_amount: 0,
      reason: 'SETTLE_REFUND',
      status: 'PROCESSING',
    });
    await refundSuccess(created.payment_order.id);
    expect((await refundOfOrder(created.payment_order.id))!['status']).toBe('DONE');

    // F3 结算行（T1 换基断言）：gross 列=构成基=net=40.00（非 prepaid 100）
    expect(await settlementByRefRaw(pool, 'one_on_one', created.order.id)).toMatchObject({
      gross: '40.00',
      net: '40.00',
      platform_fee: '0.00',
      status: 'HOLD',
    });
  });

  it('E-少补路：text 预付 50→2 轮计量→实结 100（>预付）→补差单 50→settle-diff/pay→PAY_SUCCESS→SETTLED+F3 settlements.gross=100（=prepaid+diff 构成基）', async () => {
    const { lawyer, user, roomId } = await seedOooParties();
    const created = await orders.create({
      room_id: roomId,
      service_type: 'deep_answer',
      mode: 'text',
      user_id: user,
    });
    expect(created.order.prepaid).toBe('50.00'); // text=1 轮起付
    await paySuccess(created.payment_order.id);
    await orders.accept(created.order.id, { actorLawyerId: lawyer });

    // 计量注入：2 轮（用户问+律师答×2——MessageSent→D6 消费真链轮次重算；ooo 会话锚）
    const oooConv = await pool.query<{ id: string }>(
      `SELECT id FROM fulfillment.conversations WHERE type = 'one_on_one' AND ref_id = $1`,
      [created.order.id],
    );
    const convId = Number(oooConv.rows[0]!.id);
    for (let i = 0; i < 2; i += 1) {
      await conversations.sendMessage({
        conversationId: convId,
        senderId: user,
        senderRole: 'user',
        content: `少补链第 ${i + 1} 问`,
        mention: 'lawyer',
      });
      await drain();
      await conversations.sendMessage({
        conversationId: convId,
        senderId: lawyer,
        senderRole: 'lawyer',
        content: `少补链第 ${i + 1} 答`,
      });
      await drain();
    }
    await orders.finish(created.order.id, undefined, { actorLawyerId: lawyer });
    const orderRow = await pool.query<{ consumed_units: number; status: string }>(
      `SELECT consumed_units, status FROM fulfillment.one_on_one_orders WHERE id = $1`,
      [created.order.id],
    );
    expect(orderRow.rows[0]).toMatchObject({ consumed_units: 2, status: 'FINISHED' });

    // 实结 100.00>prepaid 50.00 → 少补：DIFF_PENDING+补差单（未确认不扣款）
    await orders.settleConfirm(
      created.order.id,
      { role: 'user', settle_amount: '100.00' },
      { actorUserId: user },
    );
    const done = await orders.settleConfirm(
      created.order.id,
      { role: 'lawyer', settle_amount: '100.00' },
      { actorUserId: lawyer },
    );
    expect(done.status).toBe('DIFF_PENDING');
    expect((await outboxPayloads(ONE_ON_ONE_DIFF_PENDING_TOPIC)).at(-1)).toMatchObject({
      order_id: created.order.id,
      user_id: user,
      diff_amount: '50.00',
    });
    const pay = await orders.settleDiffPay(created.order.id, { actorUserId: user });
    expect(pay.diff_payment_order).toMatchObject({ cash_amount: '50.00', status: 'CREATED' });

    // 补差支付（PAY_SUCCESS 真回调）→DIFF_PENDING→SETTLED+OneOnOneSettled{net=100}
    await paySuccess(pay.diff_payment_order.id);
    const rowAfter = await pool.query<{ status: string; settle_amount: string }>(
      `SELECT status, settle_amount::text AS settle_amount FROM fulfillment.one_on_one_orders WHERE id = $1`,
      [created.order.id],
    );
    expect(rowAfter.rows[0]).toMatchObject({ status: 'SETTLED', settle_amount: '100.00' });
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({
      order_id: created.order.id,
      gross: '50.00', // 预付参考
      net: '100.00', // 实结净额（prepaid+diff 实收）
    });

    // F3 结算行（T1 换基断言）：gross 列=构成基=net=100.00（=prepaid 50+diff 50）
    expect(await settlementByRefRaw(pool, 'one_on_one', created.order.id)).toMatchObject({
      gross: '100.00',
      net: '100.00',
      platform_fee: '0.00',
      status: 'HOLD',
    });
  });

  // ===========================================================================
  // F. 链⑥律师缺席前置校验（开房 job 校验分支）：RTC 失败→平台取消链→全退+零判定零信用
  // ===========================================================================
  it('链⑥律师缺席前置校验：RTC 开房失败注入→room CANCELLED(open_fail_reason)+RoomOpenFailed→D4 平台取消→F2 全额退款 DONE；零宽限 job 预写/零判定行/零信用事件（D3 R-04）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedLawyerWithFirm(lawyer);
    const slotStart = new Date(Date.now() - 2_000);
    sessionSeq += 1;
    const sessionId = await seedSessionAtRaw(pool, lawyer, 'CONFIRMED', slotStart, 'text');
    const seat = await seedPaidSeat(sessionId, user, '100.00', 0);

    rtc.failNextRoom('RTC_CHANNEL_DOWN');
    const room = await openRoomViaScheduler(sessionId, slotStart);
    expect(room.status).toBe('CANCELLED');
    const roomRow = await pool.query<{ open_fail_reason: string | null }>(
      `SELECT open_fail_reason FROM fulfillment.rooms WHERE id = $1`,
      [room.id],
    );
    expect(roomRow.rows[0]!.open_fail_reason).toBe('RTC_CHANNEL_DOWN');
    expect(await outboxPayloads(ROOM_OPEN_FAILED_TOPIC)).toEqual([
      { session_id: sessionId, reason: 'RTC_CHANNEL_DOWN' },
    ]);

    // 开房校验分支账面：失败行零宽限语义——GRACE_END/ABSENT_15M/NO_SHOW_CLOSE/REMIND 零预写
    for (const jobType of ['GRACE_END', 'ABSENT_15M', 'NO_SHOW_CLOSE', 'REMIND_GRACE_END']) {
      expect(await listJobsByType(pool, jobType)).toHaveLength(0);
    }

    // D4 平台取消（RoomOpenFailed 消费）→SessionCancelled(platform)→F2 全额退款
    await drain();
    const cancelled = await outboxPayloads(SESSION_CANCELLED_TOPIC);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ session_id: sessionId, cancelled_by: 'platform' });
    const refund = (await refundOfOrder(seat.orderId))!;
    expect(refund).toMatchObject({
      cash_amount: '100.00',
      reason: 'CANCEL_RULE',
      status: 'PROCESSING',
    });
    await refundSuccess(seat.orderId);
    expect((await refundOfOrder(seat.orderId))!['status']).toBe('DONE');

    // 律师缺席前置校验（R-04）：零判定行+双 owner 零信用事件（平台故障不扣律师）
    expect(await attendanceRowsRaw(pool, room.id)).toEqual([]);
    expect(await creditEventRowsRaw(pool, 'lawyer', lawyer)).toEqual([]);
    expect(await creditEventRowsRaw(pool, 'user', user)).toEqual([]);
    // 零结算出口（无 RoomClosed）
    expect(await settlementIdByRefRaw(pool, 'session', sessionId)).toBeNull();
  });

  // ===========================================================================
  // H. 链5 AI 辅助贯通：消息→E1 草稿（mock LLM）→律师 send→D5 落律师消息→H4 采用率可查
  // ===========================================================================
  it('链5 AI 辅助贯通：用户消息→E1 草稿（脱敏进 LLM 载荷）→律师 action(send) 经 D5 真链落律师消息→DraftActioned→H4 采用率聚合可查（draft_adoption_rate=1）', async () => {
    const lawyer = nextLawyer();
    const user = nextUser();
    await seedLawyerWithFirm(lawyer);
    // 房间+会话锚（draft.spec 同款：session+room 直插+room 会话）
    sessionSeq += 1;
    const sessionId = await seedSessionAtRaw(pool, lawyer, 'OPEN', new Date(Date.now() + 60 * MIN));
    const roomId = await seedRoomRaw(pool, sessionId);
    const conversation = await conversations.ensureConversation('room', roomId);
    const convId = conversation.conversation_id;
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: user,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });

    // 用户提问（含 PII——脱敏层 R-02 抽检锚）→MessageSent→E1 管线→草稿 PENDING
    await conversations.sendMessage({
      conversationId: convId,
      senderId: user,
      senderRole: 'user',
      content: '我叫周梅，手机 138 0013 8000，公司拖欠三个月工资该怎么办？',
    });
    await drain();
    const draftRows = await draftRowsRaw(pool, { roomId });
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]!['status']).toBe('PENDING');
    expect(String(draftRows[0]!['content'])).toContain('【AI 辅助，仅供参考】'); // R-04 标记
    // mock LLM 载荷抽检：进入 LLM 的为脱敏后文本（PII 铁律）
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.questionDigest).not.toContain('138 0013 8000');
    expect(llm.calls[0]!.questionDigest).toContain('[电话');
    expect(await outboxPayloads(DRAFT_GENERATED_TOPIC)).toHaveLength(1);

    // 律师 action(send)→经 D5 sendMessage 真链落律师消息→DraftActioned
    const draftId = Number(draftRows[0]!['id']);
    const actioned = await drafts.action(draftId, lawyer, { action: 'send' });
    expect(actioned).toMatchObject({ draft_id: draftId, status: 'SENT', deduplicated: false });
    const messages = await conversationMessagesRaw(pool, convId);
    expect(messages.at(-1)).toMatchObject({ sender_role: 'lawyer', risk_flag: 'PASS' });
    expect(String(messages.at(-1)!.content)).toContain('【AI 辅助，仅供参考】'); // 消息=草稿正文
    expect(await outboxPayloads(DRAFT_ACTIONED_TOPIC)).toEqual([
      expect.objectContaining({ draft_id: draftId, room_id: roomId, action: 'send' }),
    ]);

    // H4 采用率聚合可查（dev 实时口径：draft.generated/actioned 事件流→metrics_daily→查询面）
    await drain();
    const res = await metrics.getMetrics({ group: 'core' });
    const adoption = res.metrics.find((m) => m.key === 'draft_adoption_rate');
    expect(adoption).toBeDefined();
    expect(adoption!['value']).toBe(1); // 1 生成/1 采用（send 计分子，本链恰一稿一采）
  });
});
