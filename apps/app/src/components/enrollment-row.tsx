/**
 * 报名行组件（M3-W1 T4）：「我的报名」「我的拼团（参与的报名）」共用行。
 *
 * 信息层级：类型徽标（ref_type）+ 支付状态徽标（enrollPayStatusCopy tone）→ 上下文行
 * （场次：开场时间+城市；拼团：编号）→ 金额明细（paid 主位 / cash+points 拆分）→
 * 退款态徽标（refund_status ≠ NONE 才渲染）+ 报名时间。
 * 金额一律 formatMoney/money 单一出口；状态文案一律 trade-copy 单源。
 */
import { StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../api/money';
import type { EnrollmentMineItem } from '../api/enrollments';
import { enrollRefTypeCopy, enrollPayStatusCopy, refundStatusCopy } from '../api/trade-copy';
import type { TradeStatusCopy } from '../api/trade-copy';
import { formatMonthDayTime } from '../utils/date';
import { GlassCard } from './ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { TONE_BG, TONE_TEXT } from '../design/tone-tokens'; // tone→色单源（T6 评审 S5，原三处同构映射收编）

/** 交易态徽标（label/tone=trade-copy 映射表单源） */
export function TradeBadge({
  copy,
  failed,
}: {
  readonly copy: TradeStatusCopy;
  readonly failed?: boolean;
}) {
  return (
    <View
      style={[styles.badge, { backgroundColor: TONE_BG[copy.tone] }, failed && styles.badgeFailed]}
    >
      <Text style={[styles.badgeText, { color: TONE_TEXT[copy.tone] }]}>{copy.label}</Text>
    </View>
  );
}

export interface EnrollmentRowProps {
  readonly item: EnrollmentMineItem;
  /** 上下文行（调用方组装：场次=开场时间+城市；拼团=编号——enrich 失败时降级文案） */
  readonly contextLine: string;
}

export function EnrollmentRow({ item: e, contextLine }: EnrollmentRowProps) {
  const payCopy = enrollPayStatusCopy(e.status);
  const refundCopy = refundStatusCopy(e.refund_status);
  return (
    <GlassCard style={styles.card}>
      <View style={styles.tagRow}>
        <View style={styles.tagGroup}>
          <Text style={styles.tagPrimary}>{enrollRefTypeCopy(e.ref_type)}</Text>
          <Text style={styles.tag}>#{e.ref_id}</Text>
        </View>
        <TradeBadge copy={payCopy} />
      </View>

      <Text style={styles.context} numberOfLines={2}>
        {contextLine}
      </Text>

      <View style={styles.divider} />

      <View style={styles.bottomRow}>
        <View style={styles.amountBlock}>
          <Text style={styles.amountMain}>{formatMoney(e.amounts.paid)}</Text>
          <Text style={styles.amountNote}>
            {`现金 ${formatMoney(e.amounts.cash)}`}
            {e.amounts.points > 0 ? ` · 积分抵扣 ${e.amounts.points}` : ''}
          </Text>
        </View>
        <View style={styles.rightBlock}>
          {e.refund_status !== 'NONE' ? <TradeBadge copy={refundCopy} failed /> : null}
          <Text style={styles.time}>报名于 {formatMonthDayTime(e.created_at)}</Text>
        </View>
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, gap: spacing.sm },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  tagGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  tagPrimary: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  tag: { color: colors.ink2, fontSize: fontSize.sm },
  badge: { borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 3 },
  badgeFailed: { borderWidth: 1, borderColor: colors.dangerLine },
  badgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  context: { color: colors.ink, fontSize: fontSize.base },
  divider: { height: 1, backgroundColor: colors.line },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  amountBlock: { gap: 2 },
  amountMain: { color: colors.accent, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  amountNote: { color: colors.ink2, fontSize: fontSize.sm },
  rightBlock: { alignItems: 'flex-end', gap: spacing.xs },
  time: { color: colors.ink2, fontSize: fontSize.xs },
});
