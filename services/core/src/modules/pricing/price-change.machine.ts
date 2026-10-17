/**
 * C6 改价历史状态机（评审修复轮 R-W3-Q①，「状态字段禁裸写」执行层）：审批/撤销迁移经
 * StateTransitionGuardService 守卫并落 state_transition_log（entity_type='pricing_history'）。
 *
 * 迁移矩阵（task-9 评审台账 F-2）：
 *   - PENDING_APPROVAL→EFFECTED：人工兜底审批通过（approve(true)；直效档行的 EFFECTED 为
 *     出生态不经迁移——STL 只记迁移，同 trade INSERT CREATED 先例）；
 *   - PENDING_APPROVAL→REJECTED：审批否决（approve(false)）；
 *   - EFFECTED→REVOKED：24h 内撤销（revoked_at 物化标记；DB result 列词汇受 V29 CHECK 限
 *     （EFFECTED|PENDING_APPROVAL|REJECTED），REVOKED 以 revoked_at IS NOT NULL 承载，机器
 *     词汇含 REVOKED 供 STL 留痕——词汇对照关系见本头注，M2 如需 result 列扩值域走新迁移）。
 *
 * 无出边终态：REJECTED / REVOKED；非法迁移（如 REJECTED→EFFECTED、REVOKED→任何）由守卫拒绝
 * 并留 allowed=false 痕（独立连接，不随业务回滚消失）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type PriceHistoryStatus = 'PENDING_APPROVAL' | 'EFFECTED' | 'REJECTED' | 'REVOKED';

export const PRICE_HISTORY_MACHINE = createStateMachine<PriceHistoryStatus>({
  entityType: 'pricing_history',
  states: ['PENDING_APPROVAL', 'EFFECTED', 'REJECTED', 'REVOKED'],
  transitions: [
    { from: 'PENDING_APPROVAL', to: 'EFFECTED' },
    { from: 'PENDING_APPROVAL', to: 'REJECTED' },
    { from: 'EFFECTED', to: 'REVOKED' },
  ],
});
