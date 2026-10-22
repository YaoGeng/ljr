/**
 * 实名认证页（M3-W1 T3，A2 极简）：GET /realname/status 展示态（未实名/核验中/已实名/
 * 未通过可重提）+ POST /realname 提交（姓名+身份证号，字段按 realname.http 实文）。
 *
 * dev 沙箱口径（w3-smoke 段 6 同路径）：MockRealnameProvider 校验位合法即 VERIFIED——
 * 无 admin 过审面（通道适配器同步判定），任务卡「admin 过审」以沙箱通道语义承载。
 * R-05：实名信息仅用于报名资格核验，不对外展示。402 报名拦截的引导落点（params.returnSessionId
 * 存在时提供「返回继续报名」）。
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { isAppApiError } from '../api/client';
import {
  fetchRealnameStatus,
  isValidIdNo,
  isValidRealnameName,
  submitRealname,
} from '../api/realname';
import { realnameStatusCopy } from '../api/trade-copy';
import { useResource } from '../api/useResource';
import { ErrorPanel, LoadingHint } from '../components/state-views';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTimeFull } from '../utils/date';

export function RealnameScreen({
  params,
}: {
  readonly params?: Readonly<Record<string, unknown>>;
}) {
  const nav = useNavigation();
  const rawReturn = params?.['returnSessionId'];
  const returnSessionId =
    typeof rawReturn === 'number' && Number.isInteger(rawReturn) && rawReturn > 0
      ? rawReturn
      : null;
  const { state, reload } = useResource(() => fetchRealnameStatus(), []);
  const [name, setName] = useState('');
  const [idNo, setIdNo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    setError(null);
    setErrorCode(null);
    if (!isValidRealnameName(name)) {
      setError('请输入正确的姓名（1-64 位非空白字符）');
      return;
    }
    if (!isValidIdNo(idNo)) {
      setError('身份证号须为 18 位（末位可为 X）');
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitRealname({ name, id_no: idNo });
      if (result.status === 'VERIFIED') {
        reload();
        setName('');
        setIdNo('');
      } else {
        reload(); // FAILED/PENDING → 状态区刷新展示（fail-visible）
      }
    } catch (e) {
      if (isAppApiError(e)) {
        setError(e.message);
        setErrorCode(e.code);
        return;
      }
      setError('操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  if (state.phase === 'loading') {
    return <LoadingHint label="实名状态加载中…" />;
  }
  if (state.phase === 'error') {
    return (
      <View style={styles.errorWrap}>
        <ErrorPanel error={state.error} onRetry={reload} />
        <Button label="返回" variant="ghost" small onPress={nav.pop} />
      </View>
    );
  }

  const status = state.data;
  const verified = status.status === 'VERIFIED';

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="实名认证页"
    >
      <GlassCard style={styles.card}>
        <View style={styles.statusRow}>
          <Text style={styles.cardTitle}>实名认证</Text>
          <Text style={[styles.statusText, verified && styles.statusTextOn]}>
            {realnameStatusCopy(status.status)}
          </Text>
        </View>
        {verified ? (
          <View style={styles.verifiedBlock}>
            <MutedText>
              已于 {status.verified_at ? formatDateTimeFull(status.verified_at) : '—'}{' '}
              完成实名核验。
            </MutedText>
            <MutedText>
              实名信息仅用于报名资格核验，不对外展示（PRD §7.1.1）；如需修改请联系客服。
            </MutedText>
          </View>
        ) : (
          <View style={styles.formBlock}>
            <MutedText>
              按监管与平台规则，报名支付前需完成实名认证（架构 §4.4 实名闸口）。信息经加密核验，
              默认仅留存核验结果与凭据摘要。
            </MutedText>
            <Field
              value={name}
              onChangeText={setName}
              placeholder="姓名（与证件一致）"
              maxLength={64}
              invalid={name.length > 0 && !isValidRealnameName(name)}
              editable={!submitting}
              accessibilityLabel="姓名输入框"
            />
            <Field
              value={idNo}
              onChangeText={(t) => setIdNo(t.replace(/[^\dXx]/g, '').slice(0, 18))}
              placeholder="身份证号（18 位，末位可为 X）"
              keyboardType="number-pad"
              maxLength={18}
              invalid={idNo.length > 0 && !isValidIdNo(idNo)}
              editable={!submitting}
              accessibilityLabel="身份证号输入框"
            />
            <ErrorText>{error}</ErrorText>
            {errorCode ? <MutedText>code={errorCode}</MutedText> : null}
            {status.status === 'FAILED' ? (
              <MutedText>上次核验未通过：请核对姓名与证件号后重新提交。</MutedText>
            ) : null}
            <Button
              label={submitting ? '提交核验中…' : '提交核验'}
              busy={submitting}
              onPress={() => void handleSubmit()}
            />
          </View>
        )}
      </GlassCard>

      {returnSessionId !== null ? (
        <Button label="返回继续报名" variant="ghost" onPress={nav.pop} />
      ) : (
        <Button label="返回" variant="ghost" onPress={nav.pop} />
      )}
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
  verifiedBlock: { gap: spacing.xs },
  formBlock: { gap: spacing.md },
  errorWrap: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
});
