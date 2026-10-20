import 'reflect-metadata';
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { Pool } from 'pg';
import {
  ErrorCode,
  MESSAGE_SENT_TOPIC,
  ONE_ON_ONE_ACCEPTED_TOPIC,
  ONE_ON_ONE_DIFF_PENDING_TOPIC,
  ONE_ON_ONE_DIFF_UNPAID_TOPIC,
  ONE_ON_ONE_FINISHED_TOPIC,
  ONE_ON_ONE_LAWYER_TIMEOUT_TOPIC,
  ONE_ON_ONE_PAID_TOPIC,
  ONE_ON_ONE_SETTLED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { RealnameService } from '../identity/realname.service';
import { seedLawyerProfile } from '../identity/lawyer-fixture';
import { SchedulerService } from '../schedule/scheduler.service';
import { backdateRoomJobsDue, jobStatusRaw } from '../schedule/job-fixture';
import { creditEventRowsRaw } from '../credit/credit-fixture';
import { RuleCenterService } from '../ops/rule-center.service';
import { PAYMENT_CONFIG } from '../payment/payment.config';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { RefundService } from '../payment/refund.service';
import {
  countLedgersByKey,
  getPaymentOrderByKey,
  listRefundsByOrderId,
} from '../payment/order-fixture';
import { PricingConfigService } from '../pricing/pricing.service';
import { countSettlementsByRef } from '../settlement/settlement-fixture';
import { seedSessionAtRaw } from '../trade/trade-fixture';
import { FulfillmentModule } from './fulfillment.module';
import { ConversationService } from './conversation.service';
import { OneOnOneService } from './one-on-one.service';
import { oooRowRaw, seedRoomRaw, setOooAcceptDeadline } from './one-on-one-fixture';
import { oooDiffKey, oooPayKey } from './one-on-one.types';

/**
 * D6 1对1 服务闭环领域集成（需 PG；M2-W3 T2——§4 状态机 + §7 R-01~R-05 + §9 TDD 清单 +
 * §10 验收全项）：真链驱动——下单经 OneOnOneService（F1 同事务建单）、支付经 F1
 * ingestCallback（HMAC 真验签）→ relay.tick 扇出（本模块守卫消费器 + D5 建会话 + F2/F3/G1/
 * H4 各消费器）、超时/默认确认/补差超时经 scheduler.tick 执行器。覆盖：
 *   闸口（402 REALNAME/400 PRICE_MISSING/404 房间）/下单幂等（同 user+room+type 重放原单）/
 *   PAY_SUCCESS 收敛（PAID+accept_deadline=paid_at+30min+OneOnOnePaid 出箱+OOO_ACCEPT_TIMEOUT
 *   预写+D5 建会话）/重放不双推进/接单超时边界（deadline±1s 两侧）/executor 超时全退全链
 *   （LAWYER_TIMEOUT→F2 OOO_TIMEOUT 受理→REFUND_SUCCESS→REFUNDED）/text 计量（首条用户消息
 *   锚+轮次重算幂等）/voice 计量（1s/15m/15m01s 向上取整+单调上界幂等+0 信标）/finish 声明
 *   回执（advisory 不阻塞）/实结双方确认（一致 SETTLED+OneOnOneSettled 逐字/F3 结算行落位/
 *   不一致 409 MISMATCH/同角色同额幂等）/多退（SETTLE_REFUND 指令+REFUND_PARTIAL→SETTLED）/
 *   少补（补差单未确认不扣款+DIFF_PENDING+15min 未付按比例结算+G1 信用+15min 内支付 SETTLED）/
 *   30min 默认确认（时间注入）/取消三档（①全退②按轮实结③首单位半价/≥1 封顶）。
 */
const VALID_ID_NO = '11010519491231002X'; // A2 mock 通道：GB11643 校验位合法 → VERIFIED
const FIRM_ID = 8801;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** B3 矩阵种（text 50/轮、voice+video 100/15min——断言金额锚） */
const B3_ONE_ON_ONE = {
  text: { per_round: '50.00' },
  voice: { per_15min: '100.00' },
  video: { per_15min: '100.00' },
};

/** G1 credit.rules 种子（diff_unpaid 档=user_cancel_early -5——W3-11 对齐既有档位） */
const CREDIT_RULES_SEED: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: { user_cancel_early: { delta: -5, violation: true } },
};

