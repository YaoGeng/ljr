/**
 * 用户账号状态机（A1 §2：ACTIVE|BANNED|DELETING）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：迁移全部经 infrastructure/state-machine 守卫并落
 * state_transition_log。创建（INSERT status='ACTIVE'，注册即激活）非迁移，无需守卫（demo/notify 同口径）。
 * 迁移矩阵裁量（§3/§7 未给矩阵，最小闭环）：
 *   - ACTIVE→BANNED / BANNED→ACTIVE：运营封禁/解封（A4=H 域 M4 接线，本批仅消费 BANNED 做登录拒绝）
 *   - ACTIVE→DELETING / BANNED→DELETING：注销执行（A4 AccountDeletionExecuted 事件消费）
 *   - DELETING 为终态无出边（注销完成后的复活/恢复不在 V1 范围）
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type UserStatus = 'ACTIVE' | 'BANNED' | 'DELETING';

/**
 * 角色词汇（R-02 双角色 + ⚠W3-8/G-A 运营旗标）：
 *   user/lawyer=双角色同 App（lawyer 由 A3a 审核事件授予）；
 *   admin=运营权限旗标（DB 级预置进 identity.user_roles，无自助 API——运营台=M3/M4）：
 *   仅作为 claims.roles 成员参与 @RequireRole('admin') 判定（权限旗标语义），不是
 *   switch-role 可切换的「激活角色」（claims.role 词汇仍由 A1 服务层限定 user|lawyer，
 *   admin 不可自铸/自换——防提权）。DB CHECK 枚举放宽=V31（apply 后不可改）。
 */
export type UserRole = 'user' | 'lawyer' | 'admin';

/** claims.role 可取的激活角色词汇（admin 为旗标不入此列，A1 服务层 switch/默认角色用） */
export const ACTIVE_ROLES = ['user', 'lawyer'] as const;
export type ActiveRole = (typeof ACTIVE_ROLES)[number];

export const USER_MACHINE = createStateMachine<UserStatus>({
  entityType: 'identity_user',
  states: ['ACTIVE', 'BANNED', 'DELETING'],
  transitions: [
    { from: 'ACTIVE', to: 'BANNED' },
    { from: 'BANNED', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'DELETING' },
    { from: 'BANNED', to: 'DELETING' },
  ],
});
