/**
 * tone → 徽标底/字色映射单源（M3-W1 T6 评审 S5 收编）：session-card / enrollment-row /
 * MessagesScreen 三处同构 TONE_BG/TONE_TEXT 的唯一出口，组件禁再散写 tone→色映射。
 *
 * 五档并集（=TradeStatusTone；session-copy SessionStatusTone / notify-copy NotifyTone
 * 均为其子集/同集，索引类型安全）；值与原三处逐项一致——机械替换零行为变化。
 * 档位语义：open 进行前（绿浅底）/ grouped 成团链（绿浅底）/ live 进行链（红浅底·焦点）/
 * finished 终态（灰浅底）/ failed 失败链（红浅底·危险态）。
 */
import type { TradeStatusTone } from '../api/trade-copy';
import { colors } from './tokens';

/** tone → 徽标浅底 */
export const TONE_BG: Readonly<Record<TradeStatusTone, string>> = {
  open: colors.primary2A15, // 原型 .pill-g
  grouped: colors.primary2A15, // 原型 .pill-g（成团链同款绿浅底）
  live: colors.accentCard, // 焦点态=点缀红浅底
  finished: colors.ink2A15, // 原型 .pill-n
  failed: colors.accentCard, // 危险态=点缀红浅底
};

/** tone → 徽标字色 */
export const TONE_TEXT: Readonly<Record<TradeStatusTone, string>> = {
  open: colors.primary,
  grouped: colors.primary,
  live: colors.accentDk,
  finished: colors.ink2,
  failed: colors.accentDk,
};
