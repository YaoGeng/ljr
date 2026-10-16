/**
 * C1 场次配置（⚠04§8-3 + §8 缓存口径）：
 *   - enrollDeadlineHours：报名截止缺省=slot_start 前 N 小时（架构 §4.1/B3 ⚠04§8-3「默认开始
 *     前 24h，律师可改；规则待产品确认」——常量可经 env 配置化（LJR_TRADE_ENROLL_DEADLINE_HOURS），
 *     产品拍板后改配置即可，M2-W2 联调回写文档；
 *   - listCacheTtlMs：列表 30s 进程内缓存适配位（§8「列表 P95 ≤300ms（缓存 30s）」；沿 W2 形态
 *     ——pricing/credit/time-table 三先例，dev 无 Redis，prod 换装同接口）。
 */
import { InjectionToken } from '@nestjs/common';

export interface TradeSessionConfig {
  /** 报名截止缺省偏移（小时，⚠04§8-3 默认 24） */
  readonly enrollDeadlineHours: number;
  /** 列表缓存 TTL 毫秒（§8：30s） */
  readonly listCacheTtlMs: number;
}

/** DI 令牌（PRICING_CACHE_CONFIG 同款 Symbol 口径：纯 interface 无运行时类型 token） */
export const TRADE_SESSION_CONFIG: InjectionToken<TradeSessionConfig> =
  Symbol('TRADE_SESSION_CONFIG');

export const ENROLL_DEADLINE_HOURS_DEFAULT = 24;
export const TRADE_LIST_CACHE_TTL_MS_DEFAULT = 30_000;

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** env > 代码默认；非法/非正回落默认（配置容错，pricing.cache 同款不抛） */
export function tradeSessionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TradeSessionConfig {
  return {
    enrollDeadlineHours: positiveIntFromEnv(
      env['LJR_TRADE_ENROLL_DEADLINE_HOURS'],
      ENROLL_DEADLINE_HOURS_DEFAULT,
    ),
    listCacheTtlMs: positiveIntFromEnv(
      env['LJR_TRADE_LIST_CACHE_TTL_MS'],
      TRADE_LIST_CACHE_TTL_MS_DEFAULT,
    ),
  };
}
