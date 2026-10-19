/**
 * C5 改期请求状态机（M2-W2 T5；§3 词汇 PENDING|CONFIRMED|FAILED|EXPIRED|CANCELLED 逐字）：
 * 全部迁移经 StateTransitionGuardService 守卫并落 state_transition_log
 * （entity_type='reschedule_request'，拒绝留痕走独立连接）。矩阵语义见 spec 头注——
 * 四条合法迁移全部自 PENDING 出发（申请即插行），四终态无出边（重开申请=新请求行）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type RescheduleStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export const RESCHEDULE_MACHINE = createStateMachine<RescheduleStatus>({
  entityType: 'reschedule_request',
  states: ['PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'],
  transitions: [
    { from: 'PENDING', to: 'CONFIRMED' }, // 律师确认（§4 确认事务）
    { from: 'PENDING', to: 'FAILED' }, // 确认时空位守卫失败（409 NO_SEAT 路径）
    { from: 'PENDING', to: 'EXPIRED' }, // 12h 超时回退（R-04 原报名不动）
    { from: 'PENDING', to: 'CANCELLED' }, // 用户撤回（确认前，§2）
  ],
});
