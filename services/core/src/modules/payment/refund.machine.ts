/**
 * F2 退款状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经 StateTransitionGuardService
 * 守卫并落 state_transition_log（entity_type='refund'，拒绝留痕走独立连接）。
 *
 * 迁移矩阵裁量（简报「REQUESTED→PROCESSING→DONE/FAILED，全矩阵用例钉住」，
 * refund.machine.spec.ts 全量钉住；同域 F1 payment_order 矩阵同款形态）：
 *   - REQUESTED：受理落单初始态（幂等 claim INSERT 后），尚未进入下发轨道；
 *   - REQUESTED→PROCESSING：首次下发启动（F1 refund 指令面调用；「指令在途」语义含退避
 *     重试——重试不发起新迁移，停留 PROCESSING，同 F1 REFUNDING 口径）；
 *   - PROCESSING→DONE：REFUND_SUCCESS 回调推进（F1 Inbox 事件驱动），落 done_at；
 *   - PROCESSING→FAILED：下发重试耗尽（3 次退避，§4「失败重试 3 次后工单」，RefundFailed 出箱）；
 *   - DONE/FAILED 唯一终态无出边（FAILED 复活=人工/工单面 H3，M2 接线，不在本批）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type RefundStatus = 'REQUESTED' | 'PROCESSING' | 'DONE' | 'FAILED';

export const REFUND_MACHINE = createStateMachine<RefundStatus>({
  entityType: 'refund',
  states: ['REQUESTED', 'PROCESSING', 'DONE', 'FAILED'],
  transitions: [
    { from: 'REQUESTED', to: 'PROCESSING' },
    { from: 'PROCESSING', to: 'DONE' },
    { from: 'PROCESSING', to: 'FAILED' },
  ],
});
