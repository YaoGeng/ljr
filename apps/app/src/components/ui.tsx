/**
 * 设计体系 UI 基元（M3-W1 T1）：玻璃卡 / 主按钮（豆沙红点缀铁律位）/ 次按钮 / 幽灵按钮 /
 * 表单输入。全部样式走 src/design/tokens.ts 单源，禁散写色值。
 *
 * 降级登记：RN 无 backdrop-filter 且不引 expo-blur → 玻璃卡以半透明白 + 1px 半透明白边
 * + 16px 圆角近似（原型 --glass/--glass-hi/--radius:16px 的平替，见设计决策文档）。
 */
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, fontSize, fontWeight, radius, shadow, spacing } from '../design/tokens';

/** 玻璃卡（v4.0 玻璃拟态近似） */
export function GlassCard(props: ComponentPropsWithoutRef<typeof View>) {
  const { style, ...rest } = props;
  return <View style={[styles.glassCard, style]} {...rest} />;
}

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  /** 进行中（禁重复提交） */
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly variant?: 'primary' | 'secondary' | 'ghost';
  readonly small?: boolean;
}

/**
 * 主按钮=豆沙红点缀（一组仅一个主操作位）；次按钮=橄榄绿；幽灵=淡绿底。
 * 红仅按钮级小面积，遵守铁律。
 */
export function Button({
  label,
  onPress,
  busy,
  disabled,
  variant = 'primary',
  small,
}: ButtonProps) {
  const base = small ? styles.btnSmall : styles.btn;
  const variantStyle =
    variant === 'primary'
      ? styles.btnPrimary
      : variant === 'secondary'
        ? styles.btnSecondary
        : styles.btnGhost;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        base,
        variantStyle,
        (disabled || busy) && styles.btnDisabled,
        pressed && !disabled && !busy && styles.btnPressed,
      ]}
    >
      <Text
        style={[
          styles.btnLabel,
          small && styles.btnLabelSmall,
          variant === 'primary' ? styles.btnLabelOnAccent : styles.btnLabelOnGreen,
          (disabled || busy) && styles.btnLabelDisabled,
        ]}
      >
        {busy ? `${label}…` : label}
      </Text>
    </Pressable>
  );
}

/** 文本输入（玻璃面 + 聚焦描边；invalid 时豆沙红细描边——危险态点缀位） */
export const Field = forwardRef<TextInput, TextInputProps & { invalid?: boolean }>(function Field(
  { invalid, style, ...rest },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.ink2}
      accessibilityRole="text"
      style={[styles.field, invalid && styles.fieldInvalid, style]}
      {...rest}
    />
  );
});

/** 表单错误行（危险态文案：豆沙红深阶） */
export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Text style={styles.errorText}>{children}</Text>;
}

/** 通用正文/标题速写（避免各视图散写字号颜色） */
export function ScreenTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.screenTitle}>{children}</Text>;
}

export function MutedText({ children }: { children: ReactNode }) {
  return <Text style={styles.mutedText}>{children}</Text>;
}

const styles = StyleSheet.create({
  glassCard: {
    backgroundColor: colors.glass,
    borderColor: colors.glassHi,
    borderWidth: 1,
    borderRadius: radius.card,
    ...shadow.card,
  },
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    paddingVertical: 9,
    paddingHorizontal: 18,
    minHeight: 44,
  },
  btnSmall: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    paddingVertical: 5,
    paddingHorizontal: 13,
    minHeight: 32,
  },
  btnPrimary: {
    backgroundColor: colors.accent,
    ...shadow.primaryButton,
  },
  btnSecondary: {
    backgroundColor: colors.primary,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.26,
    shadowRadius: 16,
    elevation: 2,
  },
  btnGhost: {
    backgroundColor: colors.ghostFill, // 幽灵按钮浅底（T6 评审 S3 收编 token，禁散值）
  },
  btnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.97 }],
  },
  btnDisabled: {
    opacity: 0.42,
  },
  btnLabel: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
  },
  btnLabelSmall: {
    fontSize: fontSize.sm,
  },
  btnLabelOnAccent: {
    color: colors.onPrimary,
  },
  btnLabelOnGreen: {
    color: colors.onPrimary,
  },
  btnLabelDisabled: {
    color: colors.onPrimary,
  },
  field: {
    backgroundColor: 'rgba(255,255,255,0.66)',
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    minHeight: 46,
    fontSize: fontSize.base,
    color: colors.ink,
  },
  fieldInvalid: {
    borderColor: colors.dangerLine,
  },
  errorText: {
    color: colors.accentDk,
    fontSize: fontSize.md,
    lineHeight: 20,
  },
  screenTitle: {
    color: colors.ink,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.semibold,
  },
  mutedText: {
    color: colors.ink2,
    fontSize: fontSize.md,
    lineHeight: 20,
  },
});
