import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from './payment.channels';
import { PAYMENT_CONFIG, PAYMENT_SWITCH_WINDOW_MS_DEFAULT, type PaymentConfig } from './payment.config';
import { FIRM_MERCHANT_CONFIG, type FirmMerchantConfig } from './firm-merchant.config';
import { DepositService } from './deposit.service';
import { PaymentModule } from './payment.module';

/**
 * A3b 保证金冻结（§5 POST /firms/{id}/deposit/freeze + R-04 + Task 3 简报）：
 *   - 指令经 F1 通道原语 freeze（ChannelRouter 主→备，故障切换/降级出箱同 F1 先例）；
 *   - 台账 lawyer_deposits 同事务：ISSUED→FROZEN 经守卫（entity_type='lawyer_deposit'）；
 *   - 幂等键=firm+batch（确定性复合键 deposit:firm:{firmId}:batch:{batch}，UNIQUE 真兜底；
 *     同键同载荷重放、异载荷 409 E_DUP_KEY——F1 台账同口径）；
 *   - 400 E_INSUFFICIENT=通道 INSUFFICIENT 业务应答透传（失败尝试随事务回滚不烧键）；
 *   - ⚠W3-D4 金额配置化：amount 缺省取 LJR_PAYMENT_DEPOSIT_AMOUNT（台账先行）。
 */

function testConfig(): PaymentConfig {
  return {
    primary: { channel: 'wechat_ecom', merchantId: 'mock-wechat-mch', secret: 'test-secret-w' },
    backup: { channel: 'alipay', merchantId: 'mock-alipay-mch', secret: 'test-secret-a' },
    switchWindowMs: PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}

const MERCHANT_CONFIG: FirmMerchantConfig = { depositAmount: '500.00', reverifyDays: 365 };

describe('A3b 保证金冻结（§5/R-04，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let service: DepositService;
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
      .useValue(MERCHANT_CONFIG)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(DepositService);
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
    wechat.fault = null;
  });

  const freezeArgs = (firmId: number, batch: string, amount?: string) => ({
    firm_id: firmId,
    lawyer_id: 9001,
    batch,
    ...(amount === undefined ? {} : { amount }),
  });

  it('冻结主路径：指令经通道 freeze + 台账 ISSUED→FROZEN 同事务（守卫留痕）；detail 载 firm_id/channel_txn_no；出参 {escrow_status}', async () => {
    const view = await service.freeze(freezeArgs(40, 'B-1', '300.00'));
    expect(view.escrow_status).toBe('FROZEN');
    expect(view.amount).toBe('300.00');
    expect(view.channel).toBe('wechat_ecom');
    expect(view.channel_txn_no).toMatch(/^MOCK-WECHAT-\d{6}$/);

    const row = await pool.query<{
      status: string;
      channel: string;
      escrow_amount: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT status, channel, escrow_amount::text AS escrow_amount, detail
         FROM payment.lawyer_deposits WHERE id = $1`,
      [view.deposit_id],
    );
    expect(row.rows[0]!.status).toBe('FROZEN');
    expect(row.rows[0]!.escrow_amount).toBe('300.00');
    expect(row.rows[0]!.detail).toMatchObject({ firm_id: 40, lawyer_id: 9001, batch: 'B-1' });
    expect(row.rows[0]!.detail['channel_txn_no']).toBe(view.channel_txn_no);

    const stl = await pool.query<{ from_status: string; to_status: string; allowed: boolean }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'lawyer_deposit' AND entity_id = $1`,
      [view.deposit_id],
    );
    expect(stl.rows).toEqual([{ from_status: 'ISSUED', to_status: 'FROZEN', allowed: true }]);
  });

  it('⚠W3-D4 台账先行：amount 缺省取配置 LJR_PAYMENT_DEPOSIT_AMOUNT（500.00）', async () => {
    const view = await service.freeze(freezeArgs(41, 'B-DEFAULT'));
    expect(view.amount).toBe('500.00');
    const row = await pool.query<{ escrow_amount: string }>(
      `SELECT escrow_amount::text AS escrow_amount FROM payment.lawyer_deposits WHERE id = $1`,
      [view.deposit_id],
    );
    expect(row.rows[0]!.escrow_amount).toBe('500.00');
  });

  it('幂等键=firm+batch：同键同载荷重放同单；同键异载荷 409 E_DUP_KEY；batch 间互不冲突', async () => {
    const first = await service.freeze(freezeArgs(42, 'B-2', '100.00'));
    const replay = await service.freeze(freezeArgs(42, 'B-2', '100.00'));
    expect(replay.deposit_id).toBe(first.deposit_id);
    expect(replay.escrow_status).toBe('FROZEN');
    const total = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.lawyer_deposits`,
    );
    expect(total.rows[0]!.n).toBe(1);

    await expect(service.freeze(freezeArgs(42, 'B-2', '200.00'))).rejects.toMatchObject({
      code: ErrorCode.PaymentDuplicateKey,
      httpStatus: 409,
    });
    const other = await service.freeze(freezeArgs(42, 'B-3', '100.00')); // batch 不同=新键
    expect(other.deposit_id).not.toBe(first.deposit_id);
  });

  it('400 E_INSUFFICIENT：通道 INSUFFICIENT 业务应答透传；claim 随事务回滚不烧键（清障后同键可重发）', async () => {
    wechat.fault = { kind: 'INSUFFICIENT' };
    await expect(service.freeze(freezeArgs(43, 'B-4', '999.00'))).rejects.toMatchObject({
      code: ErrorCode.InsufficientFunds,
      httpStatus: 400,
    });
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment.lawyer_deposits`,
    );
    expect(rows.rows[0]!.n).toBe(0); // 台账未落（失败不烧键）

    wechat.fault = null;
    const retried = await service.freeze(freezeArgs(43, 'B-4', '999.00')); // 同键重发
    expect(retried.escrow_status).toBe('FROZEN');
  });

  it('主通道故障：备用通道接管（台账 channel=实际通道）；ChannelDegraded 同事务出箱', async () => {
    wechat.fault = { kind: 'CHANNEL_ERROR' };
    const view = await service.freeze(freezeArgs(44, 'B-5', '80.00'));
    expect(view.channel).toBe('alipay'); // 备通道接管
    expect(view.channel_txn_no).toMatch(/^MOCK-ALIPAY-\d{6}$/);
    const degraded = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = 'payment.channel.degraded'`,
    );
    expect(degraded.rows).toHaveLength(1);
    expect(degraded.rows[0]!.payload).toEqual({ channel: 'wechat_ecom' });
  });
});
