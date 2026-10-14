/**
 * slot_locks 状态机（B2 §3/§4：PENDING_PAYMENT|LOCKED|OCCUPIED|RELEASED）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：§4 五条边全部经 infrastructure/state-machine 守卫迁移并落
 * state_transition_log（entity_type='slot_lock'）。边与机制 API 一一对应：
 *   PENDING_PAYMENT→LOCKED     CONFIRM_PAYMENT（支付成功回调，§4）
 *   LOCKED→OCCUPIED            START_OCCUPY（开房，§4）
 *   PENDING_PAYMENT→RELEASED   TTL 到期 / reaper 兜底 / 取消（§4 第二条边）
 *   LOCKED→RELEASED            流标/拒绝/超时/取消，与业务终态同事务（R-02）
 *   OCCUPIED→RELEASED          场次终态（RELEASE_SLOT）
 * RELEASED 为终态无出边（锁不可复活：同段重占走新锁行）；创建（INSERT status=PENDING_PAYMENT|LOCKED）
 * 非迁移，无需守卫（demo/notify 同口径）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';
import type { SlotLockStatus } from './slot-lock.types';

export const SLOT_LOCK_MACHINE = createStateMachine<SlotLockStatus>({
  entityType: 'slot_lock',
  states: ['PENDING_PAYMENT', 'LOCKED', 'OCCUPIED', 'RELEASED'],
  transitions: [
    { from: 'PENDING_PAYMENT', to: 'LOCKED' },
    { from: 'LOCKED', to: 'OCCUPIED' },
    { from: 'PENDING_PAYMENT', to: 'RELEASED' },
    { from: 'LOCKED', to: 'RELEASED' },
    { from: 'OCCUPIED', to: 'RELEASED' },
  ],
});
