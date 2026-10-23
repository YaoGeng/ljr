/**
 * hash 路由 React 绑定（M3-W3 T1）：router-state.ts 纯函数的 DOM 壳。
 *
 * - hashchange 监听 + resolveRoute 收口：重定向用 location.replace（不留历史记录——
 *   「未登录弹回登录」不可后退绕门）；
 * - navigate()：赋 location.hash 触发 hashchange；同值赋值无事件（resolve 结果本就稳定，
 *   状态无需更新）；直接改地址栏/刷新由监听器接住（hash 路由天然可刷新可直链）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AdminRoute, type AdminRouteKey, resolveRoute, routeHash } from './router-state';

export interface HashRouter {
  readonly route: AdminRoute;
  navigate(to: AdminRouteKey): void;
}

export function useHashRoute(authed: boolean): HashRouter {
  const [hash, setHash] = useState<string>(() => window.location.hash);

  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // 解析结果按输入固化（redirect effect 依赖其稳定性——authed 翻转即重收口）
  const resolved = useMemo(() => resolveRoute({ hash, authed }), [hash, authed]);

  useEffect(() => {
    if (resolved.redirected) {
      window.location.replace(routeHash(resolved.route));
    }
  }, [resolved.redirected, resolved.route]);

  const navigate = useCallback((to: AdminRouteKey) => {
    window.location.hash = routeHash({ key: to });
  }, []);

  return { route: resolved.route, navigate };
}
