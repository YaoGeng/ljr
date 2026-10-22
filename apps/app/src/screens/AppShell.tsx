/**
 * 应用壳（M3-W1 T1 建/T4 收口/W2 T1 扩 role 感知）：顶栏（App 名 + 用户态 + 登出）+ tab 内容
 * + 底部 tab 栏（user 五 tab ↔ lawyer 四 tab——session.activeRole 驱动；律师 tab 视图为
 * M3-W2 T2~T6 施工占位）。推栈路由存在时整块内容区切换为推栈页（顶栏变返回+标题）。
 * 用户端五 tab 视图已全落位；屏映射集中在本文件，禁止散建第二张路由表。
 */
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { APP_NAME } from '../app-info';
import { logout } from '../api/session';
import { useSession } from '../api/useSession';
import { BackIcon, LogoutIcon } from '../components/icons';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { tabRoutesForRole, stackRouteTitle } from '../navigation/routes';
import { NavigationProvider, useNavigation, type TabKey } from '../navigation/router';
import { EnrollmentScreen } from './EnrollmentScreen';
import { HomeScreen } from './HomeScreen';
import { LawyerBoardScreen } from './LawyerBoardScreen';
import { LawyerCreateSessionScreen } from './LawyerCreateSessionScreen';
import { LawyerDraftsScreen } from './LawyerDraftsScreen';
import { LawyerHallScreen } from './LawyerHallScreen';
import { LawyerPricingScreen } from './LawyerPricingScreen';
import { LawyerScheduleScreen } from './LawyerScheduleScreen';
import { LawyerSessionsScreen } from './LawyerSessionsScreen';
import { LawyerWorkScreen } from './LawyerWorkScreen';
import { MeScreen } from './MeScreen';
import { MessagesScreen } from './MessagesScreen';
import { MyEnrollmentsScreen } from './MyEnrollmentsScreen';
import { MyGroupBuysScreen } from './MyGroupBuysScreen';
import { NotificationPrefsScreen } from './NotificationPrefsScreen';
import { PlaceholderScreen } from './PlaceholderScreen';
import { PublishScreen } from './PublishScreen';
import { RealnameScreen } from './RealnameScreen';
import { SessionDetailScreen } from './SessionDetailScreen';
import { SessionListScreen } from './SessionListScreen';
import { TrainingConsentScreen } from './TrainingConsentScreen';

/** tab → 屏组件映射（user 五 tab=T4 全落位；lawyer=工作台/场次管理/接单大厅落位） */
const TAB_SCREENS: Readonly<Record<TabKey, () => ReactElement>> = {
  home: () => <HomeScreen />,
  sessions: () => <SessionListScreen />,
  publish: () => <PublishScreen />,
  messages: () => <MessagesScreen />,
  me: () => <MeScreen />,
  lawyerWork: () => <LawyerWorkScreen />,
  // T5 落位（M3-W2）：公开面 CREATED 列表（#48-① 如实承载）+按 ID 直达看板
  lawyerSessions: () => <LawyerSessionsScreen />,
  lawyerHall: () => <LawyerHallScreen />,
  lawyerMe: () => <MeScreen />,
};

/** 推栈 → 屏组件映射（T4：+我的报名/我的拼团/通知偏好；T2：+时间表；未登记键回退占位） */
const STACK_SCREENS: Readonly<
  Record<string, (p: { readonly params?: Readonly<Record<string, unknown>> }) => ReactElement>
