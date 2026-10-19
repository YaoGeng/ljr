import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ATTENDANCE_ADJUDICATED_TOPIC,
  POINTS_GRANTED_TOPIC,
  type AttendanceAdjudicatedPayload,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import type { SqlExecutor } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from '../payment/payment.channels';
import {
  PAYMENT_CONFIG,
  PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  type PaymentConfig,
} from '../payment/payment.config';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from '../payment/firm-merchant.config';
import { RefundSourceRegistry } from '../payment/refund.source';
import { seedPaymentOrderRaw } from '../payment/order-fixture';
import { seedPaidEnrollmentRaw, seedSessionRaw } from '../trade/trade-fixture';
import { TradeModule } from '../trade/trade.module';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { BenefitsConsumersModule } from './absence.consumer';
import { createAttendanceAdjudicatedHandler } from './absence.consumer';
import { PointsService } from './points.service';

/**
 * F4 ②全量 ABSENCE_SHARE 分成真消费链 e2e（需 PG，M2-W2 T6；R-04「分摊计算与取整由本模块
 * 唯一定义」的消费侧验收）：
 *   - 事件面=AttendanceAdjudicated 合成事件直投 outbox（D3 生产形状——owner_type/owner_id/
 *     result 三值），handler 工厂直驱（relay 扇出注册面在 BenefitsConsumersModule 装配）；
 *   - paid 聚合=payment 导出面真源（TradeModule 装配 SessionRefundSource 注册进 registry：
 *     PAID enrollment + F1 支付单 enroll/e{id}/pay 键），R-07 全额口径=cash 分+points；
 *   - R-04 精确复核：缺席 2（含 mixed cash+points）+到场 3（含 LATE 旁听）→池=Σ缺席 paid
 *     一次取整 30%→到场占比 floor→余数归 user_id 升序首名（逐分断言）；
 *   - 幂等：事件重放不双计（grant 幂等键=(user, ABSENCE_SHARE, absence:{sid})+ACCRUE 台账
 *     同事务）；完成门/律师缺席/无缺席用户各防御分支。
 */
const LAWYER = 9701;
/** user_id 升序首名=U1（余数归首名断言锚） */
const U1 = 7201;
const U2 = 7202;
const U3 = 7203;
const A1 = 7204;
const A2 = 7205;

function testIdentityConfig(): IdentityConfig {
  return {
    phoneDataKey: randomBytes(32),
    phoneBlindPepper: randomBytes(32).toString('hex'),
    jwtSecret: randomBytes(32).toString('hex'),
  };
}

