/**
 * 我的（M3-W1 T4 建/W2 T1 扩，me/lawyerMe tab）：资料卡（/me：phone_masked+角色徽标+当前
 * 端别）+ 入口组（我的报名/我的拼团/训练授权状态/通知偏好/角色切换/退出登录）。
 * 数据源=/me 经 T1 会话快照（useSession——登录时已取）；授权徽标独立 GET（页面可见即刷新）。
 * 退出登录复用 T1 session logout（与顶栏登出同一出口）。
 *
 * 角色切换（M3-W2 T1，W2-1 真链）：user 态且 /me roles 含 lawyer → 「切换为律师」；
 * lawyer 态同面回切「切换为用户」——POST /auth/switch-role 换 access token（refresh/登录态
 * 保留，R-02 双角色同账号），成功后 activeRole 翻转驱动壳层换 tab 集；失败走 error-messages
 * 错误态（如 403 E_ROLE_NOT_HELD）。律师态入口组复用 W1 视图（W2-7 决策：I1 无角色分面）。
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchTrainingConsent } from '../api/consents';
import { activeRoleCopy, roleCopy } from '../api/role-copy';
import { logout, switchRole } from '../api/session';
import { trainingConsentStatusCopy } from '../api/trade-copy';
import { useSession } from '../api/useSession';
import { useResource } from '../api/useResource';
import { isAppApiError } from '../api/client';
import { Button, ErrorText, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';

function RoleBadge({ role, active }: { readonly role: string; readonly active: boolean }) {
  return (
    <View style={[styles.roleBadge, active && styles.roleBadgeMine]}>
      <Text style={[styles.roleBadgeText, active && styles.roleBadgeTextMine]}>
        {roleCopy(role)}
      </Text>
    </View>
  );
}

/** 入口行（chevron › 前进暗示；右侧 badge 位可承载状态） */
function EntryRow({
  label,
  note,
  badge,
  badgeFailed,
  onPress,
  last,
}: {
  readonly label: string;
  readonly note?: string;
  readonly badge?: string;
  readonly badgeFailed?: boolean;
  readonly onPress: () => void;
  readonly last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.entryRow,
        pressed && styles.entryPressed,
        last && styles.entryLast,
      ]}
    >
      <View style={styles.entryTextBlock}>
        <Text style={styles.entryLabel}>{label}</Text>
        {note ? <Text style={styles.entryNote}>{note}</Text> : null}
      </View>
      <View style={styles.entryRight}>
        {badge ? (
          <View style={[styles.entryBadge, badgeFailed && styles.entryBadgeFailed]}>
            <Text style={[styles.entryBadgeText, badgeFailed && styles.entryBadgeTextFailed]}>
              {badge}
            </Text>
          </View>
        ) : null}
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

