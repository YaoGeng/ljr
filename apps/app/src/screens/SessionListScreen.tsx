/**
 * 场次列表（M3-W1 T2，T1 占位替换）：GET /sessions 全量 + 状态筛选 chips
 * （档位=session-copy 生命周期分组单源；过滤在客户端——GET /sessions 无状态查询键，
 * 且 core 公开列表仅返回报名中场次，非报名中档位对真实 API 呈空态，缺口见 triage）。
 */
import { useState } from 'react';
import { ScrollView, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  SESSION_STATUS_FILTERS,
  filterSessionsByStatus,
  sessionStatusCopy,
} from '../api/session-copy';
import { fetchSessions } from '../api/sessions';
import { useResource } from '../api/useResource';
import { SessionCard } from '../components/session-card';
import { EmptyHint, ErrorPanel, LoadingHint } from '../components/state-views';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';

export function SessionListScreen() {
  const nav = useNavigation();
  const [activeFilterKey, setActiveFilterKey] = useState<string>(SESSION_STATUS_FILTERS[0]!.key);
  const { state, reload } = useResource(() => fetchSessions(), []);

  const rows = state.phase === 'ready' ? filterSessionsByStatus(state.data, activeFilterKey) : [];
  const activeFilter =
    SESSION_STATUS_FILTERS.find((f) => f.key === activeFilterKey) ?? SESSION_STATUS_FILTERS[0]!;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="场次列表"
    >
      <View style={styles.chipRow}>
        {SESSION_STATUS_FILTERS.map((f) => {
          const on = f.key === activeFilterKey;
          return (
            <Pressable
              key={f.key}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: !f.available }}
              disabled={!f.available}
              onPress={() => setActiveFilterKey(f.key)}
              style={[styles.chip, on && styles.chipOn, !f.available && styles.chipOff]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{f.label}</Text>
              {!f.available ? (
                /* S7：公开列表暂无该状态数据面（core W3-12）——禁用+角标，不给可点击的恒空档 */
                <Text style={styles.chipTag}>暂未开放</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {state.phase === 'loading' ? <LoadingHint /> : null}
      {state.phase === 'error' ? <ErrorPanel error={state.error} onRetry={reload} /> : null}
      {state.phase === 'ready' ? (
        rows.length === 0 ? (
          <EmptyHint
            text={
              activeFilter.key === 'all'
                ? '暂无报名中的开团场次（供给开通中）——可先发起拼团'
                : `暂无「${activeFilter.label}」场次`
            }
          />
        ) : (
          <View style={styles.cardList}>
            {rows.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                onPress={(target) => nav.push({ key: 'sessionDetail', params: { id: target.id } })}
              />
            ))}
          </View>
        )
      ) : null}

      <Text style={styles.footnote}>
        仅展示审核通过律师的场次 · {sessionStatusCopy('CREATED').label}场次可报名
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: 'rgba(255,255,255,0.55)', // 玻璃面变体（原型 chip 底，降级口径档）
    paddingHorizontal: spacing.lg,
    paddingVertical: 5,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipOff: { opacity: 0.55 },
  chipText: { color: colors.ink2, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  chipTextOn: { color: colors.onPrimary },
  chipTag: { color: colors.ink2, fontSize: fontSize.xs, marginLeft: 4 },
  cardList: { gap: spacing.md },
  footnote: {
    color: colors.ink2,
    fontSize: fontSize.xs,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
});
