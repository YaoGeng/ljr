/**
 * 通知偏好（M3-W1 T4，推栈页）：GET/PUT /notification-prefs（I1 §5）。
 *
 * ⚠契约现状（任务报告 triage）：GET 仅返回已有偏好行（无记录=默认投递），且无模板目录枚举
 * 端点 → 本页条目面=已有偏好行 ∪ 收件箱出现过的 templateCode（两处均为真实 API 数据，
 * 不硬编码模板清单）；全新用户两处皆空 → 空态如实。
 * PUT 体 {prefs: [{template_code, enabled}]}（parsePrefsBody 实文）；保存成功/失败均有反馈
 * （成功=PUT 回读直接更新条目面+「已保存」提示保留至下一次交互——PUT 出参与 GET 同形态，
 * 免全量 reload[评审 I1：reload→loading→reset effect 会吞掉成功反馈]；失败=映射文案+code）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  fetchNotificationPrefs,
  mergePrefRows,
  putNotificationPrefs,
  type PrefPutItem,
  type PrefRow,
} from '../api/notification-prefs';
import { fetchMyNotifications } from '../api/notifications';
import { isAppApiError } from '../api/client';
import { notifyTemplateCopy } from '../api/notify-copy';
import { useResource } from '../api/useResource';
import { EmptyHint, ErrorPanel, LoadingHint } from '../components/state-views';
import { Button, ErrorText, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';

interface PrefsSource {
  readonly prefs: ReadonlyArray<{ readonly templateCode: string; readonly enabled: boolean }>;
  readonly inboxCodes: readonly string[];
}

export function NotificationPrefsScreen() {
  const { state, reload } = useResource(async (): Promise<PrefsSource> => {
    const [prefs, inbox] = await Promise.all([
      fetchNotificationPrefs(),
      fetchMyNotifications().catch(() => []), // 收件箱拉取失败不阻塞偏好面（条目面降级=仅偏好行）
    ]);
    return { prefs, inboxCodes: [...new Set(inbox.map((n) => n.templateCode))] };
  }, []);

  const [toggles, setToggles] = useState<Readonly<Record<string, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  /**
   * 保存成功后的权威偏好集（PUT 回读，与 GET 同形态）——非 null 时取代装载面数据驱动条目；
   * 仅在装载/重试（state 变更）时清空回退服务端事实源（评审 I1：不走 reload，防 reset effect
   * 吞掉成功反馈——「已保存」保留至下一次交互）。
   */
  const [prefsOverride, setPrefsOverride] = useState<PrefsSource['prefs'] | null>(null);

  // 数据代次切换时重置本地开关与反馈位（保存成功路径不触发：不调 reload）
  useEffect(() => {
    setToggles({});
    setSaved(false);
    setError(null);
    setErrorCode(null);
    setPrefsOverride(null);
  }, [state]);

  const rows = useMemo(
    () =>
      state.phase === 'ready'
        ? mergePrefRows(prefsOverride ?? state.data.prefs, state.data.inboxCodes)
        : [],
    [state, prefsOverride],
  );

  /** 行开关现值：本地覆盖 > 数据源值 */
  function currentEnabled(row: PrefRow): boolean {
    const overridden = toggles[row.code];
    return overridden ?? row.enabled;
  }

  async function handleSave(): Promise<void> {
    if (state.phase !== 'ready') return;
    setBusy(true);
    setSaved(false);
    setError(null);
    setErrorCode(null);
    try {
      const items: PrefPutItem[] = rows.map((row) => ({
        template_code: row.code,
        enabled: currentEnabled(row),
      }));
      const readback = await putNotificationPrefs(items);
      setPrefsOverride(readback); // PUT 回读=服务端最新事实，直接更新条目面
      setToggles({}); // 已持久化：本地覆盖清零（行值改由回读驱动）
      setSaved(true); // 保留至下一次交互（开关/再保存/重试）
    } catch (e) {
      if (isAppApiError(e)) {
        setError(e.message);
        setErrorCode(e.code);
      } else {
        setError('保存失败，请稍后重试');
      }
    } finally {
      setBusy(false);
    }
  }

  if (state.phase === 'loading') {
    return <LoadingHint label="通知偏好加载中…" />;
  }
  if (state.phase === 'error') {
    return (
      <View style={styles.errorWrap}>
        <ErrorPanel error={state.error} onRetry={reload} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="通知偏好"
    >
      <GlassCard style={styles.card}>
        <Text style={styles.title}>通知偏好</Text>
        <MutedText>
          关闭后不再收到该类站内信通知（关键类不可关闭）；未列出的类别默认投递。
        </MutedText>
        {rows.length === 0 ? (
          <EmptyHint text="暂无可配置的通知类别——收到通知后对应类别会出现在这里" />
        ) : (
          <View style={styles.rows}>
            {rows.map((row) => {
              const enabled = currentEnabled(row);
              return (
                <Pressable
                  key={row.code}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: enabled }}
                  accessibilityLabel={`通知类别 ${notifyTemplateCopy(row.code).label}`}
                  onPress={() => {
                    setSaved(false); // 反馈位止于本次交互（评审 I1 口径）
                    setToggles((prev) => ({ ...prev, [row.code]: !currentEnabled(row) }));
                  }}
                  style={styles.row}
                >
                  <View style={styles.rowTextBlock}>
                    <Text style={styles.rowLabel}>{notifyTemplateCopy(row.code).label}</Text>
                    <Text style={styles.rowCode}>{row.code}</Text>
                  </View>
                  <View style={[styles.switchTrack, enabled && styles.switchTrackOn]}>
                    <View
                      style={[
                        styles.switchThumb,
                        enabled ? styles.switchThumbOn : styles.switchThumbOff,
                      ]}
                    />
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
        <Button
          label="保存偏好"
          busy={busy}
          disabled={rows.length === 0}
          onPress={() => void handleSave()}
        />
        {saved ? <Text style={styles.savedText}>已保存</Text> : null}
        <ErrorText>{error}</ErrorText>
        {errorCode ? <MutedText>code={errorCode}</MutedText> : null}
      </GlassCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg },
  card: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  rows: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowTextBlock: { flexShrink: 1, gap: 2 },
  rowLabel: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  rowCode: { color: colors.ink2, fontSize: fontSize.xs },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A18,
    padding: 3,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: colors.primary2 },
  switchThumb: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: colors.onPrimary,
  },
  switchThumbOn: { alignSelf: 'flex-end' },
  switchThumbOff: { alignSelf: 'flex-start' },
  savedText: { color: colors.primary, fontSize: fontSize.sm },
  errorWrap: { flex: 1, padding: spacing.lg, justifyContent: 'center' },
});
