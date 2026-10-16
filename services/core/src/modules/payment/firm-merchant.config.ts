/**
 * A3b 进件子域配置（M1-W3 T3）：LJR_PAYMENT_* 前缀两键（与 F1 payment.config 同域同装载口径：
 * 直读进程 env，dev 缺省 mock 值，staging/prod 缺失/非法即 fail-fast）。
 *   - LJR_PAYMENT_DEPOSIT_AMOUNT：保证金冻结默认金额（⚠W3-D4 金额配置化；⚠04§8-4 保证金金额
 *     与缴纳时点=待澄清点——dev 缺省为占位 mock 值，生产缺失 E_CONFIG_MISSING 不静默）；
 *   - LJR_PAYMENT_REVERIFY_DAYS：年度复验期天数（R-03「每年 ≥1 次」的窗口承载，默认 365）。
 */
import { AppError, ErrorCode, assertMoney, type Money } from '@ljr/shared';
import { normalizeEnvName } from '../../config/app.config';

export interface FirmMerchantConfig {
  /** 保证金冻结默认金额（入参缺省时的台账先行值，⚠W3-D4） */
  readonly depositAmount: Money;
  /** 年度复验期天数（→ACTIVE 写 reverify_due=now()+N 天，FIRM_REVERIFY job 锚） */
  readonly reverifyDays: number;
}

/** DI 令牌（测试 override 注入；Symbol token——纯 interface 无运行时类型） */
export const FIRM_MERCHANT_CONFIG = Symbol('FIRM_MERCHANT_CONFIG');

export const DEPOSIT_AMOUNT_DEV_DEFAULT = '2000.00';
export const REVERIFY_DAYS_DEFAULT = 365;
/** 复验期合理上界（100 年，防误配使复验机制实质失效） */
const REVERIFY_DAYS_MAX = 36_500;

/** 装载入口（模块工厂调用一次） */
export function firmMerchantConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FirmMerchantConfig {
  const envName = normalizeEnvName(env['LJR_ENV']);
  const rawAmount = env['LJR_PAYMENT_DEPOSIT_AMOUNT'];
  let depositAmount: Money = DEPOSIT_AMOUNT_DEV_DEFAULT;
  if (rawAmount !== undefined && rawAmount !== '') {
    depositAmount = assertMoney(rawAmount); // 非法即 422 fail-fast（不静默回退）
  } else if (envName !== 'dev') {
    throw new AppError(
      ErrorCode.ConfigMissing,
      `环境 ${envName} 必须注入 LJR_PAYMENT_DEPOSIT_AMOUNT（保证金默认金额，⚠04§8-4 待澄清；dev 有占位缺省）`,
    );
  }
  const rawDays = env['LJR_PAYMENT_REVERIFY_DAYS'];
  let reverifyDays = REVERIFY_DAYS_DEFAULT;
  if (rawDays !== undefined && rawDays !== '') {
    const value = Number(rawDays);
    if (!Number.isInteger(value) || value <= 0 || value > REVERIFY_DAYS_MAX) {
      throw new AppError(
        ErrorCode.ConfigInvalid,
        `LJR_PAYMENT_REVERIFY_DAYS 须为 1..${REVERIFY_DAYS_MAX} 整数（天数）：${JSON.stringify(rawDays)}`,
      );
    }
    reverifyDays = value;
  }
  return { depositAmount, reverifyDays };
}