function testPaymentConfig(): PaymentConfig {
  return {
    primary: { channel: 'wechat_ecom', merchantId: 'mock-wechat-mch', secret: 'test-secret-w' },
    backup: { channel: 'alipay', merchantId: 'mock-alipay-mch', secret: 'test-secret-a' },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

const MERCHANT_CONFIG: FirmMerchantConfig = { depositAmount: '500.00', reverifyDays: 365 };

describe('F4 ②全量 ABSENCE_SHARE 分成（R-04 真消费链 + 幂等 + 防御分支，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let poolSvc: PgPoolService;
  let outbox: OutboxService;
  let points: PointsService;
  let handler: (event: RelayEvent, uow: SqlExecutor) => Promise<void>;
  let adjudicationSeq = 0;
  let eventSeq = 0;

  const seedAdjudication = async (
    sessionId: number,
    ownerType: 'user' | 'lawyer',
    ownerId: number,
    result: 'normal' | 'late' | 'absent',
  ): Promise<RelayEvent> => {
    adjudicationSeq += 1;
    eventSeq += 1;
    const payload: AttendanceAdjudicatedPayload = {
      adjudication_id: adjudicationSeq,
      session_id: sessionId,
      owner_type: ownerType,
      owner_id: ownerId,
      result,
    };
    await poolSvc.withTransaction((uow) =>
      outbox.recordOutbox(uow, { type: ATTENDANCE_ADJUDICATED_TOPIC, payload }),
    );
    return {
      id: eventSeq,
      eventId: `evt-${eventSeq}`,
      topic: ATTENDANCE_ADJUDICATED_TOPIC,
      payload,
      retryCount: 0,
    };
  };

  /** PAID 报名+配对 F1 支付单（真源链：enroll/e{id}/pay 幂等键） */
  const seedPaidUser = async (
    sessionId: number,
    userId: number,
    cash: string,
    pointsAmount: number,
  ): Promise<void> => {
    const eid = await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId,
      cash,
      points: pointsAmount,
      unitPrice: '100.00',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(eid),
      bizId: eid,
      cash,
      points: pointsAmount,
      status: 'PAID',
    });
  };

  const absenceTxns = async () => {
    const res = await pool.query<{
      user_id: string;
      delta: number;
      kind: string;
      source_ref: string;
    }>(
      `SELECT user_id::text AS user_id, delta, kind, source_ref FROM benefits.points_txns
        WHERE kind = 'ABSENCE_SHARE' ORDER BY user_id`,
    );
    return res.rows;
  };

  const accrueRows = async () => {
    const res = await pool.query<{ ref_id: string; amount: string }>(
      `SELECT ref_id, amount::text AS amount FROM benefits.reserve_ledgers WHERE entry = 'ACCRUE' ORDER BY id`,
    );
    return res.rows;
  };

  const grantedEvents = async () => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 AND payload->>'kind' = 'ABSENCE_SHARE' ORDER BY id`,
      [POINTS_GRANTED_TOPIC],
    );
    return res.rows.map((r) => r.payload);
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [BenefitsConsumersModule, TradeModule],
    })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(testPaymentConfig())
      .overrideProvider(PAYMENT_CHANNEL_ADAPTERS)
      .useValue([
        new MockChannelAdapter('wechat_ecom', 'mock-wechat-mch', 'test-secret-w'),
        new MockChannelAdapter('alipay', 'mock-alipay-mch', 'test-secret-a'),
      ] as readonly PaymentChannelAdapter[])
      .overrideProvider(FIRM_MERCHANT_CONFIG)
      .useValue(MERCHANT_CONFIG)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    poolSvc = app.get(PgPoolService);
    outbox = app.get(OutboxService);
    points = app.get(PointsService);
    handler = createAttendanceAdjudicatedHandler(points, app.get(RefundSourceRegistry), outbox);
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

  it('R-04 真消费链精确复核：缺席 2（paid 10000+23705，30% 池=10111）→ 到场 3 按占比 floor + 余数 1 归 user_id 升序首名（逐分）+ACCRUE 逐笔+POINTS_GRANTED(kind=ABSENCE_SHARE)', async () => {
    const sessionId = await seedSessionRaw(pool, LAWYER, 'IN_SERVICE', 101);
    // 到场：U1 5000（纯现）/U2 10000（50 现+5000 积分——R-07 全额分母）/U3 15000（LATE 旁听同权）
    await seedPaidUser(sessionId, U1, '50.00', 0);
    await seedPaidUser(sessionId, U2, '50.00', 5000);
    await seedPaidUser(sessionId, U3, '150.00', 0);
    // 缺席：A1 10000 / A2 23705（纯现）→ 池=33705，30%=floor(101115/10)=10111
    await seedPaidUser(sessionId, A1, '100.00', 0);
    await seedPaidUser(sessionId, A2, '237.05', 0);

    // 判定序列：律师 normal + 3 到场（U3 late）+ 2 缺席——逐事件投递，最后一发触发完成门
    await handler(await seedAdjudication(sessionId, 'lawyer', LAWYER, 'normal'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId, 'user', U1, 'normal'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId, 'user', U2, 'normal'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId, 'user', A1, 'absent'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId, 'user', U3, 'late'), poolSvc).catch(
      () => undefined,
    );
    // 完成门未齐（A2 未判）——前五发均无操作
    expect(await absenceTxns()).toHaveLength(0);

    const lastEvent = await seedAdjudication(sessionId, 'user', A2, 'absent');
    await handler(lastEvent, poolSvc);

    // 30%=10111；占比：U1 5000/30000→floor(1685.16)=1685、U2 3370、U3 5055（Σ=10110），
    // 余数 1 归 user_id 升序首名 U1 → 1686
    const txns = await absenceTxns();
    expect(txns).toEqual([
      {
        user_id: String(U1),
        delta: 1686,
        kind: 'ABSENCE_SHARE',
        source_ref: `absence:${sessionId}`,
      },
      {
        user_id: String(U2),
        delta: 3370,
        kind: 'ABSENCE_SHARE',
        source_ref: `absence:${sessionId}`,
      },
      {
        user_id: String(U3),
        delta: 5055,
        kind: 'ABSENCE_SHARE',
        source_ref: `absence:${sessionId}`,
      },
    ]);
    // 缺席者无入账（受领人=到场用户）
    for (const t of txns) {
      expect([String(A1), String(A2)]).not.toContain(t.user_id);
    }
    // ACCRUE 逐笔记账（ref=absence:{sid}:u{user}；amount=points/100）
    const accrues = await accrueRows();
    expect(accrues.map((r) => r.ref_id)).toEqual([
      `absence:${sessionId}:u${U1}`,
      `absence:${sessionId}:u${U2}`,
      `absence:${sessionId}:u${U3}`,
    ]);
    expect(accrues.map((r) => r.amount)).toEqual(['16.86', '33.70', '50.55']);
    // POINTS_GRANTED（kind=ABSENCE_SHARE）×3
    const events = await grantedEvents();
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e as { user_id: number }).user_id).sort()).toEqual([U1, U2, U3]);
    // R-05 不变量：Σ(balance)=ΣACCRUE×100（对平核在 reserve.spec，此处金额面复核）
    const bal = await pool.query<{ balance: number }>(
      `SELECT COALESCE(sum(balance), 0)::int AS balance FROM benefits.points_accounts`,
    );
    expect(bal.rows[0]!.balance).toBe(10111);

    // ---- 幂等：AttendanceAdjudicated 重放不双计（txn/台账/事件三面） ----
    await handler(lastEvent, poolSvc);
    await handler(
      await seedAdjudication(sessionId, 'user', U2, 'normal'), // 已判定用户的事件重投（不同 adjudication_id）
      poolSvc,
    );
    expect(await absenceTxns()).toHaveLength(3);
    expect(await accrueRows()).toHaveLength(3);
    expect(await grantedEvents()).toHaveLength(3);
  });

  it('完成门：律师缺席 → 整场跳过（PRD §8.6 全额退款路径，无 30% 池）；律师未判 → 等待', async () => {
    const sessionId = await seedSessionRaw(pool, LAWYER, 'IN_SERVICE', 102);
    await seedPaidUser(sessionId, U1, '100.00', 0);
    await seedPaidUser(sessionId, A1, '100.00', 0);
    // 全员已判但律师 absent
    await handler(await seedAdjudication(sessionId, 'user', U1, 'normal'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId, 'lawyer', LAWYER, 'absent'), poolSvc);
    expect(await absenceTxns()).toHaveLength(0);

    // 律师未判（仅用户事件）→ 完成门未齐
    const sessionId2 = await seedSessionRaw(pool, LAWYER, 'IN_SERVICE', 103);
    await seedPaidUser(sessionId2, U1, '100.00', 0);
    await seedPaidUser(sessionId2, A1, '100.00', 0);
    await handler(await seedAdjudication(sessionId2, 'user', U1, 'normal'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId2, 'user', A1, 'absent'), poolSvc).catch(
      () => undefined,
    );
    expect(await absenceTxns()).toHaveLength(0);
  });

  it('无缺席用户（全员到场）→ 零发放；无到场用户（律师在场全缺席）→ 跳过（PRD 未定义，待澄清不发明）', async () => {
    const sessionId = await seedSessionRaw(pool, LAWYER, 'IN_SERVICE', 104);
    await seedPaidUser(sessionId, U1, '100.00', 0);
    await handler(await seedAdjudication(sessionId, 'lawyer', LAWYER, 'normal'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId, 'user', U1, 'normal'), poolSvc);
    expect(await absenceTxns()).toHaveLength(0);

    const sessionId2 = await seedSessionRaw(pool, LAWYER, 'IN_SERVICE', 105);
    await seedPaidUser(sessionId2, A1, '100.00', 0);
    await handler(await seedAdjudication(sessionId2, 'lawyer', LAWYER, 'normal'), poolSvc).catch(
      () => undefined,
    );
    await handler(await seedAdjudication(sessionId2, 'user', A1, 'absent'), poolSvc);
    expect(await absenceTxns()).toHaveLength(0);
  });

  it('载荷缺最小集 → AppError（进重试轨道不静默丢弃）；退款源未注册 → 显性配置错误', async () => {
    const bad: RelayEvent = {
      id: 999,
      eventId: 'bad',
      topic: ATTENDANCE_ADJUDICATED_TOPIC,
      payload: { session_id: 1 },
      retryCount: 0,
    };
    await expect(handler(bad, poolSvc)).rejects.toThrow();
    const emptyRegistry = new RefundSourceRegistry();
    const bare = createAttendanceAdjudicatedHandler(points, emptyRegistry, outbox);
    const ev: RelayEvent = {
      id: 1000,
      eventId: 'bare',
      topic: ATTENDANCE_ADJUDICATED_TOPIC,
      payload: {
        adjudication_id: 1,
        session_id: 1,
        owner_type: 'user',
        owner_id: 1,
        result: 'absent',
      },
      retryCount: 0,
    };
    await expect(bare(ev, poolSvc)).rejects.toThrow();
  });
});
