/**
 * 首页（M3-W1 T2，T1 占位替换）：专项入口（劳动仲裁）+ 即将开场精选（GET /sessions，
 * core 按 slot_start 升序返回——首位=最近开场，作红焦点卡一组一张）+ 快捷发起拼团
 * （导航到发团 tab 占位，T3 接管）。
 *
 * ⚠契约注记：GET /sessions 公开列表仅返回报名中（CREATED）场次（core W3-12 决策）——
 * 「进行中」精选位当前无数据面，缺口见任务报告 triage；本页以「报名中 · 即将开场」承载。
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchSessions } from '../api/sessions';
import { specialtyCopy } from '../api/session-copy';
import { useResource } from '../api/useResource';
import { SessionCard } from '../components/session-card';
import { ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { Button, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, shadow, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';

const SPECIALTY = 'labor_arbitration';

/** 首页精选取前几张（原型 opening=2；焦点卡=首位一张） */
const FEATURED_COUNT = 2;

export function HomeScreen() {
  const nav = useNavigation();
  const { state, reload } = useResource(() => fetchSessions(), []);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="首页"
    >
      {/* 专项入口（V1 单垂直：劳动仲裁；选择器全集=M3 前端域任务，见 V33 头注） */}
      <GlassCard style={styles.specialtyCard}>
        <View style={styles.specialtyRow}>
          <View style={styles.specialtySeal}>
            <Text style={styles.specialtySealText}>劳</Text>
          </View>
          <View style={styles.specialtyTextBlock}>
            <Text style={styles.specialtyTitle}>{specialtyCopy(SPECIALTY)} · 组团解决劳动争议</Text>
            <MutedText>拖欠工资 · 违法解除 · 加班费 · 未签合同</MutedText>
          </View>
        </View>
        <Button label="去看场次" variant="secondary" small onPress={() => nav.setTab('sessions')} />
      </GlassCard>

      <SectionHeader
        title="律师开团 · 即将开场"
        note="报名中场次 · 按最近开场排序"
        actionLabel="全部场次 ›"
        onAction={() => nav.setTab('sessions')}
      />
      {state.phase === 'loading' ? <LoadingHint /> : null}
      {state.phase === 'error' ? <ErrorPanel error={state.error} onRetry={reload} /> : null}
      {state.phase === 'ready' ? (
        state.data.length === 0 ? (
          <GlassCard style={styles.emptyCard}>
            <MutedText>
              暂无报名中的开团场次（供给开通中）——没有合适的场次？可以直接发起拼团，让律师来接。
            </MutedText>
          </GlassCard>
        ) : (
          <View style={styles.cardList}>
            {state.data.slice(0, FEATURED_COUNT).map((s, i) => (
              <SessionCard
                key={s.id}
                session={s}
                focus={i === 0}
                onPress={(target) => nav.push({ key: 'sessionDetail', params: { id: target.id } })}
              />
            ))}
          </View>
        )
      ) : null}
      {state.phase === 'ready' && state.data.length > FEATURED_COUNT ? (
        <Button
          label={`还有 ${state.data.length - FEATURED_COUNT} 场报名中 · 查看全部`}
          variant="ghost"
          small
          onPress={() => nav.setTab('sessions')}
        />
      ) : null}

      {/* 快捷发起拼团（发团 tab=T3 施工位；红主按钮=本页唯一主操作位） */}
      <Button label="没有合适的场次？发起拼团，让律师来接" onPress={() => nav.setTab('publish')} />
      <Text style={styles.footnote}>场次由执业律师开设 · 支付前需完成实名认证</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  specialtyCard: { padding: spacing.lg, gap: spacing.md },
  specialtyRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  specialtySeal: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    backgroundColor: colors.primary2,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.primaryButton,
  },
  specialtySealText: {
    color: colors.onPrimary,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  specialtyTextBlock: { flexShrink: 1, gap: 2 },
  specialtyTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  emptyCard: { padding: spacing.xl },
  cardList: { gap: spacing.md },
  footnote: {
    color: colors.ink2,
    fontSize: fontSize.xs,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
});
