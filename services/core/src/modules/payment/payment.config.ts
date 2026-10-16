/**
 * F1 支付网关配置（⚠W3-3：通道密钥/商户号经 env 注入，LJR_PAYMENT_* 前缀）。
 *
 * 装载口径（identity.config 与 pricing.cache 两先例的折中，本批裁决）：直读进程 env
 * （密钥天然 env-only，不经 config/<env>/app.env 文件层——「密钥禁入文件层」由不读文件结构性
 * 满足；dev 缺省给 mock 值——Task 1 简报明示「dev 默认 mock 值允许，禁真实凭据字面量」，
 * mock 值为明显假名非真实凭据；staging/prod 缺失即 E_CONFIG_MISSING fail-fast）。
 * 密钥零字面量：测试经 PAYMENT_CONFIG 注入 randomBytes 派生值。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { normalizeEnvName } from '../../config/app.config';
import type { PaymentChannelName } from './payment.channels';

export interface PaymentChannelCredentials {
  readonly channel: PaymentChannelName;
  /** 商户号（wechat）/ 应用 ID（alipay）；mock 默认明显假名 */
  readonly merchantId: string;
  /** 通道密钥（HMAC-SHA256 回调验签；env 注入） */
  readonly secret: string;
}

export interface PaymentConfig {
  /** 主通道：微信电商收付通（§2） */
  readonly primary: PaymentChannelCredentials;
  /** 备通道：支付宝直联（§2） */
  readonly backup: PaymentChannelCredentials;
  /** 降级窗口毫秒（§8 单通道故障 5min 内切换的窗口承载） */
  readonly switchWindowMs: number;
}

/** DI 令牌（测试 override 注入测试密钥——密钥零字面量出测试） */
export const PAYMENT_CONFIG = Symbol('PAYMENT_CONFIG');

/** §8：切换 SLA 5min（窗口内流量恒走备用，窗口过后流量探测恢复） */
export const PAYMENT_SWITCH_WINDOW_MS_DEFAULT = 300_000;

interface ChannelEnvKeys {
  readonly merchantId: string;
  readonly secret: string;
  readonly mockMerchantId: string;
  readonly mockSecret: string;
  readonly label: string;
}

const WECHAT_KEYS: ChannelEnvKeys = {
  merchantId: 'LJR_PAYMENT_WECHAT_MCH_ID',
  secret: 'LJR_PAYMENT_WECHAT_SECRET',
  mockMerchantId: 'mock-wechat-ecom-mch',
  mockSecret: 'mock-wechat-ecom-secret',
  label: 'wechat_ecom',
};

const ALIPAY_KEYS: ChannelEnvKeys = {
  merchantId: 'LJR_PAYMENT_ALIPAY_APP_ID',
  secret: 'LJR_PAYMENT_ALIPAY_SECRET',
  mockMerchantId: 'mock-alipay-app-id',
  mockSecret: 'mock-alipay-secret',
  label: 'alipay',
};

function resolveChannel(
  env: NodeJS.ProcessEnv,
  envName: 'dev' | 'staging' | 'prod',
  keys: ChannelEnvKeys,
): PaymentChannelCredentials {
  const merchantId = env[keys.merchantId];
  const secret = env[keys.secret];
  if ((merchantId === undefined || merchantId === '') || (secret === undefined || secret === '')) {
    if (envName === 'dev') {
      return { channel: keys.label as PaymentChannelName, merchantId: keys.mockMerchantId, secret: keys.mockSecret };
    }
    throw new AppError(
      ErrorCode.ConfigMissing,
      `环境 ${envName} 必须注入 ${keys.merchantId} 与 ${keys.secret}（通道密钥禁入配置文件；dev 有 mock 缺省值）`,
    );
  }
  return { channel: keys.label as PaymentChannelName, merchantId, secret };
}

/** 装载入口（模块工厂调用一次）：env 名经 normalizeEnvName（与 app.config 同一归一口径） */
export function paymentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const envName = normalizeEnvName(env['LJR_ENV']);
  const rawWindow = Number(env['LJR_PAYMENT_SWITCH_WINDOW_MS']);
  return {
    primary: resolveChannel(env, envName, WECHAT_KEYS),
    backup: resolveChannel(env, envName, ALIPAY_KEYS),
    switchWindowMs:
      Number.isFinite(rawWindow) && rawWindow > 0
        ? Math.floor(rawWindow)
        : PAYMENT_SWITCH_WINDOW_MS_DEFAULT,
  };
}
