/**
 * A1 身份模块配置：密钥与 TTL 事实源（裁决 R-W2-3/R-W2-11）。
 *
 * 密钥经 src/config/app.config.ts 三层装载（进程 env > config/<env>/app.env 非 > 代码默认）：
 * - LJR_IDENTITY_PHONE_DATA_KEY：手机号列加密数据密钥（base64，解码须 32 字节 = AES-256）
 * - LJR_IDENTITY_PHONE_BLIND_PEPPER：盲索引 HMAC pepper
 * - LJR_AUTH_JWT_SECRET：JWT 签名密钥
 * dev 缺省走 dev-only 派生默认（非生产强度，仅限本机便携轨）；staging/prod 缺失即
 * E_CONFIG_MISSING（fail-fast）。密钥零字面量：测试经 IDENTITY_CONFIG 注入 randomBytes 派生值。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { loadAppConfig } from '../../config/app.config';

/** access_token 有效期秒（A1 §2/§5：2h） */
export const ACCESS_TTL_SEC = 2 * 3_600;
/** refresh_token 有效期秒（A1 §2/§5：14d） */
export const REFRESH_TTL_SEC = 14 * 24 * 3_600;
/** 验证码有效期秒（A1 §2：60s） */
export const CODE_TTL_SEC = 60;

export interface IdentityConfig {
  /** 手机号列加密数据密钥（32 字节，AES-256-GCM；mock KMS 信封 R-W2-11，prod 前换真 KMS） */
  readonly phoneDataKey: Buffer;
  /** 盲索引 HMAC-SHA256 pepper */
  readonly phoneBlindPepper: string;
  /** JWT 签名密钥（HS256） */
  readonly jwtSecret: string;
}

/** DI token（测试 override 注入测试密钥——密钥零字面量出测试） */
export const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');

/** 校验并解码数据密钥：base64 且恰 32 字节，否则 E_CONFIG_INVALID（fail-fast，防弱密钥静默入用） */
function decodePhoneDataKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new AppError(
      ErrorCode.ConfigInvalid,
      'LJR_IDENTITY_PHONE_DATA_KEY 必须是 base64 编码的 32 字节 AES-256 密钥',
    );
  }
  return key;
}

/** 装载入口（模块工厂调用一次）：经 app.config 三层解析后做数据密钥形态校验 */
export function identityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const identity = loadAppConfig(env).identity;
  return {
    phoneDataKey: decodePhoneDataKey(identity.phoneDataKey),
    phoneBlindPepper: identity.phoneBlindPepper,
    jwtSecret: identity.jwtSecret,
  };
}
