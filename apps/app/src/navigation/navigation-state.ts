/**
 * 导航状态机（M3-W1 T1 建/W2 T1 扩）：纯函数模块，router.tsx 为其 React 绑定壳。
 *
 * 语义（评审裁定）：tab 切换 = pop-to-root——切 tab 即清推栈回该 tab 根；
 * 推栈仅在单 tab 内生长，返回逐层 pop。抽纯模块使状态迁移可被 bun test 直测。
 *
 * M3-W2 T1 两项升级：
 *   - role 感知 tab 集：user 五 tab ↔ lawyer 四 tab（对照原型 TABS.lawyer：
 *     工作台/场次管理/接单大厅/我的）；applyRole 承载 switch-role 后的导航收口
 *     （非法 tab 回角色首 tab + pop-to-root）；
 *   - 防双 push（W1 登记「StackRoute 实例 id 与连点防抖」兑现）：push 时栈顶已是
 *     同 key 同 params 实例则忽略——连点/嵌套同绑 onPress 不再推出双层栈（W1 E2E 曾以
 *     「推栈深度=1」断言绕过，本卡从路由层治本）；同 key 不同 params=合法双实例放行
 *     （评审 I2：实例身份=key+params 浅相等，key 单独判重会封死「看板→另一场次详情」）。
 */

/** 用户五 tab（导航信息架构决策：首页/场次/发团/消息/我的） */
export type UserTabKey = 'home' | 'sessions' | 'publish' | 'messages' | 'me';

/** 律师四 tab（对照原型 TABS.lawyer：工作台/场次管理/接单大厅/我的；视图 T2~T6 逐卡填实） */
export type LawyerTabKey = 'lawyerWork' | 'lawyerSessions' | 'lawyerHall' | 'lawyerMe';

export type TabKey = UserTabKey | LawyerTabKey;

/**
 * 激活角色（A1 R-02 双角色同账号：claims.role 词汇=user|lawyer，switch-role 重签的事实源；
 * admin=权限旗标非激活角色——identity.guards 同口径，不入本类型）。
 * 定义在导航纯模块（零依赖叶子），api/session 经 type-only 引用，不构成运行时耦合。
 */
export type AppRole = 'user' | 'lawyer';

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

/** role → tab 集单源（tab 栏渲染与 applyRole 收口共用，禁散写第二份） */
export const TABS_BY_ROLE: Readonly<Record<AppRole, readonly TabKey[]>> = {
  user: ['home', 'sessions', 'publish', 'messages', 'me'],
  lawyer: ['lawyerWork', 'lawyerSessions', 'lawyerHall', 'lawyerMe'],
};

export function tabsForRole(role: AppRole): readonly TabKey[] {
  return TABS_BY_ROLE[role];
}

/** I1：切 tab = pop-to-root（清推栈；推栈页在身时点 tab 必须回根，画面随之切换） */
export function switchTab(state: NavigationState, tab: TabKey): NavigationState {
  return { tab, stack: [] };
}

/**
 * params 浅相等（评审 I2）：键集一致且逐键 Object.is 相等（params 值域=路由参数原始值，
 * 无嵌套对象——深层比较无消费方）。缺省（undefined）≠ 空对象：一方无 params 一方有
 * → 不等（不同实例）。
 */
function sameParams(
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (a === b) return true; // 含两者皆 undefined
  if (a === undefined || b === undefined) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.is(a[k], b[k]));
}

/**
 * 防双 push：栈顶已是同 key **同 params** 实例 → 原状态引用返回（零迁移）。
 * 连点第二次与「卡片+内层按钮同绑 onPress」双触发（T2 评审 S8 观察点）在此收敛——
 * 连点第二次 params 必同；同 key 不同 params（如场次看板→另一场次详情）=合法双实例
 * 放行（评审 I2：key 单独判重会封死合法推栈）；异 key 正常生长，pop 回上层后再遇
 * 同 key 同 params 顶同样收敛。
 */
export function pushRoute(state: NavigationState, route: StackRoute): NavigationState {
  const top = topRoute(state);
  if (top !== null && top.key === route.key && sameParams(top.params, route.params)) {
    return state;
  }
  return { ...state, stack: [...state.stack, route] };
}

export function popRoute(state: NavigationState): NavigationState {
  return state.stack.length > 0 ? { ...state, stack: state.stack.slice(0, -1) } : state;
}

/**
 * pop 拦截裁决（M3-W2 T2 修复环 I-1 的纯函数面，router.pop 消费）：guard 存在且
 * 返回 true → 拦截（不执行 pop，登记方出示确认面板）；null/ false → 放行。
 * 抽纯函数使拦截语义可被 bun test 直测（router.tsx 只做 React 绑定）。
 */
export function shouldInterceptPop(guard: (() => boolean) | null): boolean {
  return guard !== null && guard();
}

export function topRoute(state: NavigationState): StackRoute | null {
  return state.stack.length > 0 ? (state.stack[state.stack.length - 1] as StackRoute) : null;
}

/**
 * 角色切换收口（switch-role 真链后由 router 调用）：目标角色 tab 集内保留当前 tab，
 * 否则回角色首 tab；一律 pop-to-root（角色壳不残留跨角色推栈页）。
 */
export function applyRole(state: NavigationState, role: AppRole): NavigationState {
  const tabs = tabsForRole(role);
  const tab = tabs.includes(state.tab) ? state.tab : (tabs[0] as TabKey);
  return { tab, stack: [] };
}
