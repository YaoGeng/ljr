/**
 * F1 状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经 StateTransitionGuardService
 * 守卫并落 state_transition_log（拒绝留痕走独立连接）。
 *
 * 迁移矩阵裁量（F1 §3 只给状态全集，矩阵为本模块定义，Task 1 简报「迁移矩阵你定义并全用例钉住」，
 * payment.machine.spec.ts 全量钉住）——对齐架构 §4.4 资金流合规红线：
 *   - CREATED→FROZEN：支付成功（PAY_SUCCESS 回调推进），资金冻结托管；
 *   - CREATED→CLOSED：未支付关单；
 *   - FROZEN→PAID：业务确认（成团/接单确认，Core 指令；成团时仅续冻不释放——本表不表达通道
 *     侧续冻，refreeze 是通道原语非状态迁移）；
 *   - FROZEN→REFUNDING / PAID→REFUNDING：退款指令下发（§5 POST /pay/refund；退款失败重试停留
 *     REFUNDING，无 REFUNDING→PAID 出边）；
 *   - PAID→SPLIT：解冻分账——唯一解冻节点（HOLD 结束后，架构 §4.4 合规 R1）；FROZEN→SPLIT
 *     禁止（未确认支付不得分账）；
 *   - REFUNDING→REFUNDED：退款完成（REFUND_SUCCESS 回调推进）；
 *   - REFUNDED→REFUNDING：多次部分退款（R-03）；REFUNDED→CLOSED：退款关单；
 *   - SPLIT→CLOSED：分账完成归档；SPLIT 后退款不可达（分账后无法追回）；
 *   - CLOSED 唯一终态无出边。
 *
 * inbox（entity_type='payment_inbox'）：RECEIVED→CONSUMED（消费成功）/ RECEIVED→DEAD（非法
 * 推进被守卫拒→死信+告警位，H3 工单 M2 接线）；CONSUMED/DEAD 无出边（死信复活走人工面，不在本批）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type PaymentOrderStatus =
  | 'CREATED'
  | 'FROZEN'
  | 'PAID'
  | 'REFUNDING'
  | 'REFUNDED'
  | 'SPLIT'
  | 'CLOSED';

export type PaymentInboxStatus = 'RECEIVED' | 'CONSUMED' | 'DEAD';

export const PAYMENT_ORDER_MACHINE = createStateMachine<PaymentOrderStatus>({
  entityType: 'payment_order',
  states: ['CREATED', 'FROZEN', 'PAID', 'REFUNDING', 'REFUNDED', 'SPLIT', 'CLOSED'],
  transitions: [
    { from: 'CREATED', to: 'FROZEN' },
    { from: 'CREATED', to: 'CLOSED' },
    { from: 'FROZEN', to: 'PAID' },
    { from: 'FROZEN', to: 'REFUNDING' },
    { from: 'PAID', to: 'REFUNDING' },
    { from: 'PAID', to: 'SPLIT' },
    { from: 'REFUNDING', to: 'REFUNDED' },
    { from: 'REFUNDED', to: 'REFUNDING' },
    { from: 'REFUNDED', to: 'CLOSED' },
    { from: 'SPLIT', to: 'CLOSED' },
  ],
});

export const PAYMENT_INBOX_MACHINE = createStateMachine<PaymentInboxStatus>({
  entityType: 'payment_inbox',
  states: ['RECEIVED', 'CONSUMED', 'DEAD'],
  transitions: [
    { from: 'RECEIVED', to: 'CONSUMED' },
    { from: 'RECEIVED', to: 'DEAD' },
  ],
});
