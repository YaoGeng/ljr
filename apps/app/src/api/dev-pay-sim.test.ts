import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { isDevPaySimEnabled, simulatePaySuccess, signCallbackPayload } from './dev-pay-sim';
import { setApiBaseUrl } from './config';
import { jsonResponse, stubFetch } from './test-helpers';

const ENV_KEYS = ['EXPO_PUBLIC_DEV_PAY_SIM', 'EXPO_PUBLIC_DEV_PAY_SECRET'] as const;

beforeEach(() => {
  setApiBaseUrl('http://core.test');
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('dev 支付模拟器（#40 直接成功口径 dev 路径，dev-gated 红线）', () => {
  it('未设 EXPO_PUBLIC_DEV_PAY_SIM → 不启用（视图层不得出现模拟支付入口）', () => {
    expect(isDevPaySimEnabled()).toBe(false);
  });

  it('开了总闸但缺 EXPO_PUBLIC_DEV_PAY_SECRET → 仍不启用（秘钥零字面量，运行时 env 注入）', () => {
    process.env.EXPO_PUBLIC_DEV_PAY_SIM = '1';
    expect(isDevPaySimEnabled()).toBe(false);
  });

  it('评审 I2：只给 secret 不开总闸 → 仍不启用；simulatePaySuccess 同闸显性报错（请求未发出）', async () => {
    process.env.EXPO_PUBLIC_DEV_PAY_SECRET = 'sim-secret';
    expect(isDevPaySimEnabled()).toBe(false);
    const seen = stubFetch([]);
    const err = (await simulatePaySuccess(9001).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('dev 支付模拟器未启用');
    expect(seen).toHaveLength(0);
  });

  it('双条件齐备 → 启用', () => {
    process.env.EXPO_PUBLIC_DEV_PAY_SIM = '1';
    process.env.EXPO_PUBLIC_DEV_PAY_SECRET = 'sim-secret';
    expect(isDevPaySimEnabled()).toBe(true);
  });

  it('回调签名与 node:crypto 同构（w3-smoke postCallback 同款 HMAC-SHA256 hex）', () => {
    const payload =
      '{"order_id":9001,"event_type":"PAY_SUCCESS","channel_txn_no":"MOCK-APP-9001-1"}';
    expect(signCallbackPayload('sim-secret', payload)).toBe(
      createHmac('sha256', 'sim-secret').update(payload).digest('hex'),
    );
  });

  it('模拟支付：POST /callbacks/{channel}，签名覆盖发送原文（字节级一致），报文含 order_id/PAY_SUCCESS', async () => {
    process.env.EXPO_PUBLIC_DEV_PAY_SIM = '1';
    process.env.EXPO_PUBLIC_DEV_PAY_SECRET = 'sim-secret';
    const seen = stubFetch([jsonResponse(200, { inboxed: true, inbox_id: 5 })]);
    const r = await simulatePaySuccess(9001, 'wechat_ecom');
    expect(r.inboxed).toBe(true);
    expect(seen[0]?.url).toBe('http://core.test/callbacks/wechat_ecom');
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string>; body?: string };
    expect(init.method).toBe('POST');
    const body = String(init.body);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed['order_id']).toBe(9001);
    expect(parsed['event_type']).toBe('PAY_SUCCESS');
    expect(typeof parsed['channel_txn_no']).toBe('string');
    // 签名=对发送原文（同一字符串）的 HMAC——core rawBody 验签的字节级前提
    expect(init.headers['x-payment-signature']).toBe(
      createHmac('sha256', 'sim-secret').update(body).digest('hex'),
    );
  });

  it('通道缺省=主通道 wechat_ecom（C2 发布出参无 channel 的兜底）', async () => {
    process.env.EXPO_PUBLIC_DEV_PAY_SIM = '1';
    process.env.EXPO_PUBLIC_DEV_PAY_SECRET = 'sim-secret';
    const seen = stubFetch([jsonResponse(200, { inboxed: false, inbox_id: null })]);
    const r = await simulatePaySuccess(9002);
    expect(r.inboxed).toBe(false); // 重复回调被 Inbox 去重=已受理语义
    expect(seen[0]?.url).toBe('http://core.test/callbacks/wechat_ecom');
  });

  it('模拟器未启用时调用 → 显性报错（不静默假装成功）', async () => {
    stubFetch([]);
    const err = (await simulatePaySuccess(9001).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('dev 支付模拟器未启用');
  });

  it('回调被拒（403 E_SIGN_FAIL）→ 透传 HTTP 状态与错误体（不吞错）', async () => {
    process.env.EXPO_PUBLIC_DEV_PAY_SIM = '1';
    process.env.EXPO_PUBLIC_DEV_PAY_SECRET = 'wrong-secret'; // 与 core 侧不同值 → 验签必败
    stubFetch([jsonResponse(403, { code: 'E_SIGN_FAIL', message: '回调验签失败' })]);
    const err = (await simulatePaySuccess(9001).then(
      () => null,
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain('HTTP 403');
  });
});
