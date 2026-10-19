/**
 * C5 改期配置（group-buy.config 同款形态，⚠M2-W2 T5 配置化要求）：
 *   - confirmTimeoutHours：律师确认窗（C5 §2/§4「12h」；expires_at=requested_at+N 小时，
 *     RESCHEDULE_CONFIRM_TIMEOUT job 锚；env 键 LJR_TRADE_RESCHEDULE_CONFIRM_TIMEOUT_HOURS）；
 *   - requestLeadHours：R-01 申请前置窗（PRD §8.7「开始前 ≥2h 可申请免费改期一次」；
 *     ⚠裁定锚=原场次 scheduled_start（slot_start）——C5 §7 R-01「开始前」字面锚定原场次，
 *     目标场次时刻不构成申请门槛（报告裁定注记）；env 键 LJR_TRADE_RESCHEDULE_LEAD_HOURS）。
 */
import { InjectionToken } from '@nestjs/common';

export interface TradeRescheduleConfig {
  /** 律师确认窗小时数（§2/§4 默认 12；expires_at 与超时 job 锚） */
  readonly confirmTimeoutHours: number;
  /** R-01 申请前置窗小时数（PRD §8.7 默认 2；锚=原场次 slot_start） */
  readonly requestLeadHours: number;
}

/** DI 令牌（TRADE_GROUP_BUY_CONFIG 同款 Symbol 口径：纯 interface 无运行时类型 token） */
export const TRADE_RESCHEDULE_CONFIG: InjectionToken<TradeRescheduleConfig> =
  Symbol('TRADE_RESCHEDULE_CONFIG');

export const RESCHEDULE_CONFIRM_TIMEOUT_HOURS_DEFAULT = 12;
export const RESCHEDULE_LEAD_HOURS_DEFAULT = 2;

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** env > 代码默认；非法/非正回落默认（配置容错，group-buy.config 同款不抛） */
export function tradeRescheduleConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TradeRescheduleConfig {
  return {
    confirmTimeoutHours: positiveIntFromEnv(
      env['LJR_TRADE_RESCHEDULE_CONFIRM_TIMEOUT_HOURS'],
      RESCHEDULE_CONFIRM_TIMEOUT_HOURS_DEFAULT,
    ),
    requestLeadHours: positiveIntFromEnv(
      env['LJR_TRADE_RESCHEDULE_LEAD_HOURS'],
      RESCHEDULE_LEAD_HOURS_DEFAULT,
    ),
  };
}