export function MeScreen() {
  const nav = useNavigation();
  const session = useSession();
  const me = session.me;
  const activeRole = session.activeRole;
  // 角色切换（W2-1 真链）：入口按持有角色与当前激活角色分流；进行中锁入口防连点
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const roles = me?.roles ?? [];
  const switchTarget = activeRole === 'user' ? 'lawyer' : 'user';
  const switchLabel = activeRole === 'user' ? '切换为律师' : '切换为用户';
  // R-02 双角色同账号：目标角色须在 /me roles 内（user 态入口=roles 含 lawyer 才显示；
  // lawyer 态回切面恒在——lawyer 账号默认具备 user 身份，仍以 roles 实查为准）
  const switchAvailable = roles.includes(switchTarget);

  async function handleSwitchRole(): Promise<void> {
    setSwitchError(null);
    setSwitching(true);
    try {
      await switchRole(switchTarget); // 成功后 activeRole 翻转 → 壳层换 tab 集（本页随角色重渲染）
    } catch (e) {
      setSwitchError(isAppApiError(e) ? e.message : '操作失败，请稍后重试');
    } finally {
      setSwitching(false);
    }
  }

  // 授权徽标独立装载：失败不阻塞入口面，但徽标位显性呈现「加载失败」（fail-visible，
  // 不静默吞错）——完整错误面板在授权页内
  const consent = useResource(() => fetchTrainingConsent(), []);
  const consentStatus = consent.state.phase === 'ready' ? consent.state.data.status : null;
  const consentBadge =
    consentStatus !== null
      ? trainingConsentStatusCopy(consentStatus)
      : consent.state.phase === 'error'
        ? '加载失败'
        : undefined;
  // 徽标失败样式键在状态上而非文案上（评审 S3：文案改动不丢样式；加载失败同走红点缀）
  const consentBadgeFailed = consent.state.phase === 'error' || consentStatus === 'REVOKED';

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="我的"
    >
      {/* 资料卡（/me 契约实文四键；无昵称字段——T1 triage，以 phone_masked 承载） */}
      <GlassCard style={styles.profileCard}>
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {me ? (me.phone_masked.slice(0, 3) ?? '') : '···'}
            </Text>
          </View>
          <View style={styles.profileTextBlock}>
            <Text style={styles.phone}>{me?.phone_masked ?? '—'}</Text>
            <MutedText>
              {me ? `账号状态 ${me.status === 'ACTIVE' ? '正常' : me.status}` : '资料加载中…'}
            </MutedText>
            <MutedText>当前 · {activeRoleCopy(activeRole)}</MutedText>
          </View>
          <View style={styles.roleRow}>
            {roles.map((r) => (
              <RoleBadge key={r} role={r} active={r === activeRole} />
            ))}
          </View>
        </View>
      </GlassCard>

      {switchAvailable ? (
        <GlassCard style={styles.switchCard}>
          <View style={styles.switchRow}>
            <View style={styles.switchTextBlock}>
              <Text style={styles.switchLabel}>{switchLabel}</Text>
              <MutedText>双角色同账号，切换端别不退出登录（A1 R-02）</MutedText>
            </View>
            <Button
              label={switching ? '切换中' : switchLabel}
              variant="secondary"
              small
              busy={switching}
              disabled={switching}
              onPress={() => void handleSwitchRole()}
            />
          </View>
          <ErrorText>{switchError}</ErrorText>
        </GlassCard>
      ) : null}

      <GlassCard style={styles.entriesCard}>
        <EntryRow
          label="我的报名"
          note="场次与拼团的报名支付记录"
          onPress={() => nav.push({ key: 'myEnrollments' })}
        />
        <EntryRow
          label="我的拼团"
          note="我发起的与我参与的"
          onPress={() => nav.push({ key: 'myGroupBuys' })}
        />
        <EntryRow
          label="AI 训练数据授权"
          note="专项语料授权状态与撤回"
          badge={consentBadge}
          badgeFailed={consentBadgeFailed}
          onPress={() => nav.push({ key: 'trainingConsent' })}
        />
        <EntryRow
          label="通知偏好"
          note="关闭不想收到的通知类别"
          onPress={() => nav.push({ key: 'notificationPrefs' })}
        />
        <EntryRow label="退出登录" note="结束当前登录态" last onPress={() => void logout()} />
      </GlassCard>

      <MutedText>{'律聚人 · 组团解决法律问题的多垂直平台'}</MutedText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  profileCard: { padding: spacing.lg },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radius.card,
    backgroundColor: colors.primary2A15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  profileTextBlock: { flexShrink: 1, gap: 2 },
  phone: { color: colors.ink, fontSize: fontSize.xl, fontWeight: fontWeight.semibold },
  roleRow: { flexDirection: 'row', gap: spacing.xs },
  switchCard: { padding: spacing.lg, gap: spacing.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchTextBlock: { flexShrink: 1, gap: 2 },
  switchLabel: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  roleBadge: {
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A15,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
  },
  roleBadgeMine: { backgroundColor: colors.primary2A15 },
  roleBadgeText: { color: colors.ink2, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  roleBadgeTextMine: { color: colors.primary },
  entriesCard: { padding: spacing.sm },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  entryLast: { borderBottomWidth: 0 },
  entryPressed: { opacity: 0.75 },
  entryTextBlock: { flexShrink: 1, gap: 2 },
  entryLabel: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  entryNote: { color: colors.ink2, fontSize: fontSize.xs },
  entryRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  entryBadge: {
    borderRadius: radius.pill,
    backgroundColor: colors.primary2A15,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
  },
  entryBadgeFailed: { backgroundColor: colors.accentCard },
  entryBadgeText: { color: colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  entryBadgeTextFailed: { color: colors.accentDk },
  chevron: { color: colors.ink2, fontSize: fontSize.xl },
});
