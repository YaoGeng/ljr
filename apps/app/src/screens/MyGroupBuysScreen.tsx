/**
 * 我的拼团（M3-W1 T4，推栈页）：按契约核实结论如实呈现两个可得面——
 *   ①「我发起的拼团」：GET /group-buys 公开列表（仅 PUBLISHED+PASSED 律师）按 initiator_id
 *     过滤（GroupBuyView 含 initiator_id，此路通）；⚠无 /group-buys/mine，状态推进（成团链/
 *     终态）或律师失审后本人发起历史即从公开列表消失——历史可见性契约缺口见任务报告 triage，
 *     本页以注记如实告知，不发明数据；
 *   ②「我参与的拼团报名」：GET /enrollments/mine 中 ref_type=groupbuy 的行（与我的报名同源）。
 * 发起新团入口 → 发团 tab（setTab=publish）。
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchMyEnrollments, type EnrollmentMineItem } from '../api/enrollments';
import { fetchGroupBuys, filterInitiatedBy, type GroupBuyView } from '../api/group-buys';
import { splitMoney } from '../api/money';
import { groupBuyStatusCopy } from '../api/trade-copy';
import { useResource } from '../api/useResource';
import { useSession } from '../api/useSession';
import { EnrollmentRow, TradeBadge } from '../components/enrollment-row';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { Button, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTime } from '../utils/date';

interface MyGroupBuysData {
  readonly initiated: readonly GroupBuyView[];
  readonly joined: readonly EnrollmentMineItem[];
}

/** 发起的团卡片（拼团中窗口内；金额红点缀价） */
function InitiatedCard({ gb }: { readonly gb: GroupBuyView }) {
  const p = splitMoney(gb.share_price);
  return (
    <GlassCard style={styles.card}>
      <View style={styles.tagRow}>
        <View style={styles.tagGroup}>
          <Text style={styles.tagPrimary}>{`${gb.sub_min}-${gb.sub_max} 人成团`}</Text>
          <Text style={styles.tag}>{gb.city}</Text>
        </View>
        <TradeBadge copy={groupBuyStatusCopy(gb.status)} />
      </View>
      <Text style={styles.headline}>{`${formatDateTime(gb.slot_start)} 开场`}</Text>
      <Text
        style={styles.deadline}
      >{`报名截止 ${formatDateTime(gb.deadline, { weekday: false })}`}</Text>
      <View style={styles.priceRow}>
        <Text style={styles.priceSymbol}>{p.symbol}</Text>
        <Text style={styles.priceInt}>{p.int}</Text>
        <Text style={styles.priceDec}>{p.decWithDot}</Text>
        <Text style={styles.priceSuffix}>/人 分摊</Text>
      </View>
      {gb.question_tags.length > 0 ? (
        <Text style={styles.tags} numberOfLines={1}>
          {`问题标签：${gb.question_tags.join(' · ')}`}
        </Text>
      ) : null}
    </GlassCard>
  );
}

export function MyGroupBuysScreen() {
  const nav = useNavigation();
  const session = useSession();
  const meId = session.me?.id;
  const { state, reload } = useResource(async (): Promise<MyGroupBuysData> => {
    if (meId === undefined) {
      // 会话面守卫：AppShell 仅登录态渲染，理论不可达——显性呈现不静默造假数据
      throw new Error('登录态缺失（session.me 不可读），无法识别发起人');
    }
    const [all, mine] = await Promise.all([fetchGroupBuys(), fetchMyEnrollments()]);
    return {
      initiated: filterInitiatedBy(all, meId),
      joined: mine.filter((e) => e.ref_type === 'groupbuy'),
    };
  }, [meId]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="我的拼团"
    >
      <SectionHeader
        title="我发起的拼团"
        note="拼团中可见 · 成团/流标后归档（历史列表接口未开放）"
        actionLabel="刷新"
        onAction={reload}
      />
      {state.phase === 'loading' ? <LoadingHint /> : null}
      {state.phase === 'error' ? <ErrorPanel error={state.error} onRetry={reload} /> : null}
      {state.phase === 'ready' ? (
        state.data.initiated.length === 0 ? (
          <EmptyHint text="暂无进行中的拼团——发起一个拼团，让律师来接单" />
        ) : (
          <View style={styles.list}>
            {state.data.initiated.map((gb) => (
              <InitiatedCard key={gb.id} gb={gb} />
            ))}
          </View>
        )
      ) : null}
      <Button label="发起新拼团" variant="secondary" small onPress={() => nav.setTab('publish')} />

      <SectionHeader title="我参与的拼团报名" note="加入他人拼团的支付记录" />
      {state.phase === 'loading' ? <LoadingHint /> : null}
      {/* 错误相位整页单面板（T6 评审 S6，照 NotificationPrefsScreen 形态）：两段共享同一
          useResource state，ErrorPanel 仅在首段渲染一次，本段不重复 */}
      {state.phase === 'ready' ? (
        state.data.joined.length === 0 ? (
          <EmptyHint text="暂无参与的拼团报名" />
        ) : (
          <View style={styles.list}>
            {state.data.joined.map((e) => (
              <EnrollmentRow
                key={e.enrollment_id}
                item={e}
                contextLine={`拼团任务 #${e.ref_id}（拼团详情接口未开放，状态以报名行准）`}
              />
            ))}
          </View>
        )
      ) : null}
      {/* 评审 I2：不承诺「通知/报名记录」渠道（报名链无通知生产方、发起人无 enrollment 行）——
          只陈述展示窗口事实；历史列表缺口已在 SectionHeader note 如实告知 */}
      <MutedText>{'发起的拼团成团或流标后不再在此展示（历史列表接口待平台后续开放）'}</MutedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  list: { gap: spacing.md },
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
  headline: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  deadline: { color: colors.ink2, fontSize: fontSize.sm },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end' },
  priceSymbol: { color: colors.accent, fontSize: fontSize.md, marginBottom: 1 },
  priceInt: { color: colors.accent, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  priceDec: { color: colors.accent, fontSize: fontSize.base, marginBottom: 1 },
  priceSuffix: { color: colors.ink2, fontSize: fontSize.sm, marginBottom: 2, marginLeft: 2 },
  tags: { color: colors.ink2, fontSize: fontSize.sm },
});
