/**
 * 场次详情（M3-W1 T2，推栈接管）：GET /sessions/{id}——状态徽标/价格/时间/地点（城市+
 * 沟通形式）/已报名进度 + 底部「立即报名」CTA（推栈 enrollmentPlaceholder，T3 接管真流）。
 * 加载/错误/空三态齐备（fail-visible：错误走 error-messages 映射文案 + 重试）。
 *
 * 报名闸（R-02 成团后不收新报名）：仅 CREATED（报名中）且有余位开放 CTA（评审 S4：
 * CREATED+remaining=0 为「已满员」UX 前置闸——core 侧另有权威闸）；其余态禁用并显示
 * 状态文案——关闭说明按状态链分组单源出（session-copy sessionClosedNote，评审 I2）。
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../api/money';
import { fetchSessionDetail } from '../api/sessions';
import {
  priceModeCopy,
  roomModeCopy,
  sessionClosedNote,
  sessionStatusCopy,
  specialtyCopy,
} from '../api/session-copy';
import { useResource } from '../api/useResource';
import { SessionPrice, SessionStatusBadge } from '../components/session-card';
import { ErrorPanel, LoadingHint } from '../components/state-views';
import { Button, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTime, formatDateTimeFull } from '../utils/date';

export function SessionDetailScreen({
  params,
}: {
  readonly params?: Readonly<Record<string, unknown>>;
}) {
  const nav = useNavigation();
  const rawId = params?.['id'];
  const id = typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  const { state, reload } = useResource(
    () => (id === null ? Promise.reject(new InvalidSessionIdError(rawId)) : fetchSessionDetail(id)),
    [id],
  );

  if (state.phase === 'loading') {
    return <LoadingHint label="场次详情加载中…" />;
  }
  if (state.phase === 'error') {
    return (
      <View style={styles.errorWrap}>
        <ErrorPanel error={state.error} onRetry={reload} />
        <Button label="返回" variant="ghost" small onPress={nav.pop} />
      </View>
    );
  }

  const s = state.data;
  const fullButOpen = s.status === 'CREATED' && s.remaining === 0; // S4：报名中但已满员
  const enrollable = s.status === 'CREATED' && s.remaining > 0;
  const copy = sessionStatusCopy(s.status);

  return (
    <View style={styles.frame}>
      <ScrollView contentContainerStyle={styles.content} accessibilityLabel="场次详情">
        <GlassCard style={styles.infoCard}>
          <View style={styles.tagRow}>
            <View style={styles.tagGroup}>
              <Text style={styles.tagPrimary}>{specialtyCopy(s.specialty)}</Text>
              <Text style={styles.tag}>{s.city}</Text>
              <Text style={styles.tag}>{roomModeCopy(s.room_mode)}咨询</Text>
              <Text style={styles.tag}>B2C · 律师开团</Text>
            </View>
            <SessionStatusBadge status={s.status} />
          </View>

          <Text style={styles.headline}>{formatDateTime(s.slot_start)} 开场</Text>

          <View style={styles.divider} />
          <View style={styles.grid}>
            <InfoRow label="开场时间" value={formatDateTimeFull(s.slot_start)} />
            <InfoRow label="报名截止" value={formatDateTimeFull(s.enroll_deadline)} />
            <InfoRow label="地点" value={`${s.city} · 线上${roomModeCopy(s.room_mode)}`} />
            <InfoRow label="专项" value={specialtyCopy(s.specialty)} />
          </View>
        </GlassCard>

        <GlassCard style={styles.priceCard}>
          <View style={styles.priceTopRow}>
            <View style={styles.priceBlock}>
              <SessionPrice unitPrice={s.unit_price} />
              <MutedText>{priceModeCopy(s.price_mode)} · 每人份（价格快照）</MutedText>
            </View>
            {s.price_mode === 'session_total' ? (
              <View style={styles.totalBlock}>
                <MutedText>场次总价</MutedText>
                {/* 金额展示单一出口（评审 I1：禁模板串直拼绕过 formatMoney） */}
                <Text style={styles.totalText}>{formatMoney(s.session_total)}</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.progressTextRow}>
            <Text style={styles.progressLabel}>
              拼团进度 · 已报 {s.joined}/{s.capacity}（剩余席位 {s.remaining}）
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
          <MutedText>
            {s.status === 'CREATED'
              ? `未达人数到报名截止（${formatDateTime(s.enroll_deadline, { weekday: false })}）将流标并全额自动退款；满 ${s.capacity} 人即成团锁人。`
              : sessionClosedNote(s.status)}
          </MutedText>
        </GlassCard>

        <GlassCard style={styles.noteCard}>
          <Text style={styles.noteTitle}>价格快照说明</Text>
          <MutedText>
            支付时锁定的价格即最终价格，律师后续改价不影响已报名次（PRD §8.2 价格快照口径）。
          </MutedText>
        </GlassCard>
      </ScrollView>

      <View style={styles.ctaBar}>
        {enrollable ? (
          <Button
            label="立即报名"
            onPress={() => nav.push({ key: 'enrollmentPlaceholder', params: { sessionId: s.id } })}
          />
        ) : fullButOpen ? (
          /* S4：报名中但已满员（core 侧另有权威闸，此为 UX 前置） */
          <Button label="已满员 · 暂不可报名" variant="ghost" disabled onPress={() => undefined} />
        ) : (
          <Button
            label={`${copy.label} · 暂不可报名`}
            variant="ghost"
            disabled
            onPress={() => undefined}
          />
        )}
      </View>
    </View>
  );
}

/** 路由参数非法（无 id/非整数）：本地错误（不发出请求） */
class InvalidSessionIdError extends Error {
  constructor(raw: unknown) {
    super(`场次路由参数无效：${JSON.stringify(raw)}`);
    this.name = 'InvalidSessionIdError';
  }
}

function InfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  errorWrap: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
  content: { padding: spacing.lg, gap: spacing.md },
  infoCard: { padding: spacing.lg, gap: spacing.md },
  tagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tagGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  tagPrimary: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  tag: { color: colors.ink2, fontSize: fontSize.sm },
  headline: { color: colors.ink, fontSize: fontSize.xxl, fontWeight: fontWeight.semibold },
  divider: { height: 1, backgroundColor: colors.line },
  grid: { gap: spacing.sm },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  infoLabel: { color: colors.ink2, fontSize: fontSize.base },
  infoValue: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  priceCard: { padding: spacing.lg, gap: spacing.md },
  priceTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  priceBlock: { gap: 2 },
  totalBlock: { alignItems: 'flex-end', gap: 2 },
  totalText: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  progressTextRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A18, // 进度槽底（原型 .prog 轨道色，评审 I3 收编 token）
    overflow: 'hidden',
  },
  progressFill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.primary2 },
  noteCard: { padding: spacing.lg, gap: spacing.xs },
  noteTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  ctaBar: {
    padding: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.glassHi,
    backgroundColor: 'rgba(255,255,255,0.62)', // 底栏玻璃面（tabbar 同款降级档）
  },
});
