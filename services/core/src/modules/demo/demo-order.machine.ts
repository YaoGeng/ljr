/**
 * demo 订单状态机（M0-4 验收脚手架）：一张表两态 DRAFT → DONE。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type DemoOrderStatus = 'DRAFT' | 'DONE';

export const DEMO_ORDER_MACHINE = createStateMachine<DemoOrderStatus>({
  entityType: 'demo_order',
  states: ['DRAFT', 'DONE'],
  transitions: [{ from: 'DRAFT', to: 'DONE' }],
});
