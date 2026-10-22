/**
 * 导航状态机（M3-W1 T1，评审修复 I1）：纯函数模块，router.tsx 为其 React 绑定壳。
 *
 * 语义（评审裁定）：tab 切换 = pop-to-root——切 tab 即清推栈回该 tab 根；
 * 推栈仅在单 tab 内生长，返回逐层 pop。抽纯模块使状态迁移可被 bun test 直测。
 */

/** 五 tab（导航信息架构决策：首页/场次/发团/消息/我的） */
export type TabKey = 'home' | 'sessions' | 'publish' | 'messages' | 'me';

/** 推栈路由（key 需在 STACK_ROUTES 登记后才可 push） */
export interface StackRoute {
  readonly key: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface NavigationState {
  readonly tab: TabKey;
  readonly stack: readonly StackRoute[];
}

export const INITIAL_NAVIGATION_STATE: NavigationState = { tab: 'home', stack: [] };

/** I1：切 tab = pop-to-root（清推栈；推栈页在身时点 tab 必须回根，画面随之切换） */
export function switchTab(state: NavigationState, tab: TabKey): NavigationState {
  return { tab, stack: [] };
}

export function pushRoute(state: NavigationState, route: StackRoute): NavigationState {
  return { ...state, stack: [...state.stack, route] };
}

export function popRoute(state: NavigationState): NavigationState {
  return state.stack.length > 0 ? { ...state, stack: state.stack.slice(0, -1) } : state;
}

export function topRoute(state: NavigationState): StackRoute | null {
  return state.stack.length > 0 ? (state.stack[state.stack.length - 1] as StackRoute) : null;
}
