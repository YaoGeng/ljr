/**
 * 数据态通用视图（M3-W1 T2）：加载/错误/空三态的统一形态（fail-visible——
 * 错误文案来自 error-messages 映射链，附重试口；不吞错不造假数据）。
 */
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { resourceErrorMessage } from '../api/useResource';
import { Button, GlassCard, MutedText } from './ui';
import { colors, fontSize, fontWeight, spacing } from '../design/tokens';

export function LoadingHint({ label = '加载中…' }: { readonly label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary2} />
      <Text style={styles.hintText}>{label}</Text>
    </View>
  );
}

/** 错误面板：映射文案 + 原始码（小字·调试诉求）+ 重试 */
export function ErrorPanel({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  return (
    <GlassCard style={styles.panel}>
      <Text style={styles.panelTitle}>加载失败</Text>
      <Text style={styles.panelCopy}>{resourceErrorMessage(error)}</Text>
      {code ? <Text style={styles.panelCode}>code={code}</Text> : null}
      <Button label="重试" variant="secondary" small onPress={onRetry} />
    </GlassCard>
  );
}

export function EmptyHint({ text }: { readonly text: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.hintText}>{text}</Text>
    </View>
  );
}

export function SectionHeader({
  title,
  note,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly note?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleBlock}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {note ? <MutedText>{note}</MutedText> : null}
      </View>
      {actionLabel && onAction ? (
        <Button label={actionLabel} variant="ghost" small onPress={onAction} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  hintText: { color: colors.ink2, fontSize: fontSize.md, textAlign: 'center' },
  panel: { padding: spacing.xl, gap: spacing.md, alignItems: 'flex-start' },
  panelTitle: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  panelCopy: { color: colors.accentDk, fontSize: fontSize.md, lineHeight: 20 },
  panelCode: { color: colors.ink2, fontSize: fontSize.xs },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionTitleBlock: { flexShrink: 1, gap: 2 },
  sectionTitle: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
});
