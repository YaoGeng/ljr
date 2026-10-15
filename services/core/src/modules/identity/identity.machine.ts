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

/** 双角色（R-02：lawyer 账号默认具备 user 身份） */
export type UserRole = 'user' | 'lawyer';

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
