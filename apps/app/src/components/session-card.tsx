/**
 * 场次卡片组件族（M3-W1 T2）：状态徽标 + 场次卡（首页精选/列表共用）。
 *
 * 设计意图源=prototype sessCard（信息层级：标签行→时间→价格/进度/CTA），按 API 实有字段
 * 重组（契约无标题/时长/律师名——见任务报告 triage；时间行承载主标题位）。
 * 铁律：价格数字=红点缀位（splitMoney 拆段）；focus 红焦点卡一组仅一张（accent prop）。
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { splitMoney } from '../api/money';
import { priceModeCopy, roomModeCopy, sessionStatusCopy, specialtyCopy } from '../api/session-copy';
import type { SessionView } from '../api/sessions';
import { formatDateTime } from '../utils/date';
import { Button, GlassCard } from './ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { TONE_BG, TONE_TEXT } from '../design/tone-tokens'; // tone→色单源（T6 评审 S5，原三处同构映射收编）

/** 场次状态徽标（文案/色调档=session-copy 映射表单源） */
export function SessionStatusBadge({ status }: { readonly status: string }) {
  const { label, tone } = sessionStatusCopy(status);
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: TONE_BG[tone] },
        tone === 'failed' && styles.badgeFailed,
      ]}
    >
      <Text style={[styles.badgeText, { color: TONE_TEXT[tone] }]}>{label}</Text>
    </View>
  );
}

/** 价格数字（红点缀位：¥ 小淡 + 整数段大 + 小数段小；/人 后缀淡） */
export function SessionPrice({
  unitPrice,
  suffix = '/人',
}: {
  readonly unitPrice: SessionView['unit_price'];
  readonly suffix?: string;
}) {
  const p = splitMoney(unitPrice);
  return (
    <View style={styles.priceRow}>
      <Text style={styles.priceSymbol}>{p.symbol}</Text>
      <Text style={styles.priceInt}>{p.int}</Text>
      <Text style={styles.priceDec}>{p.decWithDot}</Text>
      {suffix.length > 0 ? <Text style={styles.priceSuffix}>{suffix}</Text> : null}
    </View>
  );
}

export interface SessionCardProps {
  readonly session: SessionView;
  /** 红焦点卡（一组仅一张；首页精选首位用） */
  readonly focus?: boolean;
  readonly onPress: (session: SessionView) => void;
}

/** 场次卡：标签行 → 开场时间（主标题位）→ 截止 → 价格/进度/详情 CTA */
export function SessionCard({ session: s, focus, onPress }: SessionCardProps) {
  const remainingSeats = s.capacity - s.joined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`场次 ${formatDateTime(s.slot_start)} ${sessionStatusCopy(s.status).label}`}
      onPress={() => onPress(s)}
      style={({ pressed }) => [styles.cardPress, pressed && styles.cardPressed]}
    >
      <GlassCard style={[styles.card, focus && styles.cardFocus]}>
        <View style={styles.tagRow}>
          <View style={styles.tagGroup}>
            <Text style={styles.tagPrimary}>{specialtyCopy(s.specialty)}</Text>
            <Text style={styles.tag}>{s.city}</Text>
            <Text style={styles.tag}>{roomModeCopy(s.room_mode)}</Text>
          </View>
          <SessionStatusBadge status={s.status} />
        </View>

        <Text style={styles.headline}>{formatDateTime(s.slot_start)} 开场</Text>
        <Text style={styles.deadline}>
          报名截止 {formatDateTime(s.enroll_deadline, { weekday: false })}
        </Text>

        <View style={styles.divider} />

        <View style={styles.bottomRow}>
          <View style={styles.priceBlock}>
            <SessionPrice unitPrice={s.unit_price} />
            <Text style={styles.priceMode}>{priceModeCopy(s.price_mode)}</Text>
          </View>
          <View style={styles.progressBlock}>
            <View style={styles.progressTextRow}>
              <Text style={styles.progressText}>
                已报 {s.joined}/{s.capacity}
              </Text>
              <Text style={styles.progressText}>
                {remainingSeats > 0 ? `还差 ${remainingSeats} 人` : '已满员'}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, (s.joined / s.capacity) * 100)}%` },
                ]}
              />
            </View>
          </View>
          <Button label="详情" variant="secondary" small onPress={() => onPress(s)} />
        </View>
      </GlassCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
  },
  badgeFailed: {
    borderWidth: 1,
    borderColor: colors.dangerLine,
  },
  badgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end' },
  priceSymbol: { color: colors.accent, fontSize: fontSize.md, marginBottom: 1 },
  priceInt: { color: colors.accent, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  priceDec: { color: colors.accent, fontSize: fontSize.base, marginBottom: 1 },
  priceSuffix: { color: colors.ink2, fontSize: fontSize.sm, marginBottom: 2, marginLeft: 2 },
  cardPress: { borderRadius: radius.card },
  cardPressed: { opacity: 0.88, transform: [{ scale: 0.99 }] },
  card: { padding: spacing.lg, gap: spacing.sm },
  cardFocus: {
    backgroundColor: colors.accentCard,
    borderColor: colors.accentSoft,
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  tagGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  tagPrimary: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  tag: { color: colors.ink2, fontSize: fontSize.sm },
  headline: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  deadline: { color: colors.ink2, fontSize: fontSize.sm },
  divider: { height: 1, backgroundColor: colors.line },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  priceBlock: { gap: 2 },
  priceMode: { color: colors.ink2, fontSize: fontSize.xs },
  progressBlock: { flex: 1, gap: 4, minWidth: 96 },
  progressTextRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressText: { color: colors.ink2, fontSize: fontSize.xs },
  progressTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A18, // 进度槽底（原型 .prog 轨道色，评审 I3 收编 token）
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primary2,
  },
});
