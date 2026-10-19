/**
 * tickets 状态机（H3 §3/§4：OPEN→PROCESSING→RESOLVED/REJECTED）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：全部边经 infrastructure/state-machine 守卫迁移并落
 * state_transition_log（entity_type='ticket'）。边语义：
 *   OPEN→PROCESSING        认领处理（resolve 复合动作的前半——处置人接管工单，
 *                          assignee_id 空则回填 operator；建单 INSERT status='OPEN'
 *                          非迁移无需守卫，demo/notify/rule-center 同口径）
 *   PROCESSING→RESOLVED    处置通过（approved=true；§1 只透传决策，回调发起方=callbacks）
 *   PROCESSING→REJECTED    处置驳回（approved=false）
 * RESOLVED/REJECTED 为终态无出边——再处置由服务层 409 CLOSED 幂等短路（§5）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';
import type { TicketStatus } from './ticket.types';

export const TICKET_MACHINE = createStateMachine<TicketStatus>({
  entityType: 'ticket',
  states: ['OPEN', 'PROCESSING', 'RESOLVED', 'REJECTED'],
  transitions: [
    { from: 'OPEN', to: 'PROCESSING' }, // 认领处理
    { from: 'PROCESSING', to: 'RESOLVED' }, // 处置通过
    { from: 'PROCESSING', to: 'REJECTED' }, // 处置驳回
  ],
});