describe('D6 1对1 服务闭环（下单/支付/接单/计量/实结/取消三档/超时，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let orders: OneOnOneService;
  let conversations: ConversationService;
  let gateway: PaymentGatewayService;
  let pricing: PricingConfigService;
  let realname: RealnameService;
  let rules: RuleCenterService;
  let scheduler: SchedulerService;
  let relay: OutboxRelayService;
  let poolSvc: PgPoolService;
  let outbox: OutboxService;
  let channelSecret: string;
  let userSeq = 6700;
  let lawyerSeq = 9500;
  let txnSeq = 0;

  const nextUser = (): number => {
    userSeq += 1;
    return userSeq;
  };
  const nextLawyer = (): number => {
    lawyerSeq += 1;
    return lawyerSeq;
  };

  // ---- 播种 ----

  const seedUser = async (userId: number): Promise<void> => {
    await realname.submitRealname(userId, { name: '张三', idNo: VALID_ID_NO });
  };

  const seedLawyer = async (lawyerId: number): Promise<void> => {
    await seedLawyerProfile(pool, lawyerId, 'PASSED', `ooo-${lawyerId}`, '110100', FIRM_ID);
    const current = await pricing.getCurrentPricing(lawyerId);
    await pricing.putPricing(lawyerId, {
      base_version: current.version,
      per_head: '100.00', // B3 R-01：计价模式二选一非空（本 spec 断言锚=one_on_one 矩阵）
      session_total: null,
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
      one_on_one_prices: B3_ONE_ON_ONE,
    });
  };

  /** 房间锚（session 直插 + room 直插——开房全链归 D1 spec；场次取已结束态） */
  const seedRoom = async (lawyerId: number): Promise<number> => {
    const sessionId = await seedSessionAtRaw(
      pool,
      lawyerId,
      'FINISHED',
      new Date(Date.now() - 3_600_000),
    );
    return seedRoomRaw(pool, sessionId);
  };

  const createOrder = (
    userId: number,
    roomId: number,
    mode: 'text' | 'voice' | 'video' = 'text',
    serviceType: 'deep_answer' | 'doc_revision' | 'strategy' = 'deep_answer',
  ) => orders.create({ room_id: roomId, service_type: serviceType, mode, user_id: userId });

  // ---- 驱动 ----

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

  const paySuccess = async (paymentOrderId: number): Promise<void> => {
    txnSeq += 1;
    await ingest(paymentOrderId, 'PAY_SUCCESS', `MOCK-WECHAT-T6-${txnSeq}`);
    await relay.tick(); // PaymentCallbackInboxed → F1 FROZEN + 订单 PAID + OneOnOnePaid 出箱
    await relay.tick(); // OneOnOnePaid → D5 建会话（conversation 落位）
  };

  const refundSuccess = async (paymentOrderId: number): Promise<void> => {
    txnSeq += 1;
    await ingest(paymentOrderId, 'REFUND_SUCCESS', `MOCK-WECHAT-T6-${txnSeq}`);
    await relay.tick(); // 收敛 DONE + RefundCompleted 出箱
    await relay.tick(); // RefundCompleted → D6 终态收敛
  };

  const sendMessage = (
    conversationId: number,
    senderId: number,
    role: 'user' | 'lawyer',
    content: string,
  ) =>
    conversations.sendMessage({
      conversationId,
      senderId,
      senderRole: role,
      content,
      ...(role === 'user' ? { mention: 'lawyer' as const } : {}),
    });

  const oooConversationId = async (orderId: number): Promise<number> => {
    const res = await pool.query<{ id: string }>(
      `SELECT id FROM fulfillment.conversations WHERE type = 'one_on_one' AND ref_id = $1`,
      [orderId],
    );
    const row = res.rows[0];
    return row === undefined ? 0 : Number(row.id);
  };

  // ---- 断言夹具（跨域读一律经 owner 夹具：payment/schedule/credit/settlement 表名禁内联，
  //      schema-refs 纪律；本域表+平台横切表直读合法） ----

  const oooRow = (orderId: number) => oooRowRaw(pool, orderId);

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY event_id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  /** 幂等键定位退款行（listRefundsByOrderId 全量后按键筛） */
  const refundsOfKey = async (paymentOrderId: number, key: string) => {
    const rows = await listRefundsByOrderId(pool, paymentOrderId);
    return rows.find((r) => r['idempotency_key'] === key);
  };

  const creditEventOf = async (ownerId: number, refId: number) => {
    const rows = await creditEventRowsRaw(pool, 'user', ownerId);
    return rows.find((r) => r.ref_id === String(refId));
  };

  const paymentOrderOfKey = async (key: string) => getPaymentOrderByKey(pool, key);

  const dueJobsNow = (orderId: number, types: readonly string[]) =>
    backdateRoomJobsDue(pool, types, orderId);

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [FulfillmentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init(); // onModuleInit：D6 消费器/执行器 + F2/F3/G1/H4 扇出注册
    orders = app.get(OneOnOneService);
    conversations = app.get(ConversationService);
    gateway = app.get(PaymentGatewayService);
    pricing = app.get(PricingConfigService);
    realname = app.get(RealnameService);
    rules = app.get(RuleCenterService);
    scheduler = app.get(SchedulerService);
    relay = app.get(OutboxRelayService);
    poolSvc = app.get(PgPoolService);
    outbox = app.get(OutboxService);
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
  // 闸口与下单（§5 POST /one-on-one）
  // ===========================================================================

  it('闸口：未实名 402 E_REALNAME_REQUIRED；B3 矩阵缺配 400 E_PRICE_MISSING；房间缺失 404', async () => {
    const lawyer = nextLawyer();
    const roomId = await seedRoom(lawyer);
    const noRealname = nextUser();
    await expect(createOrder(noRealname, roomId)).rejects.toMatchObject({
      code: ErrorCode.RealnameRequired,
      httpStatus: 402,
    });

    const user = nextUser();
    await seedUser(user);
    const noPricingLawyer = nextLawyer();
    const noPricingRoom = await seedRoom(noPricingLawyer);
    await expect(createOrder(user, noPricingRoom)).rejects.toMatchObject({
      code: ErrorCode.PriceMissing,
      httpStatus: 400,
    });

    await expect(createOrder(user, 999_999)).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('下单：CREATED+F1 同事务建单（键 ooo/o{id}/pay，金额=prepaid=1 单位）；幂等键=user+room+type 重放原单（不双建）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const roomId = await seedRoom(lawyer);
    const user = nextUser();
    await seedUser(user);

    const created = await createOrder(user, roomId, 'voice');
    expect(created.order.status).toBe('CREATED');
    expect(created.order.unit_price).toBe('100.00');
    expect(created.order.prepaid).toBe('100.00'); // 1 单位起付（voice=1 个 15min）
    expect(created.payment_order.cash_amount).toBe('100.00');
    const po = await paymentOrderOfKey(oooPayKey(created.order.id));
    expect(po).toBeDefined();
    expect(po!['biz_type']).toBe('ooo');

    const replay = await createOrder(user, roomId, 'voice');
    expect(replay.deduplicated).toBe(true);
    expect(replay.order.id).toBe(created.order.id);
    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.one_on_one_orders`,
    );
    expect(count.rows[0]!.n).toBe(1);

    // 异 service_type 不撞幂等键（活跃唯一=room+user+type 三键）
    const other = await createOrder(user, roomId, 'voice', 'strategy');
    expect(other.order.id).not.toBe(created.order.id);
  });

  // ===========================================================================
  // 支付收敛（PAY_SUCCESS → PAID + 接单锅 + OneOnOnePaid + D5 建会话）
  // ===========================================================================

  it('PAY_SUCCESS 收敛：PAID+accept_deadline=paid_at+30min+OneOnOnePaid 出箱+OOO_ACCEPT_TIMEOUT 预写+D5 建会话；重放不双推进', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const roomId = await seedRoom(lawyer);
    const user = nextUser();
    await seedUser(user);
    const created = await createOrder(user, roomId);
    const id = created.order.id;

    await paySuccess(created.payment_order.id);

    const row = (await oooRow(id))!;
    expect(row['status']).toBe('PAID');
    const deadline = row['accept_deadline'] as Date;
    expect(deadline).not.toBeNull();
    expect(deadline.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000); // ≈paid_at+30min
    const paid = await outboxPayloads(ONE_ON_ONE_PAID_TOPIC);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ order_id: id, user_id: user, lawyer_id: lawyer });
    expect(await jobStatusRaw(pool, 'OOO_ACCEPT_TIMEOUT', 'one_on_one', id)).toBe('PENDING');
    expect(await oooConversationId(id)).toBeGreaterThan(0); // D5 消费建会话（订单 conversation_id 列=accept/消息面回填 W3-13）

    // 重放：同 channel_txn_no 二次投递 inboxed=false，零新事件零状态漂移
    await paySuccess(created.payment_order.id).catch(() => undefined); // 二次 ingest 同 txn → 去重
    expect(await outboxPayloads(ONE_ON_ONE_PAID_TOPIC)).toHaveLength(1);
    expect((await oooRow(id))!['status']).toBe('PAID');
  });

  // ===========================================================================
  // 接单与超时边界（N±1s 两侧 + executor 全链）
  // ===========================================================================

  it('接单：PAID→ACCEPTED+conversation 回填+OneOnOneAccepted；deadline-1s 放行 / deadline+1s 409 E_ACCEPT_TIMEOUT', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId);
    const id = created.order.id;
    await paySuccess(created.payment_order.id);

    // N-1s 侧：deadline 拨到未来 10s → 放行
    await setOooAcceptDeadline(pool, id, new Date(Date.now() + 10_000));
    const accepted = await orders.accept(id, { actorLawyerId: lawyer });
    expect(accepted.conversation_id).toBe(await oooConversationId(id)); // W3-13 回填
    expect((await oooRow(id))!['status']).toBe('ACCEPTED');
    expect((await oooRow(id))!['conversation_id']).not.toBeNull();
    const events = await outboxPayloads(ONE_ON_ONE_ACCEPTED_TOPIC);
    expect(events).toHaveLength(1);
    // 重复接单=幂等重放（幂等键=order）
    const again = await orders.accept(id, { actorLawyerId: lawyer });
    expect(again.deduplicated).toBe(true);
    // 归属越权 403
    await expect(orders.accept(id, { actorLawyerId: lawyer + 1 })).rejects.toMatchObject({
      code: ErrorCode.RoleForbidden,
    });

    // N+1s 侧：另一单 deadline 已过 → 409
    const created2 = await createOrder(user, await seedRoom(lawyer), 'text', 'strategy');
    await paySuccess(created2.payment_order.id);
    await setOooAcceptDeadline(pool, created2.order.id, new Date(Date.now() - 1_000));
    await expect(orders.accept(created2.order.id, { actorLawyerId: lawyer })).rejects.toMatchObject(
      {
        code: ErrorCode.AcceptTimeout,
        httpStatus: 409,
      },
    );
  });

  it('接单超时 executor 全链：PAID→LAWYER_TIMEOUT+事件（含 payment_order_id）→F2 OOO_TIMEOUT 全额受理→REFUND_SUCCESS→REFUNDED；重放幂等', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId);
    const id = created.order.id;
    await paySuccess(created.payment_order.id);

    await dueJobsNow(id, ['OOO_ACCEPT_TIMEOUT']);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(1);
    expect((await oooRow(id))!['status']).toBe('LAWYER_TIMEOUT');

    const timeoutEvents = await outboxPayloads(ONE_ON_ONE_LAWYER_TIMEOUT_TOPIC);
    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0]).toMatchObject({
      order_id: id,
      user_id: user,
      payment_order_id: created.payment_order.id,
    });

    await relay.tick(); // F2 消费 → OOO_TIMEOUT 全额受理
    const refund = (await refundsOfKey(
      created.payment_order.id,
      `refund/po-${created.payment_order.id}/ooo-timeout`,
    ))!;
    expect(refund).toBeDefined();
    expect(refund['reason']).toBe('OOO_TIMEOUT');
    expect(refund['cash_amount']).toBe('50.00');
    expect(refund['status']).not.toBe('FAILED');

    await refundSuccess(created.payment_order.id);
    expect((await oooRow(id))!['status']).toBe('REFUNDED');
    // 事件重放幂等：重投 LAWYER_TIMEOUT 事件 → F2 受理幂等短路（refund 单数不变）
    await relay.tick();
    expect((await listRefundsByOrderId(pool, created.payment_order.id)).length).toBe(1);
  });

  // ===========================================================================
  // text 计量（W3-8 锚 + 轮次重算幂等）
  // ===========================================================================

  it('text 计量：accept 后首条用户消息触发 IN_SERVICE（started_at）；用户问+律师答=1 轮（consumed_units）；消息事件重放不双计', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId, 'text');
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });
    const convId = await oooConversationId(id);
    expect(convId).toBeGreaterThan(0);

    // 用户首问（mention=lawyer）→ relay 消费 → IN_SERVICE
    const q1 = await sendMessage(convId, user, 'user', '赔偿金怎么算？');
    await relay.tick(); // MessageSent → D6 计量消费
    let row = (await oooRow(id))!;
    expect(row['status']).toBe('IN_SERVICE');
    expect(row['started_at']).not.toBeNull();
    expect(row['consumed_units']).toBe(0); // 问出未答=未完成轮次

    // 律师答 → 1 轮完成
    await sendMessage(convId, lawyer, 'lawyer', '按 N 月工资计算……');
    await relay.tick();
    row = (await oooRow(id))!;
    expect(row['consumed_units']).toBe(1);

    // 第二轮
    await sendMessage(convId, user, 'user', '仲裁时效呢？');
    await sendMessage(convId, lawyer, 'lawyer', '一年。');
    await relay.tick();
    await relay.tick();
    expect((await oooRow(id))!['consumed_units']).toBe(2);

    // 事件重放幂等：同 seq MessageSent 再投一轮 → consumed 不变（确定性重算）
    await poolSvc.withTransaction((uow: SqlExecutor) =>
      outbox.recordOutbox(uow, {
        type: MESSAGE_SENT_TOPIC,
        payload: { conversation_id: convId, seq: q1.seq, risk_flag: 'PASS' },
      }),
    );
    await relay.tick();
    expect((await oooRow(id))!['consumed_units']).toBe(2);
  });

  // ===========================================================================
  // voice 计量（向上取整 + 单调上界幂等）
  // ===========================================================================

  it('voice 计量：1s→1 段/15m→1 段/15m01s→2 段（向上取整）；首次回调触发 IN_SERVICE；重复/乱序回调单调上界不重复计数；text 拒时长回调', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);

    const a = await createOrder(user, await seedRoom(lawyer), 'voice');
    await paySuccess(a.payment_order.id);
    await orders.accept(a.order.id, { actorLawyerId: lawyer });

    const first = await orders.recordDuration(a.order.id, 1); // 1s → 1 段
    expect(first.segments).toBe(1);
    expect(first.in_service_triggered).toBe(true); // W3-8：voice 锚=首次时长回调
    expect(first.order.consumed_units).toBe(1);
    expect((await oooRow(a.order.id))!['started_at']).not.toBeNull();

    const exact = await orders.recordDuration(a.order.id, 900); // 15m → 1 段
    expect(exact.segments).toBe(1);
    expect(exact.order.consumed_units).toBe(1);
    const over = await orders.recordDuration(a.order.id, 901); // 15m01s → 2 段
    expect(over.segments).toBe(2);
    expect(over.order.consumed_units).toBe(2);

    // 乱序/重复回调：单调上界（重复投 1s/900s 不降不重复计）
    const dup = await orders.recordDuration(a.order.id, 1);
    expect(dup.order.consumed_units).toBe(2);
    const dup2 = await orders.recordDuration(a.order.id, 900);
    expect(dup2.order.consumed_units).toBe(2);

    // text 模式拒时长回调（400）
    const t = await createOrder(user, await seedRoom(lawyer), 'text', 'strategy');
    await paySuccess(t.payment_order.id);
    await orders.accept(t.order.id, { actorLawyerId: lawyer });
    await expect(orders.recordDuration(t.order.id, 60)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
  });

  // ===========================================================================
  // finish（声明回执 advisory）与实结双方确认
  // ===========================================================================

  /** 走到 IN_SERVICE 的 text 单（rounds 轮=系统计量；finish/confirm 由用例驱动） */
  const inServiceTextOrder = async (
    rounds: number,
  ): Promise<{
    orderId: number;
    userId: number;
    lawyerId: number;
    convId: number;
  }> => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId, 'text');
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });
    const convId = await oooConversationId(id);
    for (let i = 0; i < rounds; i += 1) {
      await sendMessage(convId, user, 'user', `问题 ${i + 1}`);
      await sendMessage(convId, lawyer, 'lawyer', `回答 ${i + 1}`);
      await relay.tick();
    }
    return { orderId: id, userId: user, lawyerId: lawyer, convId };
  };

  /** 走到 FINISHED 的 text 单（rounds 轮=系统计量；finish 无声明=纯系统计量） */
  const finishedTextOrder = async (rounds: number) => {
    const ctx = await inServiceTextOrder(rounds);
    await orders.finish(ctx.orderId, undefined, { actorLawyerId: ctx.lawyerId });
    return ctx;
  };

  it('finish：IN_SERVICE→FINISHED+settle_deadline+OOO_SETTLE_DEFAULT 预写+OneOnOneFinished；声明≠系统计量→advisory 不阻塞不采信；重复 finish 409', async () => {
    const { orderId, userId, lawyerId } = await inServiceTextOrder(1); // settle=50=prepaid

    const finished = await orders.finish(orderId, 99, { actorLawyerId: lawyerId }); // 虚报 99 轮
    expect(finished.order.status).toBe('FINISHED');
    expect(finished.order.consumed_units).toBe(1); // 系统计量事实源（W3-15）
    expect(finished.advisory).toMatchObject({ declared: 99, system: 1, matches: false });
    const events = await outboxPayloads(ONE_ON_ONE_FINISHED_TOPIC);
    expect(events.at(-1)).toMatchObject({
      order_id: orderId,
      consumed_units: 1,
      settle_amount: '50.00', // 暂估=unit_price×consumed
      user_id: userId,
    });
    const row = (await oooRow(orderId))!;
    expect(row['settle_deadline']).not.toBeNull();
    expect(await jobStatusRaw(pool, 'OOO_SETTLE_DEFAULT', 'one_on_one', orderId)).toBe('PENDING');

    await expect(
      orders.finish(orderId, undefined, { actorLawyerId: lawyerId }),
    ).rejects.toMatchObject({
      code: ErrorCode.NotInService,
      httpStatus: 409,
    });
  });

  it('实结双方确认：一致→SETTLED+OneOnOneSettled（gross=prepaid/net=实结/lawyer/firm/payment_order 逐字）+F3 结算行；不一致 409 MISMATCH；同角色同额幂等/异额 409', async () => {
    const { orderId, userId, lawyerId } = await finishedTextOrder(1); // 系统计量 settle=50.00=prepaid

    const first = await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '50.00' },
      { actorUserId: userId },
    );
    expect(first.status).toBe('SETTLING');
    expect((await oooRow(orderId))!['settle_amount']).toBe('50.00');

    // 同角色同额=幂等重放；异额=409（不可翻改自己的确认）
    const replay = await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '50.00' },
      { actorUserId: userId },
    );
    expect(replay.status).toBe('SETTLING');
    expect(replay.deduplicated).toBe(true);
    await expect(
      orders.settleConfirm(
        orderId,
        { role: 'user', settle_amount: '60.00' },
        { actorUserId: userId },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SettleMismatch, httpStatus: 409 });

    // 另一方不一致 → 409 MISMATCH（仍 SETTLING）
    await expect(
      orders.settleConfirm(
        orderId,
        { role: 'lawyer', settle_amount: '60.00' },
        { actorUserId: lawyerId },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SettleMismatch, httpStatus: 409 });
    expect((await oooRow(orderId))!['status']).toBe('SETTLING');

    // 一致 → SETTLED + OneOnOneSettled 出箱（F3 既有契约逐字）
    const second = await orders.settleConfirm(
      orderId,
      { role: 'lawyer', settle_amount: '50.00' },
      { actorUserId: lawyerId },
    );
    expect(second.status).toBe('SETTLED');
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({
      order_id: orderId,
      lawyer_id: lawyerId,
      firm_id: FIRM_ID,
      gross: '50.00',
      net: '50.00',
      payment_order_id: expect.any(Number),
    });
    await relay.tick(); // F3 消费 → 结算行落位（ref=(one_on_one, order)）
    expect(await countSettlementsByRef(pool, 'one_on_one', orderId)).toBe(1);

    // SETTLED 后同额确认=幂等回执；异额=409（事后翻供不允许）
    const after = await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '50.00' },
      { actorUserId: userId },
    );
    expect(after.status).toBe('SETTLED');
    expect(after.deduplicated).toBe(true);
    await expect(
      orders.settleConfirm(
        orderId,
        { role: 'user', settle_amount: '51.00' },
        { actorUserId: userId },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SettleMismatch });
  });

  it('真链两端到端（W1 遗留②补验=M2-W3 T3 桩转正锚）：真订单 create→PAY_SUCCESS→真 OneOnOnePaid→D5 落 one_on_one 会话→accept 回填→消息计量→finish→双确认→真 OneOnOneSettled→settlement 消费落行（两端消费面零改动）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);

    // ---- 一端（OneOnOnePaid 真生产→D5 消费）：真订单支付链，零合成事件直投 ----
    const created = await createOrder(user, roomId, 'text');
    const id = created.order.id;
    await paySuccess(created.payment_order.id); // ingest+两轮 relay（FROZEN→PAID→出箱→D5 建会话）
    const paid = await outboxPayloads(ONE_ON_ONE_PAID_TOPIC);
    expect(paid).toEqual([{ order_id: id, user_id: user, lawyer_id: lawyer }]); // 服务生产，非 spec 直投
    const convId = await oooConversationId(id);
    expect(convId).toBeGreaterThan(0); // D5 既有消费面零改动落位
    // #43 联动：会话成员=订单双方（user 读回正向）
    await expect(
      conversations.listMessages({ conversationId: convId, asUserId: user }),
    ).resolves.toHaveLength(0);

    // ---- 主链推进：accept（W3-13 回填）→首问 IN_SERVICE→答 1 轮→finish ----
    const accepted = await orders.accept(id, { actorLawyerId: lawyer });
    expect(accepted.conversation_id).toBe(convId);
    expect((await oooRow(id))!['conversation_id']).not.toBeNull();
    await sendMessage(convId, user, 'user', '真链端到端：首问');
    await relay.tick();
    await sendMessage(convId, lawyer, 'lawyer', '真链端到端：答');
    await relay.tick();
    expect((await oooRow(id))!['status']).toBe('IN_SERVICE');
    await orders.finish(id, undefined, { actorLawyerId: lawyer });

    // ---- 另一端（OneOnOneSettled 真生产→F3 消费）：双确认一致→结算行落位 ----
    await orders.settleConfirm(id, { role: 'user', settle_amount: '50.00' }, { actorUserId: user });
    const done = await orders.settleConfirm(
      id,
      { role: 'lawyer', settle_amount: '50.00' },
      { actorUserId: lawyer },
    );
    expect(done.status).toBe('SETTLED');
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled).toEqual([
      {
        order_id: id,
        lawyer_id: lawyer,
        firm_id: FIRM_ID,
        gross: '50.00',
        net: '50.00',
        payment_order_id: created.payment_order.id,
      },
    ]); // 服务生产（emitSettled），非 spec 直投
    await relay.tick(); // F3 既有消费面零改动 → settlements 行落位
    expect(await countSettlementsByRef(pool, 'one_on_one', id)).toBe(1);
  });

  it('实结多退：双方确认值<prepaid→F2 SETTLE_REFUND 受理（退差）→REFUND_PARTIAL→SETTLED+OneOnOneSettled（net=实结）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId, 'voice'); // prepaid=100
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });
    await orders.recordDuration(id, 0); // 0 信标：IN_SERVICE + consumed=0（半价取消锚同款状态）
    await orders.finish(id, 0, { actorLawyerId: lawyer });

    await orders.settleConfirm(id, { role: 'user', settle_amount: '40.00' }, { actorUserId: user });
    const done = await orders.settleConfirm(
      id,
      { role: 'lawyer', settle_amount: '40.00' },
      { actorUserId: lawyer },
    );
    expect(done.status).toBe('SETTLED');

    const refund = (await refundsOfKey(
      created.payment_order.id,
      `refund/po-${created.payment_order.id}/ooo-settle`,
    ))!;
    expect(refund).toBeDefined();
    expect(refund['reason']).toBe('SETTLE_REFUND');
    expect(refund['cash_amount']).toBe('60.00'); // prepaid 100 − 实结 40
    const row = (await oooRow(id))!;
    expect(row['refund_amount']).toBe('60.00');
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({ order_id: id, gross: '100.00', net: '40.00' });
  });

  // ===========================================================================
  // 少补/补差（未确认不扣款 / 15min 未付按比例结算+G1 / 15min 内支付 SETTLED）
  // ===========================================================================

  it('少补：实结>预付生成补差单且未确认不扣款（F1 CREATED 无扣款痕迹）；settle-diff/pay 非挂起态 409 NOT_CONFIRMED', async () => {
    const { orderId, userId, lawyerId } = await finishedTextOrder(2); // settle=100 > prepaid=50

    await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '100.00' },
      { actorUserId: userId },
    );
    const done = await orders.settleConfirm(
      orderId,
      { role: 'lawyer', settle_amount: '100.00' },
      { actorUserId: lawyerId },
    );
    expect(done.status).toBe('DIFF_PENDING'); // 少补挂起（补差支付后 SETTLED）
    const row = (await oooRow(orderId))!;
    expect(row['status']).toBe('DIFF_PENDING');
    expect(row['diff_order_id']).not.toBeNull();

    const diffPo = (await paymentOrderOfKey(oooDiffKey(orderId)))!;
    expect(diffPo).toBeDefined();
    expect(diffPo['biz_type']).toBe('ooo_diff');
    expect(diffPo['cash_amount']).toBe('50.00');
    expect(diffPo['status']).toBe('CREATED'); // 未确认不扣款（R-02 禁无密扣款）
    // 无任何针对用户的扣款流水（diff 单未支付零分账/扣减）
    expect(await countLedgersByKey(pool, oooDiffKey(orderId))).toBe(0); // 零流水=零扣款

    const pending = await outboxPayloads(ONE_ON_ONE_DIFF_PENDING_TOPIC);
    expect(pending.at(-1)).toMatchObject({
      order_id: orderId,
      user_id: userId,
      diff_amount: '50.00',
    });
    expect(await jobStatusRaw(pool, 'DIFF_PAY_TIMEOUT', 'one_on_one', orderId)).toBe('PENDING');

    // settle-diff/pay：DIFF_PENDING 可取支付参数（幂等键=order）；非挂起态 409
    const pay = await orders.settleDiffPay(orderId, { actorUserId: userId });
    expect(pay.diff_payment_order.idempotency_key).toBe(oooDiffKey(orderId));
    await expect(orders.settleDiffPay(orderId, { actorUserId: lawyerId })).rejects.toMatchObject({
      code: ErrorCode.RoleForbidden,
    });
    const other = await createOrder(userId, await seedRoom(lawyerId));
    await expect(
      orders.settleDiffPay(other.order.id, { actorUserId: userId }),
    ).rejects.toMatchObject({
      code: ErrorCode.NotConfirmed,
      httpStatus: 409,
    });
  });

  it('补差 15min 内支付：PAY_SUCCESS 收敛 DIFF_PENDING→SETTLED+OneOnOneSettled（net=实结）；超时 job 事后触发=幂等无操作', async () => {
    const { orderId, userId, lawyerId } = await finishedTextOrder(2); // settle=100
    await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '100.00' },
      { actorUserId: userId },
    );
    await orders.settleConfirm(
      orderId,
      { role: 'lawyer', settle_amount: '100.00' },
      { actorUserId: lawyerId },
    );
    const pay = await orders.settleDiffPay(orderId, { actorUserId: userId });

    await paySuccess(pay.diff_payment_order.id); // 补差 PAY_SUCCESS → markFrozen+SETTLED+事件
    const row = (await oooRow(orderId))!;
    expect(row['status']).toBe('SETTLED');
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({ order_id: orderId, net: '100.00' });

    // 补差超时 job 迟到：recheck=非 DIFF_PENDING → 无操作（不重复结算不重复出箱）
    const before = (await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC)).length;
    await dueJobsNow(orderId, ['DIFF_PAY_TIMEOUT']);
    await scheduler.tick('normal');
    expect((await oooRow(orderId))!['status']).toBe('SETTLED');
    expect((await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC)).length).toBe(before);
  });

  it('补差 15min 未付：executor 按已服务比例结算（settle=prepaid）+OneOnOneDiffUnpaid→G1 信用（W3-11 档=user_cancel_early -5）', async () => {
    // G1 规则种子（credit.rules 生效版——emit 的档位事实源）
    await poolSvc.withTransaction((uow: SqlExecutor) =>
      rules.createLexiconVersion(uow, {
        ruleKey: 'credit.rules',
        version: 1,
        content: CREDIT_RULES_SEED,
        effectiveAt: new Date(Date.now() - 86_400_000),
      }),
    );
    const { orderId, userId, lawyerId } = await finishedTextOrder(2); // settle=100 > prepaid=50
    await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '100.00' },
      { actorUserId: userId },
    );
    await orders.settleConfirm(
      orderId,
      { role: 'lawyer', settle_amount: '100.00' },
      { actorUserId: lawyerId },
    );
    expect((await oooRow(orderId))!['status']).toBe('DIFF_PENDING');

    await dueJobsNow(orderId, ['DIFF_PAY_TIMEOUT']);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(1);
    const row = (await oooRow(orderId))!;
    expect(row['status']).toBe('SETTLED');
    expect(row['settle_amount']).toBe('50.00'); // 按已服务比例结算=net 收敛 prepaid
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({ order_id: orderId, net: '50.00' });

    const unpaid = await outboxPayloads(ONE_ON_ONE_DIFF_UNPAID_TOPIC);
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).toMatchObject({ order_id: orderId, user_id: userId });

    await relay.tick(); // G1 消费 → 信用入账（W3-11：对齐既有 user_cancel_early -5 档）
    const credit = await creditEventOf(userId, orderId);
    expect(credit).toBeDefined();
    expect(credit!['action']).toBe('user_cancel_early');
    expect(credit!['delta']).toBe(-5);
    // 事件重放幂等：G1 uq_credit_events_idem 短路（重投零新流水）
    await relay.tick();
    expect((await creditEventRowsRaw(pool, 'user', userId)).length).toBe(1);
  });

  // ===========================================================================
  // 30min 默认确认（时间注入）
  // ===========================================================================

  it('30min 默认确认（D9）：FINISHED 双方未确认→executor 以系统计量值结算→SETTLED+OneOnOneSettled（net=unit×consumed）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId, 'voice');
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });
    await orders.recordDuration(id, 901); // consumed=2 → 系统计量 settle=200
    await orders.finish(id, undefined, { actorLawyerId: lawyer });

    await dueJobsNow(id, ['OOO_SETTLE_DEFAULT']);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(1);
    const row = (await oooRow(id))!;
    expect(row['status']).toBe('DIFF_PENDING'); // 实结 200 > prepaid 100 → 少补挂起（默认确认同结算动作）
    expect(row['settle_amount']).toBe('200.00');
    expect(row['diff_order_id']).not.toBeNull();

    // SETTLING 半默认：首方已录、30min 无另一方 → executor 以已录值补默认结算
    const { orderId: id2, userId: u2, lawyerId: l2 } = await finishedTextOrder(1); // settle=50=prepaid
    await orders.settleConfirm(id2, { role: 'user', settle_amount: '50.00' }, { actorUserId: u2 });
    await dueJobsNow(id2, ['OOO_SETTLE_DEFAULT']);
    await scheduler.tick('normal');
    expect((await oooRow(id2))!['status']).toBe('SETTLED');
    const settled2 = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled2.at(-1)).toMatchObject({ order_id: id2, net: '50.00' });
    expect(l2).toBeGreaterThan(0);
  });

  // ===========================================================================
  // 取消三档（R-03）
  // ===========================================================================

  it('取消①：IN_SERVICE 前（PAID/ACCEPTED）全退——OOO_CANCEL 键全额受理→REFUNDED；终态再取消=幂等回执；LAWYER_TIMEOUT 轨道 409', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const paid = await createOrder(user, roomId);
    await paySuccess(paid.payment_order.id);

    const cancelled = await orders.cancel(paid.order.id, { role: 'user', actorUserId: user });
    expect(cancelled.order.status).toBe('REFUNDED');
    expect(cancelled.refund.kind).toBe('FULL');
    expect(cancelled.refund.amount).toBe('50.00');
    const refund = (await refundsOfKey(
      paid.payment_order.id,
      `refund/po-${paid.payment_order.id}/ooo-cancel`,
    ))!;
    expect(refund).toBeDefined();
    expect(refund['cash_amount']).toBe('50.00');

    // 终态重取消=幂等回执（deduplicated）
    const again = await orders.cancel(paid.order.id, { role: 'user', actorUserId: user });
    expect(again.deduplicated).toBe(true);

    // ACCEPTED 档同①：接单后开始前全退
    const accepted = await createOrder(user, await seedRoom(lawyer), 'text', 'strategy');
    await paySuccess(accepted.payment_order.id);
    await orders.accept(accepted.order.id, { actorLawyerId: lawyer });
    const cancelled2 = await orders.cancel(accepted.order.id, {
      role: 'lawyer',
      actorUserId: lawyer,
    });
    expect(cancelled2.order.status).toBe('REFUNDED');
    expect(cancelled2.refund.kind).toBe('FULL');

    // 接单超时轨道（非取消轨道）终态 → 409 NOT_CANCELLABLE
    const timedOut = await createOrder(user, await seedRoom(lawyer), 'text', 'doc_revision');
    await paySuccess(timedOut.payment_order.id);
    await dueJobsNow(timedOut.order.id, ['OOO_ACCEPT_TIMEOUT']);
    await scheduler.tick('normal');
    expect((await oooRow(timedOut.order.id))!['status']).toBe('LAWYER_TIMEOUT');
    await expect(
      orders.cancel(timedOut.order.id, { role: 'user', actorUserId: user }),
    ).rejects.toMatchObject({ code: ErrorCode.NotCancellable, httpStatus: 409 });

    // 归属越权 403
    const other = await createOrder(user, await seedRoom(lawyer), 'text');
    await paySuccess(other.payment_order.id);
    await expect(
      orders.cancel(other.order.id, { role: 'user', actorUserId: user + 1 }),
    ).rejects.toMatchObject({ code: ErrorCode.RoleForbidden });
  });

  it('取消②：text 开始后按已完成轮次实结（settle=单价×轮次）退差——1 轮 settle=prepaid 退 0（PARTIAL_REFUNDED/NONE）', async () => {
    const { orderId, userId } = await (async () => {
      const lawyer = nextLawyer();
      await seedLawyer(lawyer);
      const user = nextUser();
      await seedUser(user);
      const roomId = await seedRoom(lawyer);
      const created = await createOrder(user, roomId, 'text');
      const id = created.order.id;
      await paySuccess(created.payment_order.id);
      await orders.accept(id, { actorLawyerId: lawyer });
      const convId = await oooConversationId(id);
      await sendMessage(convId, user, 'user', '问');
      await sendMessage(convId, lawyer, 'lawyer', '答');
      await relay.tick();
      return { orderId: id, userId: user };
    })();

    const cancelled = await orders.cancel(orderId, { role: 'user', actorUserId: userId });
    expect(cancelled.order.status).toBe('PARTIAL_REFUNDED');
    expect(cancelled.refund.kind).toBe('NONE'); // settle=50×1=prepaid → 退 0
    expect(cancelled.order.refund_amount).toBe('0.00');
    // 零退款=不落退款指令（同单不可两键全退——accept 守恒入口约束的取消侧口径）
    const poId = Number((await oooRow(orderId))!['payment_order_id']);
    expect(await refundsOfKey(poId, `refund/po-${poId}/ooo-cancel`)).toBeUndefined();
    expect(await refundsOfKey(poId, `refund/po-${poId}/ooo-cancel-partial`)).toBeUndefined();
  });

  it('取消③：voice consumed=0（未满首个 15min）收 1 单位 50% 退其余（部分键）；consumed≥1 实结封顶 prepaid（NONE）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);

    // consumed=0：0 信标触发 IN_SERVICE → 半价首单位
    const zero = await createOrder(user, await seedRoom(lawyer), 'voice'); // prepaid=100
    await paySuccess(zero.payment_order.id);
    await orders.accept(zero.order.id, { actorLawyerId: lawyer });
    await orders.recordDuration(zero.order.id, 0); // 开启信标：IN_SERVICE+consumed=0
    const cancelledZero = await orders.cancel(zero.order.id, { role: 'user', actorUserId: user });
    expect(cancelledZero.order.status).toBe('PARTIAL_REFUNDED');
    expect(cancelledZero.refund.kind).toBe('PARTIAL');
    expect(cancelledZero.refund.amount).toBe('50.00'); // 退 100−⌊100/2⌋
    const partial = (await refundsOfKey(
      zero.payment_order.id,
      `refund/po-${zero.payment_order.id}/ooo-cancel-partial`,
    ))!;
    expect(partial).toBeDefined();
    expect(partial['cash_amount']).toBe('50.00');
    expect(partial['reason']).toBe('OOO_CANCEL');

    // consumed=2（901s）：settle=200 封顶 prepaid=100 → 退 0（取消无补差出边——类注口径）
    const over = await createOrder(user, await seedRoom(lawyer), 'voice', 'strategy');
    await paySuccess(over.payment_order.id);
    await orders.accept(over.order.id, { actorLawyerId: lawyer });
    await orders.recordDuration(over.order.id, 901);
    const cancelledOver = await orders.cancel(over.order.id, { role: 'user', actorUserId: user });
    expect(cancelledOver.order.status).toBe('PARTIAL_REFUNDED');
    expect(cancelledOver.refund.kind).toBe('NONE');
    expect(cancelledOver.refund.amount).toBe('0.00');
  });

  it('取消②边界：text 开始后 0 完成轮次（仅用户问未答）=服务未交付全退（FULL 键）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId, 'text');
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });
    const convId = await oooConversationId(id);
    await sendMessage(convId, user, 'user', '问了但还没被回答');
    await relay.tick();
    expect((await oooRow(id))!['status']).toBe('IN_SERVICE');
    expect((await oooRow(id))!['consumed_units']).toBe(0);

    const cancelled = await orders.cancel(id, { role: 'user', actorUserId: user });
    expect(cancelled.order.status).toBe('REFUNDED');
    expect(cancelled.refund.kind).toBe('FULL'); // settle=0 → 全退键
    expect(
      await refundsOfKey(
        created.payment_order.id,
        `refund/po-${created.payment_order.id}/ooo-cancel`,
      ),
    ).toBeDefined();
  });

  // ===========================================================================
  // 评审修复环（M2-W3 T2 review：C-1/I-1/I-5/M-1/M-2/M-6）
  // ===========================================================================

  it('C-1b 迟到支付：超时按比例结算后 diff PAY_SUCCESS 到达→补差全额退款恰一张（ooo-diff-late）+订单净额不变+G1 恰一条不撤', async () => {
    await poolSvc.withTransaction((uow: SqlExecutor) =>
      rules.createLexiconVersion(uow, {
        ruleKey: 'credit.rules',
        version: 1,
        content: CREDIT_RULES_SEED,
        effectiveAt: new Date(Date.now() - 86_400_000),
      }),
    );
    const { orderId, userId, lawyerId } = await finishedTextOrder(2); // settle=100 > prepaid=50
    await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '100.00' },
      { actorUserId: userId },
    );
    await orders.settleConfirm(
      orderId,
      { role: 'lawyer', settle_amount: '100.00' },
      { actorUserId: lawyerId },
    );
    const diffPo = (await paymentOrderOfKey(oooDiffKey(orderId)))!;
    const diffPoId = Number(diffPo['id']);

    // 超时结算先行（settle=prepaid=50 + DiffUnpaid + G1 -5）
    await dueJobsNow(orderId, ['DIFF_PAY_TIMEOUT']);
    await scheduler.tick('normal');
    await relay.tick(); // G1 入账
    expect((await oooRow(orderId))!['status']).toBe('SETTLED');
    expect((await oooRow(orderId))!['settle_amount']).toBe('50.00');
    expect((await creditEventRowsRaw(pool, 'user', userId)).length).toBe(1);

    // 迟到支付：diff PAY_SUCCESS → markFrozen + onDiffPaySuccess 迟到路径 → 补差全额退款
    await paySuccess(diffPoId);
    const late = (await refundsOfKey(diffPoId, `refund/po-${diffPoId}/ooo-diff-late`))!;
    expect(late).toBeDefined();
    expect(late['reason']).toBe('SETTLE_REFUND');
    expect(late['cash_amount']).toBe('50.00'); // 补差单全额（100−prepaid50）
    // 订单净额不变（超时结算落定值维持）；G1 恰一条不撤（人工经 H3 冲正——代码注记口径）
    const row = (await oooRow(orderId))!;
    expect(row['status']).toBe('SETTLED');
    expect(row['settle_amount']).toBe('50.00');
    expect((await creditEventRowsRaw(pool, 'user', userId)).length).toBe(1);
    // 重放：同回调重投 → inbox 去重零新退款（恰一张）
    await relay.tick();
    expect((await listRefundsByOrderId(pool, diffPoId)).length).toBe(1);
  });

  it('C-1a 支付竞态回查：executor 触发时补差单已 FROZEN→走已付收敛（net=实结含补差），不发 DiffUnpaid 不扣信用', async () => {
    const { orderId, userId, lawyerId } = await finishedTextOrder(2); // settle=100 > prepaid=50
    await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '100.00' },
      { actorUserId: userId },
    );
    await orders.settleConfirm(
      orderId,
      { role: 'lawyer', settle_amount: '100.00' },
      { actorUserId: lawyerId },
    );
    const diffPoId = Number((await paymentOrderOfKey(oooDiffKey(orderId)))!['id']);

    // 支付先达（F1 冻结推进——消费器同款导出面调用，onDiffPaySuccess 未及运行）
    await gateway.markFrozen(diffPoId, null);

    await dueJobsNow(orderId, ['DIFF_PAY_TIMEOUT']);
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBeGreaterThanOrEqual(1);
    const row = (await oooRow(orderId))!;
    expect(row['status']).toBe('SETTLED');
    expect(row['settle_amount']).toBe('100.00'); // 已付收敛=实结含补差（非 prepaid 封顶）
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({ order_id: orderId, net: '100.00' });
    expect(await outboxPayloads(ONE_ON_ONE_DIFF_UNPAID_TOPIC)).toHaveLength(0); // 不发 DiffUnpaid
    expect((await creditEventRowsRaw(pool, 'user', userId)).length).toBe(0); // 不扣信用
  });

  it('I-1 半默认锚系统计量：首方低报 0.00+3 轮已交付→30min 默认按 150 结算非 0（少补挂起）', async () => {
    const { orderId, userId } = await finishedTextOrder(3); // 系统计量 settle=150
    const first = await orders.settleConfirm(
      orderId,
      { role: 'user', settle_amount: '0.00' }, // 低报（声明值不采信——I-1 防线）
      { actorUserId: userId },
    );
    expect(first.status).toBe('SETTLING');
    expect((await oooRow(orderId))!['settle_amount']).toBe('0.00');

    await dueJobsNow(orderId, ['OOO_SETTLE_DEFAULT']);
    await scheduler.tick('normal');
    const row = (await oooRow(orderId))!;
    expect(row['status']).toBe('DIFF_PENDING'); // 150 > prepaid 50 → 少补挂起（M-3：不再虚报 SETTLED）
    expect(row['settle_amount']).toBe('150.00'); // 系统计量覆盖低报值
    const diffPo = (await paymentOrderOfKey(oooDiffKey(orderId)))!;
    expect(diffPo['cash_amount']).toBe('100.00');
  });

  it('I-5a 房间活跃门：CLOSED/CANCELLED 房间发起 1对1 → 409（OPEN/IN_SERVICE 放行）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const closedRoom = await seedRoom(lawyer);
    await pool.query(`UPDATE fulfillment.rooms SET status = 'CLOSED' WHERE id = $1`, [closedRoom]);
    await expect(createOrder(user, closedRoom)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    const cancelledRoom = await seedRoom(lawyer);
    await pool.query(`UPDATE fulfillment.rooms SET status = 'CANCELLED' WHERE id = $1`, [
      cancelledRoom,
    ]);
    await expect(createOrder(user, cancelledRoom)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });

    const openRoom = await seedRoom(lawyer); // OPEN（fixture 缺省）放行
    const ok = await createOrder(user, openRoom);
    expect(ok.order.status).toBe('CREATED');
  });

  it('M-1 duration 上限：>30 天（2_592_001s）→ 400（脏回调防溢出）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const created = await createOrder(user, await seedRoom(lawyer), 'voice');
    await paySuccess(created.payment_order.id);
    await orders.accept(created.order.id, { actorLawyerId: lawyer });
    await expect(orders.recordDuration(created.order.id, 2_592_001)).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
    // 恰 30 天=合法上界（幂等单调上界照常）
    const ok = await orders.recordDuration(created.order.id, 2_592_000);
    expect(ok.segments).toBe(2880);
  });

  it('M-2 并发双插：同 user+room+type 两路并发 create→一胜一重放（23505 收口不 500，恰一行一单）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);

    const [a, b] = await Promise.all([
      createOrder(user, roomId, 'voice'),
      createOrder(user, roomId, 'voice'),
    ]);
    expect(a.order.id).toBe(b.order.id); // 败者回读重放胜者原单
    expect([a.deduplicated, b.deduplicated].sort()).toEqual([false, true]);
    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fulfillment.one_on_one_orders`,
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it('M-6 recheck 锚：accept 后 OOO_ACCEPT_TIMEOUT 触发=no-op（状态保持 ACCEPTED、job CANCELLED、零超时事件）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId);
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });

    await dueJobsNow(id, ['OOO_ACCEPT_TIMEOUT']);
    const ticked = await scheduler.tick('normal');
    expect(ticked.cancelled).toBeGreaterThanOrEqual(1); // recheck=false → CANCELLED（done 计数外）
    expect((await oooRow(id))!['status']).toBe('ACCEPTED'); // recheck=非 PAID → 无操作
    expect(await jobStatusRaw(pool, 'OOO_ACCEPT_TIMEOUT', 'one_on_one', id)).toBe('CANCELLED');
    expect(await outboxPayloads(ONE_ON_ONE_LAWYER_TIMEOUT_TOPIC)).toHaveLength(0);
  });

  // ===========================================================================
  // 终审修复波（arch Approved-with-notes：B-1 BLOCKER 资损 + H-1 加固）
  // ===========================================================================

  it('B-1 取消崩溃窗重入：③半价取消 F2 受理崩溃→CANCELLED.refund_amount 权威续跑（部分退额维持非全退）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const created = await createOrder(user, await seedRoom(lawyer), 'voice'); // prepaid=100
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });
    await orders.recordDuration(id, 0); // IN_SERVICE+consumed=0 → ③ 首单位半价：应退 50.00

    // 模拟崩溃：F2 受理首调炸（步骤一 CANCELLED + refund_amount=50.00 已原子提交）
    const spy = vi
      .spyOn(app.get(RefundService), 'accept')
      .mockRejectedValueOnce(new Error('simulated crash'));
    await expect(orders.cancel(id, { role: 'user', actorUserId: user })).rejects.toThrow(
      'simulated crash',
    );
    expect((await oooRow(id))!['status']).toBe('CANCELLED');
    expect((await oooRow(id))!['refund_amount']).toBe('50.00');
    spy.mockRestore();

    // 客户端重试：以已持久化 refund_amount 为权威续跑——部分退额维持（修复前按 status 重算
    // 恒全退：将以 ooo-cancel 键超退整单 100）
    const resumed = await orders.cancel(id, { role: 'user', actorUserId: user });
    expect(resumed.refund.kind).toBe('PARTIAL');
    expect(resumed.refund.amount).toBe('50.00');
    expect(resumed.order.status).toBe('PARTIAL_REFUNDED');
    const refundRows = await listRefundsByOrderId(pool, created.payment_order.id);
    expect(refundRows).toHaveLength(1); // 恰一张
    expect(refundRows[0]!['idempotency_key']).toBe(
      `refund/po-${created.payment_order.id}/ooo-cancel-partial`,
    );
    expect(refundRows[0]!['cash_amount']).toBe('50.00'); // 部分键+50 额——B-1 回归钉
  });

  it('H-1 双确认多退崩溃窗：ooo-settle 受理在册→默认确认尊重共识值（系统计量不覆盖，退款恰一张）', async () => {
    const lawyer = nextLawyer();
    await seedLawyer(lawyer);
    const user = nextUser();
    await seedUser(user);
    const roomId = await seedRoom(lawyer);
    const created = await createOrder(user, roomId, 'voice'); // prepaid=100，consumed 将=0
    const id = created.order.id;
    await paySuccess(created.payment_order.id);
    await orders.accept(id, { actorLawyerId: lawyer });
    await orders.recordDuration(id, 0); // consumed=0 → 系统计量 settle=0.00（与共识 40 相异）
    await orders.finish(id, 0, { actorLawyerId: lawyer });
    await orders.settleConfirm(id, { role: 'user', settle_amount: '40.00' }, { actorUserId: user });

    // 模拟崩溃：双确认第二方的 F2 受理已提交、终态化未达（直调同键同额=finalize 的受理半边）
    await app.get(RefundService).accept({
      order_id: created.payment_order.id,
      user_id: user,
      cash: '60.00',
      points: 0,
      reason: 'SETTLE_REFUND',
      idempotency_key: `refund/po-${created.payment_order.id}/ooo-settle`,
    });

    // 30min 默认触发：共识值 40 权威（修复前按系统计量 0 重算→同键异额 409/账面漂移）
    await dueJobsNow(id, ['OOO_SETTLE_DEFAULT']);
    await scheduler.tick('normal');
    const row = (await oooRow(id))!;
    expect(row['status']).toBe('SETTLED');
    expect(row['settle_amount']).toBe('40.00'); // 共识值未被系统计量（0.00）覆盖
    const refundRows = await listRefundsByOrderId(pool, created.payment_order.id);
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]!['cash_amount']).toBe('60.00'); // 幂等重放恰一张同额
    const settled = await outboxPayloads(ONE_ON_ONE_SETTLED_TOPIC);
    expect(settled.at(-1)).toMatchObject({ order_id: id, net: '40.00' });
  });
});
