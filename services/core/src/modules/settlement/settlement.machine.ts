/**
 * F3 settlement 状态机（§4；架构 §1.3「状态字段禁裸写」执行层）——迁移矩阵全用例钉住于
 * settlement.machine.spec.ts。全部迁移经 StateTransitionGuardService 守卫并落
 * state_transition_log（entity_type='settlement'，拒绝留痕走独立连接）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type SettlementStatus = 'PENDING' | 'HOLD' | 'READY' | 'SETTLED' | 'SUSPENDED';

export const SETTLEMENT_MACHINE = createStateMachine<SettlementStatus>({
  entityType: 'settlement',
  states: ['PENDING', 'HOLD', 'READY', 'SETTLED', 'SUSPENDED'],
  transitions: [
    { from: 'PENDING', to: 'HOLD' }, // 进入 24h 冻结期（R-02；hold_reason=HOLD_24H）
    { from: 'HOLD', to: 'READY' }, // 释放：24h 到期 / 工单关闭（R-02）
    { from: 'READY', to: 'SETTLED' }, // 唯一解冻分账节点（R-01 硬规则）
    { from: 'HOLD', to: 'SUSPENDED' }, // 进件非 ACTIVE 挂起（R-07）
    { from: 'READY', to: 'SUSPENDED' }, // 进件非 ACTIVE 挂起（R-07；含 SETTLED 前置断言失败）
    { from: 'SUSPENDED', to: 'READY' }, // 进件恢复且释放条件已满足 → 重驱动
    { from: 'SUSPENDED', to: 'HOLD' }, // 进件恢复但冻结期未满/工单未闭 → 回冻结期
  ],
});
