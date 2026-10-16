import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  ChannelFaultError,
  ChannelRouter,
  MockChannelAdapter,
  assertOutboundTarget,
  type ChannelDeductRequest,
  type ChannelInstructionRequest,
  type ChannelPreorderRequest,
} from './payment.channels';

/**
 * F1 双通道 mock 适配器与切换路由（⚠W3-3：两个 mock 适配器类，健康检查+切换；
 * mock 触发器=注入故障标志——§8「单通道故障 5min 内切换」的本批演练形态）。
 */

const PREORDER: ChannelPreorderRequest = {
  orderId: 1,
  bizType: 'enroll',
  bizId: 101,
  amount: '199.50',
  pointsAmount: 250,
  idempotencyKey: 'payment/order-1/pay',
};

const INSTRUCTION: ChannelInstructionRequest = {
  orderId: 1,
  amount: '100.00',
  idempotencyKey: 'payment/order-1/refund',
};

const DEDUCT: ChannelDeductRequest = {
  orderId: null,
  lawyerId: 9101,
  amount: '30.00',
  from: 'settlement',
  idempotencyKey: 'payment/deduct/1',
};

/** 固定时钟：降级窗口判定确定性（2026-10-16 12:00:00Z 起） */
const BASE_MS = Date.UTC(2026, 9, 16, 12, 0, 0);

function makeRouter(
  primary: MockChannelAdapter,
  backup: MockChannelAdapter,
  opts: { switchWindowMs?: number } = {},
): { router: ChannelRouter; clock: { now: number }; advanceBy(ms: number): void } {
  const clock = { now: BASE_MS };
  const router = new ChannelRouter({
    adapters: [primary, backup],
    switchWindowMs: opts.switchWindowMs ?? 300_000,
    now: () => clock.now,
  });
  return { router, clock, advanceBy: (ms: number) => (clock.now += ms) };
}

describe('MockChannelAdapter（mock 适配器：零网络请求 + 故障注入钩子）', () => {
  it('preorder/freeze 等原语产出确定性流水号与 mockpay:// 支付参数（含 order_id 供模拟器回调用）', async () => {
    const wechat = new MockChannelAdapter('wechat_ecom', 'mock-wechat-mch', 'mock-wechat-secret');
    const res = await wechat.preorder(PREORDER);
    expect(res.channelTxnNo).toMatch(/^MOCK-WECHAT-\d{6}$/);
    expect(res.payParams?.order_id).toBe(1);
    expect(res.payParams?.mock_pay_url).toContain('mockpay://wechat_ecom/pay');
    expect(res.payParams?.mock_pay_url).toContain('order_id=1');
    // 确定性：同参重放恒同 URL（幂等重放「原 pay_params」口径的载体）
    const again = await wechat.preorder(PREORDER);
    expect(again.payParams?.mock_pay_url).toBe(res.payParams?.mock_pay_url);
    // 幂等重放不推进流水号序列？——mock 简化：重放生成新流水号无妨（幂等由 DB 唯一约束承担），
    // 但同一次预下单的 freeze 回传同号（对账锚点）
    const frozen = await wechat.freeze({ ...INSTRUCTION, amount: '199.50' });
    expect(frozen.channelTxnNo).toMatch(/^MOCK-WECHAT-\d{6}$/);
  });

  it('refreeze/unfreezeSplit/refund/partialRefund/deduct 全原语可用并记入账单日志（statement 数据源）', async () => {
    const wechat = new MockChannelAdapter('wechat_ecom', 'm', 's');
    await wechat.preorder(PREORDER);
    await wechat.refreeze(INSTRUCTION);
    await wechat.unfreezeSplit({ ...INSTRUCTION, amount: '150.00' });
    await wechat.refund({ ...INSTRUCTION, amount: '100.00' });
    await wechat.partialRefund({ ...INSTRUCTION, amount: '50.00' });
    await wechat.deduct(DEDUCT);
    const lines = await wechat.statement('2026-10-16');
    expect(lines.map((l) => l.direction)).toEqual([
      'PAY',
      'SPLIT',
      'REFUND',
      'REFUND',
      'DEDUCT',
    ]);
    // refund 与 partialRefund 在账单上同为 REFUND 行（通道口径），本地按全额/部分选原语
    expect(lines.every((l) => l.status === 'SUCCESS')).toBe(true);
  });

  it('statement(period) 按（可注入时钟的）指令日期过滤；其他期无行', async () => {
    const clock = { now: Date.UTC(2026, 9, 15, 10, 0, 0) };
    const wechat = new MockChannelAdapter('wechat_ecom', 'm', 's', () => new Date(clock.now));
    await wechat.preorder(PREORDER);
    expect((await wechat.statement('2026-10-15')).length).toBe(1);
    expect(await wechat.statement('2026-10-16')).toEqual([]);
  });

  it('故障注入 CHANNEL_ERROR：healthy()=false 且原语抛 ChannelFaultError；INSUFFICIENT 仅 deduct 抛', async () => {
    const wechat = new MockChannelAdapter('wechat_ecom', 'm', 's');
    expect(wechat.healthy()).toBe(true);

    wechat.fault = { kind: 'CHANNEL_ERROR' };
    expect(wechat.healthy()).toBe(false);
    await expect(wechat.preorder(PREORDER)).rejects.toThrow(ChannelFaultError);
    await expect(wechat.refund(INSTRUCTION)).rejects.toThrow(ChannelFaultError);

    wechat.fault = { kind: 'INSUFFICIENT' };
    expect(wechat.healthy()).toBe(true); // INSUFFICIENT 是业务应答非通道故障
    await expect(wechat.preorder(PREORDER)).resolves.toBeTruthy();
    await expect(wechat.deduct(DEDUCT)).rejects.toMatchObject({ kind: 'INSUFFICIENT' });
  });
});

