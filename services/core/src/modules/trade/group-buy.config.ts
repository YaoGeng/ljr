/**
 * C2 拼团配置（⚠04§8-3 + §4 12h 确认窗 + §8 缓存口径）：
 *   - enrollDeadlineHours：成团截止缺省=slot_start 前 N 小时（⚠04§8-3「默认开始前 24h」——与
 *     C1 session.config 同源口径，常量可经 env 配置化（LJR_TRADE_ENROLL_DEADLINE_HOURS 共用键），
 *     产品拍板后改配置即可；
 *   - confirmTimeoutHours：律师确认窗（§4「PENDING_LAWYER(12h)」；C2B_CONFIRM_TIMEOUT job 锚
 *     lawyer_confirm_by=REACHED 时点+N 小时；env 键 LJR_TRADE_C2B_CONFIRM_TIMEOUT_HOURS）；
 *   - listCacheTtlMs：列表 30s 进程内缓存适配位（沿 C1/W2 形态——pricing/credit/time-table
 *     三先例，dev 无 Redis，prod 换装同接口）。
 */
import { InjectionToken } from '@nestjs/common';
import { ENROLL_DEADLINE_HOURS_DEFAULT } from './session.config';

export interface TradeGroupBuyConfig {
  /** 成团截止缺省偏移（小时，⚠04§8-3 默认 24） */
  readonly enrollDeadlineHours: number;
  /** 律师确认窗小时数（§4 默认 12；C2B_CONFIRM_TIMEOUT job 锚） */
  readonly confirmTimeoutHours: number;
  /** 列表缓存 TTL 毫秒（§8：30s） */
  readonly listCacheTtlMs: number;
}

/** DI 令牌（TRADE_SESSION_CONFIG 同款 Symbol 口径：纯 interface 无运行时类型 token） */
export const TRADE_GROUP_BUY_CONFIG: InjectionToken<TradeGroupBuyConfig> =
  Symbol('TRADE_GROUP_BUY_CONFIG');

export const CONFIRM_TIMEOUT_HOURS_DEFAULT = 12;
export const GROUP_BUY_LIST_CACHE_TTL_MS_DEFAULT = 30_000;

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** env > 代码默认；非法/非正回落默认（配置容错，session.config 同款不抛） */
export function tradeGroupBuyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TradeGroupBuyConfig {
  return {
    enrollDeadlineHours: positiveIntFromEnv(
      env['LJR_TRADE_ENROLL_DEADLINE_HOURS'],
      ENROLL_DEADLINE_HOURS_DEFAULT,
    ),
    confirmTimeoutHours: positiveIntFromEnv(
      env['LJR_TRADE_C2B_CONFIRM_TIMEOUT_HOURS'],
      CONFIRM_TIMEOUT_HOURS_DEFAULT,
    ),
    listCacheTtlMs: positiveIntFromEnv(
      env['LJR_TRADE_LIST_CACHE_TTL_MS'],
      GROUP_BUY_LIST_CACHE_TTL_MS_DEFAULT,
    ),
  };
}
