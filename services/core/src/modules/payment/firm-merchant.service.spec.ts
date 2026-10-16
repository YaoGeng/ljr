import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  FIRM_MERCHANT_ACTIVATED_TOPIC,
  FIRM_MERCHANT_REVERIFIED_DUE_TOPIC,
  FIRM_MERCHANT_SUSPENDED_TOPIC,
  LAWYER_AUDIT_PASSED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from './payment.channels';
import { PAYMENT_CONFIG, PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from './firm-merchant.config';
import { createFirmOnboardingHandler } from './firm-merchant.consumer';
import { FirmMerchantService } from './firm-merchant.service';
import { PaymentModule } from './payment.module';
import { SchedulerService } from '../schedule/scheduler.service';

/**
 * A3b 进件服务（§4/§5/§7 + Task 3 简报裁决）：
 *   - R-01 分账前置查询面（assertSplittable：仅 ACTIVE；CHANGING 同拒=R-W3-C2）；
 *   - R-02 账户变更（change→CHANGING+Suspended(ACCOUNT_CHANGING) 同事务出箱）；
 *   - R-03 年度复验（→ACTIVE 注册 FIRM_REVERIFY 一年后 job；到期执行→SUSPENDED+
 *     Suspended(REVERIFY_OVERDUE)+ReverifiedDue 成对出箱；复验端点→ACTIVE）；
 *   - R-W3-C2：变更期=分账暂停语义（F3 查询面 CHANGING 与 SUSPENDED 同拒）；
 *   - LawyerAuditPassed 消费（幂等=UNIQUE(firm_id,channel) 短路；firm_id null 记日志跳过不崩溃）；
 *   - PII 红线：materials 密钥禁落日志（logger spy 断言）。
 */

function testConfig(): PaymentConfig {
  return {
    primary: { channel: 'wechat_ecom', merchantId: 'mock-wechat-mch', secret: 'test-secret-w' },
    backup: { channel: 'alipay', merchantId: 'mock-alipay-mch', secret: 'test-secret-a' },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

function testMerchantConfig(): FirmMerchantConfig {
  return { depositAmount: '500.00', reverifyDays: 365 };
}

describe('A3b 进件服务（§4/§5/§7，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let service: FirmMerchantService;
  let scheduler: SchedulerService;
  let wechat: MockChannelAdapter;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    wechat = new MockChannelAdapter('wechat_ecom', 'mock-wechat-mch', 'test-secret-w');
    const alipay = new MockChannelAdapter('alipay', 'mock-alipay-mch', 'test-secret-a');
    const moduleRef = await Test.createTestingModule({ imports: [PaymentModule] })
      .overrideProvider(PAYMENT_CONFIG)
      .useValue(testConfig())
      .overrideProvider(PAYMENT_CHANNEL_ADAPTERS)
      .useValue([wechat, alipay] as readonly PaymentChannelAdapter[])
      .overrideProvider(FIRM_MERCHANT_CONFIG)
      .useValue(testMerchantConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(FirmMerchantService);
    scheduler = app.get(SchedulerService);
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
    wechat.merchantReview = 'APPROVED';
  });

  const submitActive = (firmId: number) =>
    service.submit({ firm_id: firmId, channel: 'wechat_ecom', materials: { bank_no: 'x' } });

  it('R-01 提交→生效主路径：SUBMITTING→IN_REVIEW→ACTIVE 双留痕；sub_mchid/verified_at/reverify_due 落定；FIRM_REVERIFY job 注册（due=reverify_due）；FirmMerchantActivated 出箱恰一条', async () => {
    const view = await submitActive(12);
    expect(view.status).toBe('ACTIVE');
    expect(view.sub_mchid).toBe('MOCKMCH-WECHAT_ECOM-12');
    expect(view.verified_at).not.toBeNull();
    expect(view.reverify_due).not.toBeNull();

    // STL 双留痕（守卫放行）
    const stl = await pool.query<{ from_status: string; to_status: string; allowed: boolean }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'firm_merchant' AND entity_id = $1 ORDER BY id`,
      [view.id],
    );
    expect(stl.rows.map((r) => [r.from_status, r.to_status, r.allowed])).toEqual([
      ['SUBMITTING', 'IN_REVIEW', true],
      ['IN_REVIEW', 'ACTIVE', true],
    ]);

    // FIRM_REVERIFY job：producer=A3b（进件生效时注册一年后 job，due=reverify_due）
    const job = await pool.query<{ status: string; due_at: string }>(
      `SELECT status, due_at::text AS due_at FROM schedule.schedule_jobs
        WHERE job_type = 'FIRM_REVERIFY' AND ref_type = 'firm_merchant' AND ref_id = $1`,
      [view.id],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]!.status).toBe('PENDING');
    expect(new Date(job.rows[0]!.due_at).getTime()).toBe(
      new Date(view.reverify_due!).getTime(),
    );

    const events = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM platform.outbox WHERE topic = $1`,
      [FIRM_MERCHANT_ACTIVATED_TOPIC],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toEqual({ firm_id: 12, channel: 'wechat_ecom' });
  });

  it('幂等键=firm+channel：非 SUBMITTING 再提交 409 E_DUPLICATE；UNIQUE(firm_id,channel) 兜底', async () => {
    await submitActive(13);
    await expect(submitActive(13)).rejects.toMatchObject({
      code: ErrorCode.MerchantDuplicate,
      httpStatus: 409,
    });
    // IN_REVIEW 在审同样拒绝（PENDING 提交后重复 409）
    wechat.merchantReview = 'PENDING';
    const inReview = await submitActive(14);
    expect(inReview.status).toBe('IN_REVIEW');
    await expect(submitActive(14)).rejects.toMatchObject({ code: ErrorCode.MerchantDuplicate });
  });

  it('审核 PENDING 停 IN_REVIEW；机构回调（merchantReview→APPROVED）经 refreshFromChannel 推进 ACTIVE+事件+job（适配器异步应答驱动）', async () => {
    wechat.merchantReview = 'PENDING';
    const pending = await submitActive(15);
    expect(pending.status).toBe('IN_REVIEW');
    expect(pending.sub_mchid).toBeNull();

    wechat.merchantReview = 'APPROVED'; // 模拟机构审核完成
    const active = await service.refreshFromChannel({ firm_id: 15, channel: 'wechat_ecom' });
    expect(active.status).toBe('ACTIVE');
    expect(active.sub_mchid).toBe('MOCKMCH-WECHAT_ECOM-15');
    const job = await pool.query<{ id: number }>(
      `SELECT id FROM schedule.schedule_jobs WHERE job_type = 'FIRM_REVERIFY' AND ref_id = $1`,
      [active.id],
    );
    expect(job.rows).toHaveLength(1);
    const events = await pool.query<{ topic: string }>(
      `SELECT topic FROM platform.outbox WHERE topic = $1`,
      [FIRM_MERCHANT_ACTIVATED_TOPIC],
    );
    expect(events.rows).toHaveLength(1);

    // 再刷新：非 IN_REVIEW/CHANGING 幂等无操作（不出新事件）
    const again = await service.refreshFromChannel({ firm_id: 15, channel: 'wechat_ecom' });
    expect(again.status).toBe('ACTIVE');
    const total = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [FIRM_MERCHANT_ACTIVATED_TOPIC],
    );
    expect(total.rows[0]!.n).toBe(1);
  });

  it('R-02/W3-C2 变更：ACTIVE→CHANGING + materials 更新 + Suspended(ACCOUNT_CHANGING) 同事务出箱；非 ACTIVE 变更被守卫拒（拒绝留痕 allowed=false）；未进件 404', async () => {
    await submitActive(16);
    const changed = await service.change({
      firm_id: 16,
      channel: 'wechat_ecom',
      materials: { bank_no: 'new' },
    });
    expect(changed.status).toBe('CHANGING');
    const mats = await pool.query<{ materials: Record<string, unknown> }>(
      `SELECT materials FROM payment.firm_merchants WHERE id = $1`,
      [changed.id],
    );
    expect(mats.rows[0]!.materials).toEqual({ bank_no: 'new' });
    const suspended = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [FIRM_MERCHANT_SUSPENDED_TOPIC],
    );
    expect(suspended.rows).toHaveLength(1);
    expect(suspended.rows[0]!.payload).toEqual({
      firm_id: 16,
      channel: 'wechat_ecom',
      reason: 'ACCOUNT_CHANGING',
    });

    // 变更完成=重新进件通过（CHANGING→ACTIVE）
    wechat.merchantReview = 'APPROVED';
    const done = await service.refreshFromChannel({ firm_id: 16, channel: 'wechat_ecom' });
    expect(done.status).toBe('ACTIVE');

    // CHANGING 在途再变更：守卫拒（CHANGING→CHANGING 非法）+ 拒绝留痕（allowed=false 不随事务回滚）
    await service.change({ firm_id: 16, channel: 'wechat_ecom', materials: { bank_no: 'z2' } }); // ACTIVE→CHANGING 再入变更
    await service.refreshFromChannel({ firm_id: 16, channel: 'wechat_ecom' }); // →ACTIVE
    await service.change({ firm_id: 16, channel: 'wechat_ecom', materials: { bank_no: 'z3' } }); // 再入变更
    const changedAgain = await service.getMerchant(16, 'wechat_ecom');
    expect(changedAgain!.status).toBe('CHANGING');
    await expect(
      service.change({ firm_id: 16, channel: 'wechat_ecom', materials: { bank_no: 'y' } }),
    ).rejects.toMatchObject({ code: ErrorCode.StateIllegalTransition });
    const rejected = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log
        WHERE entity_type = 'firm_merchant' AND entity_id = $1 AND to_status = 'CHANGING'
        ORDER BY id DESC LIMIT 1`,
      [changed.id],
    );
    expect(rejected.rows[0]!.allowed).toBe(false);

    await expect(
      service.change({ firm_id: 999999, channel: 'wechat_ecom', materials: {} }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });

  it('R-03 复验到期：FIRM_REVERIFY job 到期 tick → ACTIVE→SUSPENDED + Suspended(REVERIFY_OVERDUE)+ReverifiedDue 成对出箱；未到期/非 ACTIVE 回查不开工', async () => {
    const view = await submitActive(17);
    // 时间旅行：job 与复验锚提前到期
    await pool.query(
      `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1s'
        WHERE job_type = 'FIRM_REVERIFY' AND ref_id = $1`,
      [view.id],
    );
    await pool.query(
      `UPDATE payment.firm_merchants SET reverify_due = now() - interval '1s' WHERE id = $1`,
      [view.id],
    );

    const tick = await scheduler.tick('normal');
    expect(tick.done).toBe(1);
    const after = await service.getMerchant(17, 'wechat_ecom');
    expect(after!.status).toBe('SUSPENDED');

    const events = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM platform.outbox
        WHERE topic IN ($1, $2) ORDER BY topic`,
      [FIRM_MERCHANT_REVERIFIED_DUE_TOPIC, FIRM_MERCHANT_SUSPENDED_TOPIC],
    );
    expect(events.rows.map((r) => r.topic).sort()).toEqual([
      FIRM_MERCHANT_REVERIFIED_DUE_TOPIC,
      FIRM_MERCHANT_SUSPENDED_TOPIC,
    ]);
    const suspendedPayload = events.rows.find(
      (r) => r.topic === FIRM_MERCHANT_SUSPENDED_TOPIC,
    )!.payload;
    expect(suspendedPayload).toMatchObject({ firm_id: 17, reason: 'REVERIFY_OVERDUE' });
    const duePayload = events.rows.find(
      (r) => r.topic === FIRM_MERCHANT_REVERIFIED_DUE_TOPIC,
    )!.payload;
    expect(duePayload).toMatchObject({ firm_id: 17 });

    // 未到期回查不开工：另一 ACTIVE 商户 job 未到期，tick 不产生第二个 DONE
    await submitActive(18);
    const tick2 = await scheduler.tick('normal');
    expect(tick2.done).toBe(0);
  });

  it('R-03 复验端点：SUSPENDED→ACTIVE（刷新 verified_at/reverify_due+新 job+Activated）；ACTIVE 复验被守卫拒', async () => {
    const view = await submitActive(19);
    await pool.query(
      `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1s'
        WHERE job_type = 'FIRM_REVERIFY' AND ref_id = $1`,
      [view.id],
    );
    await pool.query(
      `UPDATE payment.firm_merchants SET reverify_due = now() - interval '1s' WHERE id = $1`,
      [view.id],
    );
    await scheduler.tick('normal');
    expect((await service.getMerchant(19, 'wechat_ecom'))!.status).toBe('SUSPENDED');

    const reactivated = await service.reverify({ firm_id: 19, channel: 'wechat_ecom' });
    expect(reactivated.status).toBe('ACTIVE');
    expect(new Date(reactivated.reverify_due!).getTime()).toBeGreaterThan(Date.now());
    const jobs = await pool.query<{ status: string }>(
      `SELECT status FROM schedule.schedule_jobs
        WHERE job_type = 'FIRM_REVERIFY' AND ref_id = $1 ORDER BY id`,
      [reactivated.id],
    );
    expect(jobs.rows.map((r) => r.status)).toEqual(['DONE', 'PENDING']); // 旧 job DONE + 新一年期在册
    const activated = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [FIRM_MERCHANT_ACTIVATED_TOPIC],
    );
    expect(activated.rows[0]!.n).toBe(2); // 首次生效 + 复验恢复（→ACTIVE 三入边同生效口径）

    await expect(service.reverify({ firm_id: 19, channel: 'wechat_ecom' })).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
    });
  });

  it('R-01 分账前置查询面（F3 消费）：仅 ACTIVE 放行；IN_REVIEW/CHANGING/SUSPENDED/未进件全拒 E_MERCHANT_NOT_ACTIVE', async () => {
    await submitActive(20); // ACTIVE
    await service.assertSplittable(20, 'wechat_ecom'); // 不抛

    wechat.merchantReview = 'PENDING';
    await submitActive(21); // IN_REVIEW
    await expect(service.assertSplittable(21, 'wechat_ecom')).rejects.toMatchObject({
      code: ErrorCode.MerchantNotActive,
      httpStatus: 409,
    });

    // CHANGING 同拒（R-W3-C2：变更期=分账暂停语义）
    wechat.merchantReview = 'APPROVED';
    await submitActive(22);
    await service.change({ firm_id: 22, channel: 'wechat_ecom', materials: { bank_no: 'z' } });
    await expect(service.assertSplittable(22, 'wechat_ecom')).rejects.toMatchObject({
      code: ErrorCode.MerchantNotActive,
    });

    // SUSPENDED 同拒（复验到期）
    const v23 = await submitActive(23);
    await pool.query(
      `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1s'
        WHERE job_type = 'FIRM_REVERIFY' AND ref_id = $1`,
      [v23.id],
    );
    await pool.query(
      `UPDATE payment.firm_merchants SET reverify_due = now() - interval '1s' WHERE id = $1`,
      [v23.id],
    );
    await scheduler.tick('normal');
    await expect(service.assertSplittable(23, 'wechat_ecom')).rejects.toMatchObject({
      code: ErrorCode.MerchantNotActive,
    });

    await expect(service.assertSplittable(999999, 'wechat_ecom')).rejects.toMatchObject({
      code: ErrorCode.MerchantNotActive,
    });
  });

  it('LawyerAuditPassed 消费：建 SUBMITTING 行启动进件；重投幂等短路；firm_id=null 记日志跳过不崩溃；载荷缺 lawyer_user_id 进重试轨道', async () => {
    const loggerSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const handler = createFirmOnboardingHandler(service);
      const event = (payload: Record<string, unknown>) => ({
        id: 1,
        eventId: 'e-1',
        topic: LAWYER_AUDIT_PASSED_TOPIC,
        payload,
        retryCount: 0,
      });
      // const handler = createFirmOnboardingHandler(service);
      await handler(event({ lawyer_user_id: 301, firm_id: 30 }) as never, {} as never);
      const row = await pool.query<{ status: string; materials: unknown }>(
        `SELECT status, materials FROM payment.firm_merchants WHERE firm_id = 30`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.status).toBe('SUBMITTING');

      // 重投（at-least-once）：行已在 → 幂等短路，不崩不重复
      await handler(event({ lawyer_user_id: 301, firm_id: 30 }) as never, {} as never);
      const dup = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment.firm_merchants WHERE firm_id = 30`,
      );
      expect(dup.rows[0]!.n).toBe(1);

      // firm_id=null：记日志跳过（正常返回=SENT），不建行不崩溃
      await expect(
        handler(event({ lawyer_user_id: 302, firm_id: null }) as never, {} as never),
      ).resolves.toBeUndefined();
      const noneFirm = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment.firm_merchants WHERE firm_id IS NULL`,
      );
      expect(noneFirm.rows[0]!.n).toBe(0);
      expect(loggerSpy).toHaveBeenCalled(); // 跳过有日志留痕

      // 载荷缺 lawyer_user_id：抛错进重试轨道（不静默丢弃）
      await expect(handler(event({ firm_id: 31 }) as never, {} as never)).rejects.toMatchObject({
        code: ErrorCode.InvalidArgument,
      });
      const none = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment.firm_merchants WHERE firm_id = 31`,
      );
      expect(none.rows[0]!.n).toBe(0);
    } finally {
      loggerSpy.mockRestore();
    }
  });

  it('PII 红线：materials 密钥不落日志（logger spy 全量扫描）；materials 超 16KB 400', async () => {
    const svc = app.get(FirmMerchantService);
    const internal = svc as unknown as { logger: Logger };
    const logSpy = vi.spyOn(internal.logger, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(internal.logger, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(internal.logger, 'error').mockImplementation(() => undefined);
    const secret = '6222020200112233445';
    try {
      await service.submit({
        firm_id: 32,
        channel: 'wechat_ecom',
        materials: { bank_account_no: secret, license_key: 'secret-xyz-9876' },
      });
      const logged = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ].map((args) => args.map(String).join(' '));
      expect(logged.length).toBeGreaterThan(0); // 确有业务日志（摘要形态）
      for (const line of logged) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain('secret-xyz-9876');
        expect(line).not.toContain('bank_account_no');
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    await expect(
      service.submit({
        firm_id: 33,
        channel: 'wechat_ecom',
        materials: { blob: 'x'.repeat(17_000) },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });
});
