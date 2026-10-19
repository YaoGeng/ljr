/**
 * D1 房间状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经 StateTransitionGuardService
 * 守卫并落 state_transition_log（entity_type='room'，拒绝留痕走独立连接）。
 *
 * 迁移矩阵（D1 §4 + M2-W1 T1 简报）：
 *   - OPEN→IN_SERVICE：grace_end + D3 判定有人（§4 主链；**生产者=D3/W2**，本批只声明迁移
 *     不接线生产者——session.machine CANCELLED 先例同款，词汇保留位）；
 *   - OPEN→CLOSED / IN_SERVICE→CLOSED：close API（§5 job/律师端结束关闭；§5 唯一错误码
 *     409 NOT_OPEN=已终态——OPEN/IN_SERVICE 皆为合法关闭源态）；
 *   - OPEN→CANCELLED：全员缺席平台取消（判定=D3/W2，NO_SHOW_CLOSE 生产者后置）；
 *     **开房失败行以 CANCELLED 直插=初始态承载**（同 trade sessions INSERT 'CREATED' 先例，
 *     INSERT 非迁移，open_fail_reason 携带失败因）；
 *   - IN_SERVICE→CANCELLED（M2-W2 T3，D4）：场次被取消时进行中房间的终止边——律师 <24h
 *     审批后置通过（SLA 48h 软窗可越开房时刻）等迟到取消场景；不走 CLOSED（close 出箱会
 *     驱动 F3 结算链——取消场次走退款轨道，禁双轨）。
 *
 * 终态集：CLOSED / CANCELLED（无出边——重复 close 409 的机器面依据）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';
import type { RoomStatus } from './room.types';

/** 终态集：房间生命周期收敛（重复 close/取消后不再迁移） */
export const ROOM_TERMINAL_STATUSES = [
  'CLOSED',
  'CANCELLED',
] as const satisfies readonly RoomStatus[];

export const ROOM_MACHINE = createStateMachine<RoomStatus>({
  entityType: 'room',
  states: ['OPEN', 'IN_SERVICE', 'CLOSED', 'CANCELLED'],
  transitions: [
    { from: 'OPEN', to: 'IN_SERVICE' },
    { from: 'OPEN', to: 'CLOSED' },
    { from: 'OPEN', to: 'CANCELLED' },
    { from: 'IN_SERVICE', to: 'CLOSED' },
    { from: 'IN_SERVICE', to: 'CANCELLED' }, // M2-W2 T3 D4：迟到取消的进行中房间终止边
  ],
});
