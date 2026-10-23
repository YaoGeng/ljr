/**
 * admin 根组件（M3-W3 T1）：登录门 + hash 路由 + 壳。
 *
 * - 会话恢复不在本组件（评审 IMPORTANT-1）：main.tsx 在 createRoot().render 前同步
 *   restoreSession()——首渲染即 authenticated，已登录刷新不闪 LoginPage、深层路由
 *   （#/lawyers）不被 login 重定向丢失；本组件 effect 只注册 401 拦截回调；
 * - 401 统一拦截：client 受保护面会话失效 → signOut() → 会话翻 anonymous 后 hash 路由
 *   对未登录态自动收口回 #/login（无需命令式导航）；
 * - 未登录（anonymous）→ 登录页（resolveRoute 已保证任何 hash 都停在 login）；
 *   已登录 → AppShell（sidebar 四组 + 顶栏）承载路由页面；
 * - W3 页面落位进度：lawyers=T2（H1 审核工作台）/ tickets=T3（H3 纠纷工单）/ risk=T4（H5
 *   风控人审+词库）/ rules=T5（H7 规则中心）/ pricing-approvals=T6（C6 改价审批台）全落位。
 */
import { useEffect } from 'react';
import { setOnUnauthorized } from './api/client';
import { signOut } from './api/session';
import { useAdminSession } from './api/useAdminSession';
import { useHashRoute } from './navigation/useHashRoute';
import type { AdminRoute, ShellRouteKey } from './navigation/router-state';
import { AppShell } from './components/AppShell';
import { HomePage } from './pages/HomePage';
import { LawyersPage } from './pages/LawyersPage';
import { LoginPage } from './pages/LoginPage';
import { PricingApprovalsPage } from './pages/PricingApprovalsPage';
import { RiskPage } from './pages/RiskPage';
import { RulesPage } from './pages/RulesPage';
import { TicketsPage } from './pages/TicketsPage';

function routePage(route: AdminRoute): React.ReactNode {
  switch (route.key) {
    case 'home':
      return <HomePage />;
    case 'lawyers':
      return <LawyersPage />;
    case 'tickets':
      return <TicketsPage />;
    case 'risk':
      return <RiskPage />;
    case 'rules':
      return <RulesPage />;
    case 'pricing-approvals':
      return <PricingApprovalsPage />;
    case 'login':
      return null; // 登录页由根直接渲染，不经壳
  }
}

export function App() {
  useEffect(() => {
    // 401 统一拦截：受保护面会话失效 → 清会话（路由层随 anonymous 态自动回 #/login）
    setOnUnauthorized(() => {
      signOut();
    });
    return () => {
      setOnUnauthorized(null);
    };
  }, []);

  const session = useAdminSession();
  const authed = session.status === 'authenticated';
  const { route, navigate } = useHashRoute(authed);

  if (!authed || route.key === 'login') {
    return <LoginPage />;
  }
  return (
    <AppShell
      route={route}
      phoneTail={session.phoneTail}
      onNavigate={(key: ShellRouteKey) => navigate(key)}
      onSignOut={signOut}
    >
      {routePage(route)}
    </AppShell>
  );
}