describe('ChannelRouter（§8 单通道故障切换：主→备 + 降级窗口 + 恢复探测）', () => {
  it('主通道健康：流量走主通道；degradedNow=false', async () => {
    const { router } = makeRouter(
      new MockChannelAdapter('wechat_ecom', 'm', 's'),
      new MockChannelAdapter('alipay', 'm', 's'),
    );
    const out = await router.execute((a) => a.preorder(PREORDER));
    expect(out.adapter.channel).toBe('wechat_ecom');
    expect(out.degradedNow).toBe(false);
  });

  it('主通道故障：备用通道接管（degradedNow=true 恰首 flip 一次），后续调用 degradedNow=false 仍走备用', async () => {
    const primary = new MockChannelAdapter('wechat_ecom', 'm', 's');
    const backup = new MockChannelAdapter('alipay', 'm', 's');
    const { router } = makeRouter(primary, backup);
    primary.fault = { kind: 'CHANNEL_ERROR' };

    const first = await router.execute((a) => a.preorder(PREORDER));
    expect(first.adapter.channel).toBe('alipay');
    expect(first.degradedNow).toBe(true);

    const second = await router.execute((a) => a.preorder(PREORDER));
    expect(second.adapter.channel).toBe('alipay');
    expect(second.degradedNow).toBe(false); // 已在降级窗口内，不再重复翻动
  });

  it('降级窗口（默认 5min=300000ms）内即使故障清除也走备用；窗口过后探测恢复走主通道', async () => {
    const primary = new MockChannelAdapter('wechat_ecom', 'm', 's');
    const backup = new MockChannelAdapter('alipay', 'm', 's');
    const { router, advanceBy } = makeRouter(primary, backup, { switchWindowMs: 300_000 });
    primary.fault = { kind: 'CHANNEL_ERROR' };
    const degraded = await router.execute((a) => a.preorder(PREORDER));
    expect(degraded.adapter.channel).toBe('alipay');

    primary.fault = null; // 故障清除但仍在窗口内
    const inWindow = await router.execute((a) => a.preorder(PREORDER));
    expect(inWindow.adapter.channel).toBe('alipay');

    advanceBy(300_001); // 窗口过后探测：主通道已恢复
    const recovered = await router.execute((a) => a.preorder(PREORDER));
    expect(recovered.adapter.channel).toBe('wechat_ecom');
    expect(recovered.degradedNow).toBe(false);
  });

  it('主备全故障 → AppError(E_CHANNEL_UNAVAILABLE, 503)', async () => {
    const primary = new MockChannelAdapter('wechat_ecom', 'm', 's');
    const backup = new MockChannelAdapter('alipay', 'm', 's');
    const { router } = makeRouter(primary, backup);
    primary.fault = { kind: 'CHANNEL_ERROR' };
    backup.fault = { kind: 'CHANNEL_ERROR' };
    try {
      await router.execute((a) => a.preorder(PREORDER));
      expect.unreachable('双通道全故障必须抛出');
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.ChannelUnavailable);
      expect((e as AppError).httpStatus).toBe(503);
    }
  });

  it('INSUFFICIENT 业务应答不触发切换（原样上抛，备用通道不接管）', async () => {
    const primary = new MockChannelAdapter('wechat_ecom', 'm', 's');
    const backup = new MockChannelAdapter('alipay', 'm', 's');
    const { router } = makeRouter(primary, backup);
    primary.fault = { kind: 'INSUFFICIENT' };

    await expect(router.execute((a) => a.deduct(DEDUCT))).rejects.toMatchObject({
      kind: 'INSUFFICIENT',
    });
    expect(backup.journalSize()).toBe(0); // 备用未沾流量
  });

  it('statement 直连指定适配器（不经 failover——对账必须用指令实际发生通道的账单）', async () => {
    const primary = new MockChannelAdapter('wechat_ecom', 'm', 's');
    const backup = new MockChannelAdapter('alipay', 'm', 's');
    const { router } = makeRouter(primary, backup);
    await primary.preorder(PREORDER);
    const lines = await router.statementOf('wechat_ecom', '2026-10-16');
    expect(lines.length).toBe(1);
  });
});

describe('assertOutboundTarget（出站校验：拒绝环回/私网 host——沿 E1/W2 守卫形态，M2 真通道接入位）', () => {
  it.each([
    'http://127.0.0.1/api',
    'https://localhost/pay',
    'http://10.1.2.3/pay',
    'https://192.168.1.1/pay',
    'https://172.16.0.9/pay',
    'https://172.31.255.255/pay',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/pay',
    'http://0.0.0.0/pay',
  ])('拒绝环回/私网：%s', (url) => {
    expect(() => assertOutboundTarget(url)).toThrow(AppError);
    try {
      assertOutboundTarget(url);
    } catch (e) {
      expect((e as AppError).code).toBe(ErrorCode.ConfigInvalid);
    }
  });

  it.each(['mockpay://wechat_ecom/pay?order_id=1', 'https://pay.example.com/v1/pay'])(
    '放行非网络形态/公网地址：%s',
    (url) => {
      expect(() => assertOutboundTarget(url)).not.toThrow();
    },
  );
});
