/**
 * 我的报名（M3-W1 T4，推栈页）：GET /enrollments/mine。
 *
 * 场次上下文补充：mine 行仅 ref_type/ref_id——session 行逐条补拉 GET /sessions/{id}
 * （Promise.allSettled，单行失败降级「详情暂不可得」不拖垮整列表）；groupbuy 行无公开详情
 * 端点（GET /group-buys 仅 PUBLISHED 列表，无 /group-buys/{id}）→ 如实仅显示拼团编号。
 * 下拉刷新=「刷新」按钮触发 reload（同 MessagesScreen 口径）。
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { fetchMyEnrollments, type EnrollmentMineItem } from '../api/enrollments';
import { fetchSessionDetail, type SessionDetailView } from '../api/sessions';
import { useResource } from '../api/useResource';
import { EnrollmentRow } from '../components/enrollment-row';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { MutedText } from '../components/ui';
import { spacing } from '../design/tokens';
import { formatDateTime } from '../utils/date';

/** session 行的上下文补拉结果（ref_id → 详情或失败位） */
type SessionContext = Readonly<Record<number, SessionDetailView | null>>;

function contextLine(item: EnrollmentMineItem, sessions: SessionContext): string {
  if (item.ref_type === 'session') {
    const detail = sessions[item.ref_id];
    if (!detail) return `场次 #${item.ref_id} · 详情暂不可得`;
    return `${formatDateTime(detail.slot_start)} 开场 · ${detail.city} · 已报 ${detail.joined}/${detail.capacity}`;
  }
  return `拼团任务 #${item.ref_id}（拼团详情接口未开放，状态以报名行准）`;
}

export function MyEnrollmentsScreen() {
  const { state, reload } = useResource(() => fetchMyEnrollments(), []);
  const [sessions, setSessions] = useState<SessionContext>({});

  // 场次上下文补拉（评审 S4）：ref_id 去重；本轮已成功的缓存键跳过（null=上轮失败，随下一
  // 数据代次重试——deps 只锚 state[装载/手动刷新]，失败键不因 sessions 身份变化进入重试风暴）；
  // 迟到应答丢弃（数据代次守卫）
  useEffect(() => {
    if (state.phase !== 'ready') return;
    const wanted = [
      ...new Set(state.data.filter((e) => e.ref_type === 'session').map((e) => e.ref_id)),
    ].filter((id) => sessions[id] == null);
    if (wanted.length === 0) return;
    let alive = true;
    void Promise.allSettled(wanted.map((id) => fetchSessionDetail(id))).then((results) => {
      if (!alive) return;
      const next: Record<number, SessionDetailView | null> = {};
      results.forEach((r, i) => {
        next[wanted[i]!] = r.status === 'fulfilled' ? r.value : null;
      });
      setSessions((prev) => ({ ...prev, ...next }));
    });
    return () => {
      alive = false;
    };
  }, [state]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="我的报名"
    >
      <SectionHeader
        title="我的报名"
        note="支付状态 · 金额明细 · 退款进度"
        actionLabel="刷新"
        onAction={reload}
      />
      {state.phase === 'loading' ? <LoadingHint /> : null}
      {state.phase === 'error' ? <ErrorPanel error={state.error} onRetry={reload} /> : null}
      {state.phase === 'ready' ? (
        state.data.length === 0 ? (
          <EmptyHint text="暂无报名记录——去场次列表找一场合适的咨询吧" />
        ) : (
          <View style={styles.list}>
            {state.data.map((e) => (
              <EnrollmentRow
                key={e.enrollment_id}
                item={e}
                contextLine={contextLine(e, sessions)}
              />
            ))}
          </View>
        )
      ) : null}
      <MutedText>{'到报名截止仍未成团的场次，费用将原路全额自动退款'}</MutedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  list: { gap: spacing.md },
});
