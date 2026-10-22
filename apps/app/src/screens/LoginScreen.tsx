/**
 * 登录视图（M3-W1 T1，极简可用）：手机号 → POST /auth/sms → 验证码 → POST /auth/verify
 * → 存 token → GET /me（展示 phone_masked——/me 契约无昵称字段，triage 见设计决策文档）。
 *
 * 状态机：idle → sending → sent(冷却倒计时) → verifying → authenticated(退出本页)；
 * 任一步失败 → 错误文案（映射表解析，error-messages.ts），回可重试态。
 * 客户端校验：大陆 11 位手机号（A1 R-W2-12 客户端镜像）+ 6 位数字码（服务端同口径）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ErrorCode } from '@ljr/shared';
import { APP_NAME } from '../app-info';
import { isAppApiError } from '../api/client';
import { requestSmsCode, verifyAndLogin } from '../api/session';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, shadow, spacing } from '../design/tokens';

/** A1 R-W2-12 大陆手机号（core identity.crypto 同口径的客户端镜像） */
const MAINLAND_PHONE = /^1[3-9]\d{9}$/;
const CODE_6 = /^\d{6}$/;

/** dev 提示开关（EXPO_PUBLIC_DEV_LOGIN_HINT=1 时显示；默认隐藏）。
 *  env 必须直取（T6 评审 S9）：Expo 构建期内联只匹配 process.env.X 直取形态——可选链
 *  process.env?.X 会被常量折叠成 undefined 使 export 产物中开关恒关（T3 I2 已实证，
 *  同口径注记见 dev-pay-sim.ts 头注）。 */
function devHintEnabled(): boolean {
  return process.env.EXPO_PUBLIC_DEV_LOGIN_HINT === '1';
}

export function LoginScreen() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [ageChecked, setAgeChecked] = useState(false);
  const [smsSent, setSmsSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const phoneValid = useMemo(() => MAINLAND_PHONE.test(phone), [phone]);
  const codeValid = useMemo(() => CODE_6.test(code), [code]);

  function showError(e: unknown): void {
    if (isAppApiError(e)) {
      setError(e.message);
      setErrorCode(e.code);
      return;
    }
    setError('操作失败，请稍后重试');
    setErrorCode(null);
  }

  async function handleSendCode(): Promise<void> {
    setError(null);
    setErrorCode(null);
    if (!phoneValid) {
      setError('请输入大陆 11 位手机号（1[3-9] 开头）');
      return;
    }
    setSending(true);
    try {
      const { ttl } = await requestSmsCode(phone);
      setSmsSent(true);
      setCooldown(ttl > 0 ? ttl : 60);
    } catch (e) {
      showError(e);
    } finally {
      setSending(false);
    }
  }

  async function handleVerify(): Promise<void> {
    setError(null);
    setErrorCode(null);
    if (!phoneValid) {
      setError('请输入大陆 11 位手机号（1[3-9] 开头）');
      return;
    }
    if (!codeValid) {
      setError('请输入 6 位数字验证码');
      return;
    }
    setVerifying(true);
    try {
      // 成功后 session 状态翻转，RootGate 切换到五 tab 壳（本组件卸载）
      await verifyAndLogin({ phone, code, ageDeclared: ageChecked });
    } catch (e) {
      showError(e);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.brandBlock}>
          <View style={styles.seal}>
            <Text style={styles.sealText}>律</Text>
          </View>
          <Text style={styles.brandName}>{APP_NAME}</Text>
          <Text style={styles.brandSlogan}>组团解决法律问题 · 劳动仲裁</Text>
        </View>

        <GlassCard style={styles.formCard}>
          <Text style={styles.formTitle}>手机验证码登录</Text>

          <Field
            value={phone}
            onChangeText={(t) => setPhone(t.replace(/[^\d]/g, '').slice(0, 11))}
            keyboardType="phone-pad"
            maxLength={11}
            placeholder="大陆 11 位手机号"
            invalid={phone.length > 0 && !phoneValid}
            editable={!verifying}
            accessibilityLabel="手机号输入框"
          />
          <View style={styles.codeRow}>
            <Field
              value={code}
              onChangeText={(t) => setCode(t.replace(/[^\d]/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="6 位验证码"
              invalid={code.length > 0 && !codeValid}
              editable={!verifying}
              accessibilityLabel="验证码输入框"
              style={styles.codeField}
            />
            <Button
              label={cooldown > 0 ? `重发 ${cooldown}s` : smsSent ? '重发验证码' : '发送验证码'}
              variant="secondary"
              small
              busy={sending}
              disabled={cooldown > 0 || !phoneValid}
              onPress={handleSendCode}
            />
          </View>

          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ageChecked }}
            onPress={() => setAgeChecked((v) => !v)}
            style={styles.ageRow}
          >
            <View style={[styles.checkbox, ageChecked && styles.checkboxOn]}>
              {ageChecked ? <View style={styles.checkboxDot} /> : null}
            </View>
            <Text style={styles.ageText}>我已年满 14 周岁，或不满 14 周岁已获监护人同意</Text>
          </Pressable>

          <ErrorText>{error}</ErrorText>
          {errorCode === ErrorCode.AgeDeclarationRequired ? (
            <MutedText>新手机号首次登录即注册，须先完成年龄声明（勾选上方）。</MutedText>
          ) : null}
          {devHintEnabled() ? (
            <MutedText>
              dev 提示：验证码由 core mock SMS 通道下发（无回显面）。本地联调须经测试夹具向
              identity.verify_codes 种入已知码（见 docs/plans/M3-W1-设计决策.md triage）。
            </MutedText>
          ) : null}

          <Button
            label="登录 / 注册"
            busy={verifying}
            disabled={!phoneValid || !codeValid}
            onPress={handleVerify}
          />
        </GlassCard>

        <Text style={styles.footnote}>登录即代表同意用户协议与隐私政策（正式文案随 H9 施工）</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  brandBlock: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xxl },
  seal: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.primary2,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.primaryButton,
  },
  sealText: { color: colors.onPrimary, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  brandName: { color: colors.ink, fontSize: fontSize.xxxl, fontWeight: fontWeight.bold },
  brandSlogan: { color: colors.ink2, fontSize: fontSize.md },
  formCard: { padding: spacing.xl, gap: spacing.lg },
  formTitle: {
    color: colors.ink,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    marginBottom: spacing.xs,
  },
  codeRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  codeField: { flex: 1 },
  ageRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
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
  ageText: { flex: 1, color: colors.ink2, fontSize: fontSize.md, lineHeight: 20 },
  footnote: {
    color: colors.ink2,
    fontSize: fontSize.sm,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
});
