/**
 * A2 训练授权独立页（M3-W1 T3）：从报名流独立跳转（非捆绑勾选——链 6 口径 C3 支付→
 * A2 授权页）。GET /consents/training 状态展示 + 授权勾选提交（POST {policy_version,accept:true}）
 * / 撤回（POST revoke，危险态红点缀+两段确认——R-03 撤回链路起点）。
 *
 * 文案目的限定按 A2/架构 §5.2 实文口径：语料仅用于「专项 AI 训练」；拒绝不影响拼单/房间功能
 * （R-02——本页无授权也可直接离开）；撤回后未训练样本按 source_msg_id 删除。不发明未定义语义。
 * policy_version：GET 现行视图回读，无历史行用 core 默认 v1.0.0；409 VERSION_MISMATCH → 刷新重试。
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError } from '../api/client';
import {
  DEFAULT_TRAINING_POLICY_VERSION,
  fetchTrainingConsent,
  grantTrainingConsent,
  revokeTrainingConsent,
} from '../api/consents';
import { trainingConsentStatusCopy } from '../api/trade-copy';
import { useResource } from '../api/useResource';
import { ErrorPanel, LoadingHint } from '../components/state-views';
import { Button, ErrorText, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTimeFull } from '../utils/date';

export function TrainingConsentScreen() {
  const nav = useNavigation();
  const { state, reload } = useResource(() => fetchTrainingConsent(), []);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<'grant' | 'revoke' | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function handleGrant(): Promise<void> {
    setError(null);
    setErrorCode(null);
    if (!checked) return;
    setBusy('grant');
    try {
      const policyVersion =
        state.phase === 'ready' && state.data.policy_version
          ? state.data.policy_version
          : DEFAULT_TRAINING_POLICY_VERSION;
      await grantTrainingConsent(policyVersion);
      setChecked(false);
      reload();
    } catch (e) {
      if (isAppApiError(e)) {
        setError(e.message);
        setErrorCode(e.code);
        return;
      }
      setError('操作失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke(): Promise<void> {
    setError(null);
    setErrorCode(null);
    if (!confirmRevoke) {
      setConfirmRevoke(true); // 两段确认：撤回是不可逆的合规动作
      return;
    }
    setBusy('revoke');
    try {
      await revokeTrainingConsent();
      setConfirmRevoke(false);
      reload();
    } catch (e) {
      if (isAppApiError(e)) {
        setError(e.message);
        setErrorCode(e.code);
        return;
      }
      setError('操作失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  if (state.phase === 'loading') {
    return <LoadingHint label="授权状态加载中…" />;
  }
  if (state.phase === 'error') {
    return (
      <View style={styles.errorWrap}>
        <ErrorPanel error={state.error} onRetry={reload} />
        <Button label="返回" variant="ghost" small onPress={nav.pop} />
      </View>
    );
  }

  const view = state.data;
  const granted = view.status === 'GRANTED';

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="训练数据授权页"
    >
      <GlassCard style={styles.card}>
        <View style={styles.statusRow}>
          <Text style={styles.cardTitle}>AI 训练数据授权</Text>
          <Text style={[styles.statusText, granted && styles.statusTextOn]}>
            {trainingConsentStatusCopy(view.status)}
          </Text>
        </View>

        <MutedText>
          授权后，你在咨询房间内发送的消息将作为「专项 AI 训练」语料，用于提升对应专项的 AI
          辅助能力（目的限定：仅用于专项 AI 训练）。拒绝授权不影响拼单、房间等任何功能，
          仅相关消息不会进入训练语料（架构 §5.2 合规 R3）。
        </MutedText>
        <MutedText>
          授权可随时撤回：撤回后，尚未用于训练的语料将按消息来源标识删除；已训练模型的处置
          规则以平台政策为准。
        </MutedText>

        {granted ? (
          <View style={styles.grantedBlock}>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>授权版本</Text>
              <Text style={styles.metaValue}>{view.policy_version ?? '—'}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>授权时间</Text>
              <Text style={styles.metaValue}>
                {view.granted_at ? formatDateTimeFull(view.granted_at) : '—'}
              </Text>
            </View>
            <Button
              label={confirmRevoke ? '再次点击确认撤回' : '撤回授权'}
              busy={busy === 'revoke'}
              onPress={() => void handleRevoke()}
            />
            {confirmRevoke ? (
              <>
                <Text style={styles.revokeHint}>
                  撤回立即生效且不可恢复原授权记录语义；如后续需要再次授权，可重新提交。
                </Text>
                {/* 评审 S8：两段确认可反悔——取消解除位 */}
                <Button
                  label="取消撤回"
                  variant="ghost"
                  small
                  disabled={busy === 'revoke'}
                  onPress={() => setConfirmRevoke(false)}
                />
              </>
            ) : null}
          </View>
        ) : (
          <View style={styles.grantBlock}>
            {view.status === 'REVOKED' ? (
              <MutedText>
                你曾于 {view.revoked_at ? formatDateTimeFull(view.revoked_at) : '—'} 撤回授权；
                可重新授权或保持未授权状态。
              </MutedText>
            ) : null}
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              onPress={() => setChecked((v) => !v)}
              style={styles.checkRow}
            >
              <View style={[styles.checkbox, checked && styles.checkboxOn]}>
                {checked ? <View style={styles.checkboxDot} /> : null}
              </View>
              <Text style={styles.checkText}>
                我已阅读并理解上述目的限定，同意将其用于专项 AI 训练
              </Text>
            </Pressable>
            <Button
              label="提交授权"
              busy={busy === 'grant'}
              disabled={!checked}
              onPress={() => void handleGrant()}
            />
            <Button label="暂不授权，返回" variant="ghost" small onPress={nav.pop} />
          </View>
        )}

        <ErrorText>{error}</ErrorText>
        {errorCode === ErrorCode.VersionMismatch ? (
          /* 评审 I3：版本失配给真实刷新控件（重试仍读旧版本会死循环）——reload 拉现行视图后重提交 */
          <View style={styles.mismatchBlock}>
            <MutedText>授权协议版本已更新：刷新后按新版本重新提交。</MutedText>
            <Button label="刷新协议版本" variant="secondary" small onPress={reload} />
          </View>
        ) : null}
        {errorCode ? <MutedText>code={errorCode}</MutedText> : null}
      </GlassCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.md },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  statusText: { color: colors.ink2, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  statusTextOn: { color: colors.primary, fontWeight: fontWeight.semibold },
  grantedBlock: { gap: spacing.md },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metaLabel: { color: colors.ink2, fontSize: fontSize.base },
  metaValue: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  revokeHint: { color: colors.accentDk, fontSize: fontSize.sm, lineHeight: 18 },
  mismatchBlock: { gap: spacing.xs },
  grantBlock: { gap: spacing.md },
  checkRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.primary2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxOn: { borderColor: colors.primary },
  checkboxDot: { width: 10, height: 10, borderRadius: 3, backgroundColor: colors.primary },
  checkText: { flex: 1, color: colors.ink2, fontSize: fontSize.md, lineHeight: 20 },
  errorWrap: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
});
