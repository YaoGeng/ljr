/**
 * admin 应用壳（M3-W3 T1）：顶栏（品牌 + 登录手机号尾号 + 退出）+ 左侧 sidebar + 内容主列，
 * 布局对照 prototype 后台壳（.adm-topbar/.ad-side/.ad-main 同构）。后台无深色模式、无端切换
 * （单端形态，原型三端 seg 不属于本壳）。退出=本地清会话（access token 服务端自然过期——
 * refresh_token 未存储，无吊销面，见 session.ts 注记）。
 */
import type { ReactNode } from 'react';
import type { AdminRoute, ShellRouteKey } from '../navigation/router-state';
import { ADMIN_APP_NAME } from '../health';
import { AdminSidebar } from './AdminSidebar';
import { IconLogout } from './icons';

interface AppShellProps {
  readonly route: AdminRoute;
  readonly phoneTail: string | null;
  onNavigate(route: ShellRouteKey): void;
  onSignOut(): void;
  readonly children: ReactNode;
}

export function AppShell({ route, phoneTail, onNavigate, onSignOut, children }: AppShellProps) {
  return (
    <div className="admin-root">
      <header className="adm-topbar">
        <div className="adm-brand">
          <span className="adm-seal">律</span>
          {ADMIN_APP_NAME}
        </div>
        <div className="adm-topbar-right">
          {phoneTail !== null ? <span>登录尾号 {phoneTail}</span> : null}
          <button type="button" className="btn btn-o btn-sm" onClick={onSignOut}>
            <IconLogout size={14} />
            退出
          </button>
        </div>
      </header>
      <div className="admin-body">
        <AdminSidebar activeRoute={route.key} onNavigate={onNavigate} />
        <main className="ad-main">{children}</main>
      </div>
    </div>
  );
}
