/**
 * 轻量路由（M3-W1 T1，⚠W1-3 决策：不引 react-navigation）。
 *
 * 形态：五 tab 状态 + 推栈（stack）数组，纯 React state 实现，RN/RN-web 同构，零新依赖。
 * 状态迁移逻辑在 navigation-state.ts（纯函数，bun test 直测）；本文件只做 React 绑定。
 * 深链/嵌套导航等超出自建合理面时按 W1-3 升级决策停卡处理。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  INITIAL_NAVIGATION_STATE,
  popRoute,
  pushRoute,
  switchTab,
  topRoute,
  type NavigationState,
  type StackRoute,
  type TabKey,
} from './navigation-state';

export type { StackRoute, TabKey } from './navigation-state';

export interface NavigationValue {
  readonly tab: TabKey;
  readonly setTab: (tab: TabKey) => void;
  readonly stack: readonly StackRoute[];
  readonly top: StackRoute | null;
  readonly push: (route: StackRoute) => void;
  readonly pop: () => void;
}

const NOOP_NAVIGATION: NavigationValue = {
  tab: 'home',
  setTab: () => undefined,
  stack: [],
  top: null,
  push: () => undefined,
  pop: () => undefined,
};

const NavigationContext = createContext<NavigationValue>(NOOP_NAVIGATION);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NavigationState>(INITIAL_NAVIGATION_STATE);

  const setTab = useCallback((tab: TabKey) => {
    setState((prev) => switchTab(prev, tab));
  }, []);

  const push = useCallback((route: StackRoute) => {
    setState((prev) => pushRoute(prev, route));
  }, []);

  const pop = useCallback(() => {
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
    }),
    [state, setTab, push, pop],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationValue {
  return useContext(NavigationContext);
}
