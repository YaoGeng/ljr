import { describe, expect, it } from 'bun:test';
import {
  HOME_ROUTE,
  LOGIN_ROUTE,
  parseHash,
  resolveRoute,
  routeHash,
  type AdminRoute,
} from './router-state';

function keyOf(route: AdminRoute | null): string | null {
  return route?.key ?? null;
}

describe('admin hash 路由纯函数（M3-W3 T1）', () => {
  it('合法 hash 解析：#/login、#/、五页面施工位、深层路径首段收口', () => {
    expect(keyOf(parseHash('#/login'))).toBe('login');
    expect(keyOf(parseHash('#/'))).toBe('home');
    expect(keyOf(parseHash('#'))).toBe('home');
    expect(keyOf(parseHash(''))).toBe('home');
    expect(keyOf(parseHash('#/lawyers'))).toBe('lawyers');
    expect(keyOf(parseHash('#/tickets'))).toBe('tickets');
    expect(keyOf(parseHash('#/risk'))).toBe('risk');
    expect(keyOf(parseHash('#/rules'))).toBe('rules');
    expect(keyOf(parseHash('#/pricing-approvals'))).toBe('pricing-approvals');
    // 深层路径（详情路由 T2~T6 落位前）按首段收口，不发明新路由
    expect(keyOf(parseHash('#/lawyers/42'))).toBe('lawyers');
  });

  it('未登记/非 hash 前缀 → null（resolveRoute 兜底 home）', () => {
    expect(parseHash('#/xyz')).toBeNull();
    expect(parseHash('lawyers')).toBeNull(); // 裸段（非 location.hash 词汇）不解析
    expect(parseHash('/login')).toBeNull(); // 缺 '#' 前缀（防 pathname 误用）
  });

  it('routeHash 与 ROUTE_HASH 单表同源（全键 roundtrip）', () => {
    for (const key of [
      'login',
      'home',
      'lawyers',
      'tickets',
      'risk',
      'rules',
      'pricing-approvals',
    ] as const) {
      expect(routeHash({ key })).toBe(`#/${key === 'home' ? '' : key}`);
    }
  });

  it('登录门：未登录任意 hash（含未知/空）重定向 login；#/login 可停驻', () => {
    expect(resolveRoute({ hash: '#/login', authed: false })).toEqual({
      route: LOGIN_ROUTE,
      redirected: false,
    });
    for (const hash of ['#/lawyers', '#/', '', '#/xyz']) {
      expect(resolveRoute({ hash, authed: false })).toEqual({
        route: LOGIN_ROUTE,
        redirected: true,
      });
    }
  });

  it('已登录：#/login 重定向 home；未知 hash 兜底 home；业务路由原样放行', () => {
    expect(resolveRoute({ hash: '#/login', authed: true })).toEqual({
      route: HOME_ROUTE,
      redirected: true,
    });
    expect(resolveRoute({ hash: '#/xyz', authed: true })).toEqual({
      route: HOME_ROUTE,
      redirected: true,
    });
    expect(resolveRoute({ hash: '#/tickets', authed: true })).toEqual({
      route: { key: 'tickets' },
      redirected: false,
    });
    // T6 落位：C6 改价审批台（超 T1 预留五路由位的第六页）
    expect(resolveRoute({ hash: '#/pricing-approvals', authed: true })).toEqual({
      route: { key: 'pricing-approvals' },
      redirected: false,
    });
    // 空 hash=home 原位（不重定向——URL 保持无 hash 也停在首页）
    expect(resolveRoute({ hash: '', authed: true })).toEqual({
      route: HOME_ROUTE,
      redirected: false,
    });
  });
});
