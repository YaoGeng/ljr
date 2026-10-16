/**
 * F4 权益模块配置（M1-W3 T2）：LJR_BENEFITS_POINTS_TTL_DAYS（R-02 积分 180 天有效期，
 * 可覆写）> 代码默认 180。装载口径沿 payment.config：直读进程 env；显式给值非法 →
 * E_CONFIG_INVALID fail-fast（不静默回退默认——配置错误显性化）。
 */
import { AppError, ErrorCode } from '@ljr/shared';

export interface BenefitsConfig {
  /** R-02 积分有效期天数（授予/退款还原行写入时 expires_at=DB now()+TTL） */
  readonly pointsTtlDays: number;
}

/** DI 令牌（测试 override 注入；Symbol token——纯 interface 无运行时类型） */
export const BENEFITS_CONFIG = Symbol('BENEFITS_CONFIG');

export const POINTS_TTL_DAYS_DEFAULT = 180;

/** TTL 合理上界（100 年；防误配 99999 天使过期机制实质失效） */
const TTL_DAYS_MAX = 36_500;

/** 装载入口（模块工厂调用一次） */
export function benefitsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BenefitsConfig {
  const raw = env['LJR_BENEFITS_POINTS_TTL_DAYS'];
  if (raw === undefined || raw === '') {
    return { pointsTtlDays: POINTS_TTL_DAYS_DEFAULT };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > TTL_DAYS_MAX) {
    throw new AppError(
      ErrorCode.ConfigInvalid,
      `LJR_BENEFITS_POINTS_TTL_DAYS 须为 1..${TTL_DAYS_MAX} 整数（天数）：${JSON.stringify(raw)}`,
    );
  }
  return { pointsTtlDays: value };
}
