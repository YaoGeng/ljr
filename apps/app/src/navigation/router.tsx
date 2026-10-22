/**
 * 轻量路由（M3-W1 T1 建/W2 T1 扩 role 感知/T2 扩返回拦截，⚠W1-3 决策：不引 react-navigation）。
 *
 * 形态：tab 状态（role 感知：user 五 tab ↔ lawyer 四 tab）+ 推栈（stack）数组，纯 React
 * state 实现，RN/RN-web 同构，零新依赖。状态迁移逻辑在 navigation-state.ts（纯函数，
 * bun test 直测）；本文件只做 React 绑定。role 变化（switch-role 真链）经 applyRole 收口：
 * 非法 tab 回角色首 tab + pop-to-root。深链/嵌套导航等超出自建合理面时按 W1-3 升级决策
 * 停卡处理。
 *
 * M3-W2 T2 返回拦截：推栈页可经 setPopGuard 登记「未保存离开确认」——guard 返回 true 时
 * pop 不执行（登记方出示页内确认面板；RN-web Alert 不可用故不走原生弹窗）。作用域=pop；
 * 切 tab 的 pop-to-root 不拦截（离开提示以页内常驻未保存条承载，见时间表页）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  INITIAL_NAVIGATION_STATE,
  applyRole,
  popRoute,
  pushRoute,
  shouldInterceptPop,
  switchTab,
  topRoute,
  type AppRole,
  type NavigationState,
  type StackRoute,
  type TabKey,
} from './navigation-state';

export type { AppRole, StackRoute, TabKey } from './navigation-state';

export interface NavigationValue {
  readonly tab: TabKey;
  readonly setTab: (tab: TabKey) => void;
  readonly stack: readonly StackRoute[];
  readonly top: StackRoute | null;
  readonly push: (route: StackRoute) => void;
  readonly pop: () => void;
  /** 登记返回拦截（M3-W2 T2）：pop 前征询；返回 true=拦截（由登记方出示确认 UI），pop 不执行 */
  readonly setPopGuard: (guard: (() => boolean) | null) => void;
}

const NOOP_NAVIGATION: NavigationValue = {
  tab: 'home',
  setTab: () => undefined,
  stack: [],
  top: null,
  push: () => undefined,
  pop: () => undefined,
  setPopGuard: () => undefined,
};

const NavigationContext = createContext<NavigationValue>(NOOP_NAVIGATION);

export interface NavigationProviderProps {
  readonly children: ReactNode;
  /** 当前激活角色（session.activeRole）：变化时导航收口（applyRole——tab 集切换+清推栈） */
  readonly role?: AppRole;
}

export function NavigationProvider({ children, role = 'user' }: NavigationProviderProps) {
  // 惰性初始化消费首帧 role（评审 N2）：lawyer-only 账号登录（activeRole=lawyer）首挂载即
  // 落律师首 tab——不闪用户首页一帧再收口
  const [state, setState] = useState<NavigationState>(() =>
    applyRole(INITIAL_NAVIGATION_STATE, role),
  );

  // 角色切换收口（M3-W2 T1）：switch-role 换签后 tab 栏换角色集，导航回角色根
  // （首帧已由惰性初始化消费；effect 首跑 applyRole 幂等——tab 在集内时仅重发布同形状态）
  useEffect(() => {
    setState((prev) => applyRole(prev, role));
  }, [role]);

  const setTab = useCallback((tab: TabKey) => {
    setState((prev) => switchTab(prev, tab));
  }, []);

  const push = useCallback((route: StackRoute) => {
    setState((prev) => pushRoute(prev, route));
  }, []);

  // 返回拦截（M3-W2 T2：时间表未保存离开确认）：guard 存在且返回 true → pop 不执行，
  // 登记方（推栈页）自行出示确认面板（RN-web 无 Alert，走页内 UI）；卸载/置 null 即撤防。
  // 裁决经 shouldInterceptPop 纯函数（navigation-state.test 直测；修复环 I-1）。
  const popGuardRef = useRef<(() => boolean) | null>(null);
  const setPopGuard = useCallback((guard: (() => boolean) | null) => {
    popGuardRef.current = guard;
  }, []);
  const pop = useCallback(() => {
    if (shouldInterceptPop(popGuardRef.current)) return;
    setState((prev) => popRoute(prev));
  }, []);

  const value = useMemo<NavigationValue>(
    () => ({
      tab: state.tab,
      setTab,
      stack: state.stack,
      top: topRoute(state),
      push,
      pop,
      setPopGuard,
    }),
    [state, setTab, push, pop, setPopGuard],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationValue {
  return useContext(NavigationContext);
}
