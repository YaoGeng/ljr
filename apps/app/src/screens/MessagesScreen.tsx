/**
 * 消息中心（M3-W1 T4，messages tab）：GET /notifications/mine 站内信收件箱。
 *
 * ⚠契约现状如实呈现（任务报告 triage，禁发明契约外交互）：
 *   - 无已读位/已读端点（I1 §3 无 read 列）→ 纯展示，无「标记已读」交互；
 *   - 行无渲染文案字段 → 正文经 notify-copy 消费侧模板目录渲染；
 *   - 报名/成团事件当前无通知生产方（I1 消费面=场次提醒/三档改价/改期超时）→ 空态口径如实。
 * 下拉刷新：无现成下拉组件（W1-3 零依赖）→ 以「刷新」按钮触发 reload（现有 useResource 模式）。
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchMyNotifications, type InboxItem } from '../api/notifications';
import { notifyTemplateCopy, renderNotifyContent } from '../api/notify-copy';
import { useResource } from '../api/useResource';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { TONE_BG, TONE_TEXT } from '../design/tone-tokens'; // tone→色单源（T6 评审 S5；notify tone 四档为其子集）
import { useNavigation } from '../navigation/router';
import { formatMonthDayTime } from '../utils/date';

function NotifyCard({ item }: { readonly item: InboxItem }) {
  const copy = notifyTemplateCopy(item.templateCode);
  return (
    <GlassCard style={styles.card}>
      <View style={styles.tagRow}>
        <View
          style={[styles.badge, { backgroundColor: TONE_BG[copy.tone] }]}
          accessibilityLabel={`通知类型 ${copy.label}`}
        >
          <Text style={[styles.badgeText, { color: TONE_TEXT[copy.tone] }]}>{copy.label}</Text>
        </View>
        <Text style={styles.time}>{formatMonthDayTime(item.sentAt ?? item.createdAt)}</Text>
      </View>
      <Text style={styles.noticeText}>{renderNotifyContent(item.templateCode, item.params)}</Text>
    </GlassCard>
  );
}

export function MessagesScreen() {
  const nav = useNavigation();
  const { state, reload } = useResource(() => fetchMyNotifications(), []);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="消息中心"
    >
      <SectionHeader
        title="消息中心"
        note="站内信 · 按时间倒序"
        actionLabel="刷新"
        onAction={reload}
      />
      {state.phase === 'loading' ? <LoadingHint /> : null}
      {state.phase === 'error' ? <ErrorPanel error={state.error} onRetry={reload} /> : null}
      {state.phase === 'ready' ? (
        state.data.length === 0 ? (
          <EmptyHint text="暂无站内信——场次提醒、价格调整等重要动态会出现在这里" />
        ) : (
          <View style={styles.list}>
            {state.data.map((n) => (
              <NotifyCard key={n.id} item={n} />
            ))}
          </View>
        )
      ) : null}
      <MutedText>{'通知偏好可在「我的」中设置（可关闭非关键类通知）'}</MutedText>
      <Text
        style={styles.prefEntry}
        accessibilityRole="link"
        onPress={() => nav.push({ key: 'notificationPrefs' })}
      >
        前往通知偏好 ›
      </Text>
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
  badge: { borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 3 },
  badgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  time: { color: colors.ink2, fontSize: fontSize.xs },
  noticeText: { color: colors.ink, fontSize: fontSize.base, lineHeight: 21 },
  prefEntry: {
    color: colors.primary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.sm,
  },
});
