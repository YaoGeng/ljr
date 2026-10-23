/**
 * hash 路由纯函数（M3-W3 T1，W3-3）：手写 hash 路由的状态解析层，零依赖可被 bun test 直测
 * （风格对照 apps/app/src/navigation/navigation-state.ts——纯函数模块 + React 绑定壳分离）。
 *
 * 路由形态 `#/login`、`#/`、`#/lawyers`（W3-3 拍板：手写 hash=任意静态宿零回退配置；
 * react-router 需独立依赖决策卡不引入）。
 * W3 页面路由位：home（#/ 轻量指标条）+ lawyers/tickets/risk/rules/pricing-approvals
 * （T2~T6 五页面全落位——pricing-approvals=C6 改价审批台，T6 超 T1 预留位扩键）；
 * 登录门语义收口在 resolveRoute：未登录任意 hash → login；已登录访问 login → home。
 * 未知 hash（含深层路径首段外未登记的）→ home 兜底（不发明 404 页——PRD 未定义）。
 */

/** 路由键（login 门 + 概览 + W3 五页面位；详情 params 需求落位时再扩不预发明） */
export type AdminRouteKey =
  'login' | 'home' | 'lawyers' | 'tickets' | 'risk' | 'rules' | 'pricing-approvals';

export interface AdminRoute {
  readonly key: AdminRouteKey;
}

/** 壳内可导航路由键（登录页不经壳——AppShell onNavigate 与 App 分发的共用收窄口径，单源） */
export type ShellRouteKey = Exclude<AdminRouteKey, 'login'>;

export const LOGIN_ROUTE: AdminRoute = { key: 'login' };
export const HOME_ROUTE: AdminRoute = { key: 'home' };

/** 路由键 → hash（渲染导航与 URL 同源单表，禁散写第二份） */
export const ROUTE_HASH: Readonly<Record<AdminRouteKey, string>> = {
  login: '#/login',
  home: '#/',
  lawyers: '#/lawyers',
  tickets: '#/tickets',
  risk: '#/risk',
  rules: '#/rules',
  'pricing-approvals': '#/pricing-approvals',
};

/** 登记在册的 hash 路径段（parseHash 的合法首段集） */
const ROUTE_PATHS: ReadonlyMap<string, AdminRouteKey> = new Map(
  (Object.keys(ROUTE_HASH) as AdminRouteKey[]).map((key) => [
    ROUTE_HASH[key].slice(1), // '#/x' → '/x'
    key,
  ]),
);

/**
 * 解析 hash → 路由：'' / '#' / '#/' → home；'#/x'（x 在册）→ 对应路由。
 * 深层路径（如 '#/lawyers/42'）按首段收口——详情路由 T2~T6 落位时再扩 params，本卡不发明。
 * 输入词汇严格化：只认 location.hash 形态（'' / '#' / '#/…'），裸 '/login'、'lawyers' 等
 * 非 hash 前缀串不解析 → null（由 resolveRoute 兜底 home，防 pathname 误用）。
 */
export function parseHash(hash: string): AdminRoute | null {
  if (hash === '' || hash === '#') return HOME_ROUTE;
  if (!hash.startsWith('#/')) return null;
  const firstSeg = hash.slice(2).split('/')[0] ?? '';
  if (firstSeg === '') return HOME_ROUTE; // '#/'（及空段形态）
  const key = ROUTE_PATHS.get(`/${firstSeg}`);
  return key === undefined ? null : { key };
}

/** 路由 → hash（与 ROUTE_HASH 单表同源） */
export function routeHash(route: AdminRoute): string {
  return ROUTE_HASH[route.key];
}

export interface ResolvedRoute {
  readonly route: AdminRoute;
  /** true=发生重定向（React 绑定壳据此 location.replace 收口 URL，不留历史记录） */
  readonly redirected: boolean;
}

/**
 * 登录门 + 兜底解析（本模块的收口规则）：
 *   - 未登录：仅 login 可停驻，其余任意 hash（含未知/空）→ 重定向 login；
 *   - 已登录：login → 重定向 home；未知 hash → 兜底 home（不发明 404）；其余原样放行。
 * authed 的判定口径=调用方传入（session 层：status=authenticated ⇒ roles 含 admin）。
 */
export function resolveRoute(input: { hash: string; authed: boolean }): ResolvedRoute {
  const parsed = parseHash(input.hash);
  if (!input.authed) {
    if (parsed?.key === 'login') return { route: parsed, redirected: false };
    return { route: LOGIN_ROUTE, redirected: input.hash !== ROUTE_HASH.login };
  }
  if (parsed === null) return { route: HOME_ROUTE, redirected: true };
  if (parsed.key === 'login') return { route: HOME_ROUTE, redirected: true };
  return { route: parsed, redirected: false };
}
