import { describe, expect, it } from 'bun:test';
import {
  INITIAL_NAVIGATION_STATE,
  popRoute,
  pushRoute,
  switchTab,
  topRoute,
  type NavigationState,
} from './navigation-state';

describe('导航状态机（评审 I1：推栈下切 tab = pop-to-root）', () => {
  it('stack 打开 → 切 tab → 回根（推栈清空、tab 更新、top 归 null）', () => {
    let s: NavigationState = INITIAL_NAVIGATION_STATE; // tab=home
    s = switchTab(s, 'sessions');
    s = pushRoute(s, { key: 'sessionDetail', params: { from: '场次' } });
    expect(topRoute(s)?.key).toBe('sessionDetail');

    s = switchTab(s, 'messages'); // 推栈在身时切 tab
    expect(s.tab).toBe('messages');
    expect(s.stack).toEqual([]);
    expect(topRoute(s)).toBeNull();
  });

  it('多层推栈逐层 pop，根上 pop 无副作用（原状态引用不变）', () => {
    let s: NavigationState = switchTab(INITIAL_NAVIGATION_STATE, 'home');
    s = pushRoute(s, { key: 'sessionDetail' });
    s = pushRoute(s, { key: 'enroll' });
    expect(topRoute(s)?.key).toBe('enroll');
    s = popRoute(s);
    expect(topRoute(s)?.key).toBe('sessionDetail');
    s = popRoute(s);
    expect(topRoute(s)).toBeNull();
    const atRoot = s;
    expect(popRoute(atRoot)).toBe(atRoot); // 根上 pop 原样返回（不新建状态）
  });

  it('切到当前所在 tab 同样清推栈（幂等回根）', () => {
    let s: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, { key: 'sessionDetail' });
    s = switchTab(s, s.tab); // home → home，仍在推栈页
    expect(s.stack).toEqual([]);
  });
});