> = {
  sessionDetail: (p) => <SessionDetailScreen params={p.params} />,
  enrollmentPlaceholder: (p) => <EnrollmentScreen params={p.params} />,
  realname: (p) => <RealnameScreen params={p.params} />,
  trainingConsent: () => <TrainingConsentScreen />,
  myEnrollments: () => <MyEnrollmentsScreen />,
  myGroupBuys: () => <MyGroupBuysScreen />,
  notificationPrefs: () => <NotificationPrefsScreen />,
  lawyerSchedule: () => <LawyerScheduleScreen />,
  // T3 落位（M3-W2）：C1 B2C 七键表单+B2 锁错误态；FREE 时段预选经 params.slot_start
  lawyerCreateSession: (p) => <LawyerCreateSessionScreen params={p.params} />,
  // T3 落位（M3-W2）：B3 默认价格与 1对1 配置 + C6 改价申请子面
  lawyerPricing: () => <LawyerPricingScreen />,
  // T5 落位（M3-W2）：D1/D3 只读聚合看板+关房/取消；params={id}（场次号，任意态详情可达）
  lawyerBoard: (p) => <LawyerBoardScreen params={p.params} />,
  // T6 落位（M3-W2）：E1 草稿气泡审查（GET /agent/drafts+三动作）；params={room_id}（看板跳转带入）
  lawyerDrafts: (p) => <LawyerDraftsScreen params={p.params} />,
};

export function AppShell() {
  const session = useSession();
  return (
    <NavigationProvider role={session.activeRole}>
      <ShellFrame />
    </NavigationProvider>
  );
}

/** 推栈页渲染：登记键落位实现，未登记键回退占位（防散建第二张路由表） */
function StackBody({
  route,
}: {
  readonly route: { key: string; params?: Readonly<Record<string, unknown>> };
}) {
  const Screen = STACK_SCREENS[route.key];
  if (Screen) return <Screen params={route.params} />;
  return (
    <PlaceholderScreen title="未登记路由" note={`route=${route.key}（未在 STACK_SCREENS 落位）`} />
  );
}

function ShellFrame() {
  const nav = useNavigation();
  const session = useSession();
  const role = session.activeRole;
  const tabRoutes = tabRoutesForRole(role);
  const TabBody = TAB_SCREENS[nav.tab];
  const top = nav.top;

  return (
    <View style={styles.frame}>
      <View style={styles.topbar}>
        {top ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回"
            onPress={nav.pop}
            style={styles.backBtn}
            hitSlop={8}
          >
            <BackIcon color={colors.primary} size={20} />
          </Pressable>
        ) : (
          <View style={styles.seal}>
            <Text style={styles.sealText}>律</Text>
          </View>
        )}
        <Text style={styles.topbarTitle}>{top ? stackRouteTitle(top.key) : APP_NAME}</Text>
        {!top ? (
          <View style={styles.userChip}>
            <Text style={styles.userChipText} numberOfLines={1}>
              {session.me?.phone_masked ?? '已登录'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="退出登录"
              onPress={() => void logout()}
              style={styles.logoutBtn}
              hitSlop={8}
            >
              <LogoutIcon color={colors.primary} size={18} />
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>{top ? <StackBody route={top} /> : <TabBody />}</View>

      <View style={styles.tabbar}>
        {tabRoutes.map(({ key, title, Icon }) => {
          const active = !top && nav.tab === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => nav.setTab(key)}
              style={styles.tabItem}
            >
              <Icon color={active ? colors.primary : colors.ink2} size={22} />
              <Text style={[styles.tabLabel, active && styles.tabLabelOn]}>{title}</Text>
              {active ? <View style={styles.tabDot} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.bg },
  topbar: {
    height: 60,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderBottomWidth: 1,
    borderBottomColor: colors.glassHi,
  },
  seal: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: colors.primary2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sealText: { color: colors.onPrimary, fontSize: fontSize.md, fontWeight: fontWeight.bold },
  topbarTitle: {
    color: colors.ink,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
  },
  userChip: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  userChipText: { color: colors.ink2, fontSize: fontSize.md },
  logoutBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.glass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1 },
  tabbar: {
    height: 66,
    flexDirection: 'row',
    paddingHorizontal: spacing.sm,
    paddingTop: 6,
    paddingBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderTopWidth: 1,
    borderTopColor: colors.glassHi,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: radius.lg,
    position: 'relative',
  },
  tabLabel: { color: colors.ink2, fontSize: fontSize.xs },
  tabLabelOn: { color: colors.primary, fontWeight: fontWeight.semibold },
  /** 激活 tab 下的豆沙红位点（原型 .p-tabbar button.on::after 同款，点缀铁律位） */
  tabDot: {
    position: 'absolute',
    bottom: 1,
    width: 4,
    height: 4,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
});
