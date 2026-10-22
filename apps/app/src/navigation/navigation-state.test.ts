import { describe, expect, it } from 'bun:test';
import {
  shouldInterceptPop,
  INITIAL_NAVIGATION_STATE,
  applyRole,
  popRoute,
  pushRoute,
  switchTab,
  tabsForRole,
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

describe('防双 push（M3-W2 T1：连点/嵌套同绑 onPress 治本——栈顶已是同 key 同 params 实例则忽略）', () => {
  it('栈顶同 key 同 params 重复 push → 原状态引用返回（栈深不变，一次返回即回根）', () => {
    let s: NavigationState = switchTab(INITIAL_NAVIGATION_STATE, 'home');
    s = pushRoute(s, { key: 'sessionDetail', params: { id: 5 } });
    const depth1 = s;
    const pushed = pushRoute(s, { key: 'sessionDetail', params: { id: 5 } }); // 连点第二次
    expect(pushed).toBe(depth1); // 同引用=零迁移（非新建同形状态）
    expect(pushed.stack).toHaveLength(1);

    s = popRoute(pushed);
    expect(topRoute(s)).toBeNull(); // 一次返回即回根（W1 J2「推栈深度=1」绕过的路由层治本）
  });

  it('同 key 不同 params 放行（评审 I2：场次看板→另一场次详情=合法双实例，key 判重不得封死）', () => {
    let s: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, {
      key: 'sessionDetail',
      params: { id: 5 },
    });
    s = pushRoute(s, { key: 'sessionDetail', params: { id: 9 } });
    expect(s.stack).toHaveLength(2);
    expect(topRoute(s)?.params).toEqual({ id: 9 });
    // 逐层 pop：上层详情仍在（双实例各自可达）
    s = popRoute(s);
    expect(topRoute(s)?.params).toEqual({ id: 5 });
  });

  it('同 key 一方无 params 一方有 params → 视为不同实例放行（params 缺省≠空对象）', () => {
    let s: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, { key: 'sessionDetail' });
    s = pushRoute(s, { key: 'sessionDetail', params: { id: 1 } });
    expect(s.stack).toHaveLength(2);
  });

  it('params 浅比较：同键不同值放行、键集不同放行、键序不同不敏感', () => {
    let s: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, {
      key: 'sessionDetail',
      params: { id: 1, from: 'list' },
    });
    s = pushRoute(s, { key: 'sessionDetail', params: { id: 1, from: 'board' } }); // 值异
    expect(s.stack).toHaveLength(2);

    let t: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, {
      key: 'sessionDetail',
      params: { id: 1 },
    });
    t = pushRoute(t, { key: 'sessionDetail', params: { id: 1, extra: true } }); // 键集异
    expect(t.stack).toHaveLength(2);

    let u: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, {
      key: 'sessionDetail',
      params: { id: 1, from: 'list' },
    });
    u = pushRoute(u, { key: 'sessionDetail', params: { from: 'list', id: 1 } }); // 键序无关
    expect(u.stack).toHaveLength(1);
  });

  it('栈顶异 key 正常生长（防护不误伤正常推栈）', () => {
    let s: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, { key: 'sessionDetail' });
    s = pushRoute(s, { key: 'realname' });
    expect(s.stack).toHaveLength(2);
    expect(topRoute(s)?.key).toBe('realname');
  });

  it('pop 回上层后再 push 同 key 同 params → 仍忽略（旧栈顶判重口径不变）', () => {
    let s: NavigationState = pushRoute(INITIAL_NAVIGATION_STATE, {
      key: 'sessionDetail',
      params: { id: 3 },
    });
    s = pushRoute(s, { key: 'realname' });
    s = popRoute(s); // 回 sessionDetail{id:3}
    s = pushRoute(s, { key: 'sessionDetail', params: { id: 3 } }); // 同 key 同 params → 忽略
    expect(s.stack).toHaveLength(1);
  });
});

describe('role 感知 tab 集（M3-W2 T1：user 五 tab ↔ lawyer 四 tab，对照原型 TABS.lawyer）', () => {
  it('user 五 tab：首页/场次/发团/消息/我的；lawyer 四 tab：工作台/场次管理/接单大厅/我的', () => {
    expect(tabsForRole('user')).toEqual(['home', 'sessions', 'publish', 'messages', 'me']);
    expect(tabsForRole('lawyer')).toEqual([
      'lawyerWork',
      'lawyerSessions',
      'lawyerHall',
      'lawyerMe',
    ]);
  });

  it('初始态 tab=home 属 user 集（登录默认 user 激活角色，A1 R-02/identity defaultRole 同口径）', () => {
    expect(tabsForRole('user')).toContain(INITIAL_NAVIGATION_STATE.tab);
  });
});

describe('applyRole（角色切换的导航收口：非法 tab 回角色首 tab + pop-to-root）', () => {
  it('user → lawyer：当前 tab 非律师集 → 回律师首 tab（工作台）且清推栈', () => {
    let s: NavigationState = switchTab(INITIAL_NAVIGATION_STATE, 'me');
    s = pushRoute(s, { key: 'myEnrollments' });
    const next = applyRole(s, 'lawyer');
    expect(next.tab).toBe('lawyerWork');
    expect(next.stack).toEqual([]);
  });

  it('lawyer → user：律师 tab 不在用户集 → 回用户首 tab（首页）', () => {
    let s: NavigationState = applyRole(INITIAL_NAVIGATION_STATE, 'lawyer');
    s = switchTab(s, 'lawyerHall');
    const next = applyRole(s, 'user');
    expect(next.tab).toBe('home');
    expect(next.stack).toEqual([]);
  });

  it('同角色重放：tab 仍在集内 → 保留 tab 仅清推栈（幂等）', () => {
    let s: NavigationState = switchTab(INITIAL_NAVIGATION_STATE, 'sessions');
    s = pushRoute(s, { key: 'sessionDetail' });
    const next = applyRole(s, 'user');
    expect(next.tab).toBe('sessions');
    expect(next.stack).toEqual([]);
  });

  it('切角色时正在推栈页 → 推栈清空（角色壳不含跨角色推栈残留）', () => {
    let s: NavigationState = applyRole(INITIAL_NAVIGATION_STATE, 'lawyer');
    s = pushRoute(s, { key: 'sessionDetail' }); // 律师壳内也可能推公共栈页
    const next = applyRole(s, 'user');
    expect(next.stack).toEqual([]);
    expect(next.tab).toBe('home');
  });
});

describe('shouldInterceptPop（修复环 I-1：pop 拦截裁决——router.popGuardRef 消费的纯函数面）', () => {
  it('guard=null（未登记）→ 不拦截；guard 返回 true → 拦截；返回 false → 放行', () => {
    expect(shouldInterceptPop(null)).toBe(false);
    expect(shouldInterceptPop(() => true)).toBe(true);
    expect(shouldInterceptPop(() => false)).toBe(false);
  });
});
