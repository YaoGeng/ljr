import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { REFUND_SOURCE_REF_TYPE_GROUPBUY, REFUND_SOURCE_REF_TYPE_SESSION } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { StateTransitionLogService } from '../../infrastructure/state-machine/state-transition-log.service';
import { ChannelRouter, MockChannelAdapter } from '../payment/payment.channels';
import { PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from '../payment/payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from '../payment/payment.alerts';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { RefundSourceRegistry } from '../payment/refund.source';
import { GroupBuyRefundSource, SessionRefundSource } from './enrollment.refund-source';
import { seedPaidEnrollmentRaw } from './trade-fixture';

/**
 * I-1（M2-W3 T1）trade 侧退款源：GroupBuyRefundSource（'groupbuy' 键）——LawyerRejected
 * 拒绝/超时全员退款消费器的付款人清单真源。覆盖：注册形态（与 session 键同注册表并存）/
 * 清单口径（该拼团 PAID 行进清单、未支付行与其他拼团行不进）/prev_enrollment_id 回链
 * （支付单挂原报名键 enroll/e{prev}/pay 的迁移行沿回链解析——Session 源同款共享 impl）。
 * 组装：轻量直构（refund.consumer.spec 同款先例——退款源仅依赖池/F1 读面/注册表，无需整模块）。
 */

const DAY = Date.UTC(2026, 9, 16, 8, 0, 0);

function testConfig(): PaymentConfig {
  return {
    primary: {
      channel: 'wechat_ecom',
      merchantId: 'mock-wechat-mch',
      secret: randomBytes(32).toString('hex'),
    },
    backup: {
      channel: 'alipay',
      merchantId: 'mock-alipay-mch',
      secret: randomBytes(32).toString('hex'),
    },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

describe('GroupBuyRefundSource（I-1：拼团拒绝/超时全员退款清单源，需 PG）', () => {
  let pool: Pool;
  let poolSvc: PgPoolService;
  let gateway: PaymentGatewayService;
  let registry: RefundSourceRegistry;
  let groupbuySource: GroupBuyRefundSource;

  /** F1 真单挂报名键 enroll/e{id}/pay（报名↔支付单唯一关联口径；只读定位面无须支付态快进） */
  const createOrderForEnrollment = async (
    enrollmentId: number,
    cash: string,
    points: number,
  ): Promise<number> => {
    const res = await gateway.createOrder({
      biz_type: 'enroll',
      biz_id: enrollmentId,
      cash_amount: cash,
      points_amount: points,
      idempotency_key: `enroll/e${enrollmentId}/pay`,
    });
    return res.payment_order.id;
  };

  /** 直插指定 pay_status 报名行（PENDING 未支付/CONVERTED_OUT 迁移出等夹具位；返回报名 id） */
  const seedEnrollmentRaw = async (
    gbId: number,
    userId: number,
    payStatus: string,
    opts: { readonly cash?: string; readonly prev?: number } = {},
  ): Promise<number> => {
    const cash = opts.cash ?? '33.33';
    const res = await pool.query<{ id: string }>(
      `INSERT INTO trade.enrollments
         (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
          points_amount, price_version_id, pay_status, credit_used, prev_enrollment_id)
       VALUES ('groupbuy', $1, $2, '{}'::jsonb, $3, $3, $3, 0, 1, $4, 0, $5)
       RETURNING id`,
      [gbId, userId, cash, payStatus, opts.prev ?? null],
    );
    return Number(res.rows[0]!.id);
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const cfg = testConfig();
    const router = new ChannelRouter({
      adapters: [
        new MockChannelAdapter(
          'wechat_ecom',
          cfg.primary.merchantId,
          cfg.primary.secret,
          () => new Date(DAY),
        ),
        new MockChannelAdapter(
          'alipay',
          cfg.backup.merchantId,
          cfg.backup.secret,
          () => new Date(DAY),
        ),
      ],
      switchWindowMs: cfg.switchWindowMs,
      now: () => DAY,
    });
    poolSvc = new PgPoolService(pool);
    const guard = new StateTransitionGuardService(new StateTransitionLogService(), poolSvc);
    gateway = new PaymentGatewayService(
      poolSvc,
      new OutboxService(),
      guard,
      router,
      new PaymentAlertService(new MockPaymentAlertSink()),
      cfg,
    );
    registry = new RefundSourceRegistry();
    groupbuySource = new GroupBuyRefundSource(poolSvc, gateway, registry);
    groupbuySource.onModuleInit();
  });

  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('注册形态：onModuleInit 注册 groupbuy 键，与 session 键同注册表并存（双源互不覆盖）', () => {
    expect(registry.resolve(REFUND_SOURCE_REF_TYPE_GROUPBUY)).toBe(groupbuySource);
    expect(registry.resolve(REFUND_SOURCE_REF_TYPE_SESSION)).toBeNull(); // 本组未注册 session 源
    const sessionSource = new SessionRefundSource(poolSvc, gateway, registry);
    sessionSource.onModuleInit();
    expect(registry.resolve(REFUND_SOURCE_REF_TYPE_SESSION)).toBe(sessionSource);
    expect(registry.resolve(REFUND_SOURCE_REF_TYPE_GROUPBUY)).toBe(groupbuySource); // 并存不扰
  });

  it('清单口径：该拼团 PAID 行进清单（金额/付款人逐字段=F1 拆分快照），未支付行与其他拼团行不进', async () => {
    const gbId = 8801;
    const e1 = await seedPaidEnrollmentRaw(pool, 'groupbuy', gbId, {
      userId: 631,
      cash: '33.33',
      points: 0,
      unitPrice: '33.33',
    });
    const order1 = await createOrderForEnrollment(e1, '33.33', 0);
    const e2 = await seedPaidEnrollmentRaw(pool, 'groupbuy', gbId, {
      userId: 632,
      cash: '20.00',
      points: 1333,
      unitPrice: '33.33',
    });
    const order2 = await createOrderForEnrollment(e2, '20.00', 1333);
    // 未支付行：无款可退静默跳过（积分清场非本源职责；拒绝路径 sweep 未接线=已知缺口，
    // 见实现文件头注——T1 评审 I-1）
    await seedEnrollmentRaw(gbId, 633, 'PENDING');
    // 其他拼团的 PAID 行：ref_id 过滤不串场
    const otherGb = 8802;
    const other = await seedPaidEnrollmentRaw(pool, 'groupbuy', otherGb, {
      userId: 634,
      cash: '33.33',
      points: 0,
      unitPrice: '33.33',
    });
    await createOrderForEnrollment(other, '33.33', 0);

    const orders = await groupbuySource.listPaidPaymentOrders(gbId);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      payment_order_id: order1,
      user_id: 631,
      cash_amount: '33.33',
      points_amount: 0,
    });
    expect(orders[1]).toMatchObject({
      payment_order_id: order2,
      user_id: 632,
      cash_amount: '20.00',
      points_amount: 1333,
    });
  });

  it('prev 回链：迁移行支付单挂原报名键 enroll/e{prev}/pay → 沿回链解析（Session 源同款共享 impl）', async () => {
    const gbId = 8811;
    // 原报名行（迁移出=非活跃，ux_enroll_active 不撞）+ 支付单挂其键
    const prevId = await seedEnrollmentRaw(gbId, 635, 'CONVERTED_OUT', { cash: '40.00' });
    const prevOrderId = await createOrderForEnrollment(prevId, '40.00', 0);
    // 迁移承载行：PAID、prev 回链、自身键无单（迁移不搬家款——沿用原快照价口径）
    await seedEnrollmentRaw(gbId, 635, 'PAID', { cash: '40.00', prev: prevId });

    const orders = await groupbuySource.listPaidPaymentOrders(gbId);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      payment_order_id: prevOrderId,
      user_id: 635,
      cash_amount: '40.00',
      points_amount: 0,
    });
  });
});
