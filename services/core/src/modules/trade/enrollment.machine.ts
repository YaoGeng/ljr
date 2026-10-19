/**
 * C3 报名 pay_status 状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经
 * StateTransitionGuardService 守卫并落 state_transition_log（entity_type='enrollment'，
 * 拒绝留痕走独立连接）。
 *
 * 迁移矩阵（C3 §3 词汇 PENDING|PAID|REFUNDED 三态逐字 + M2-W2 T4 增态，enrollment.machine.spec
 * 全量钉住）：
 *   - PENDING：报名下单初始态（下单事务即插行：快照价+积分冻结+F1 单同事务，§5）；
 *   - PENDING→PAID：支付成功回调——成团原子守卫事务内推进（§4/§9 顺序铁律：先席位计数
 *     UPDATE、后报名 PAID，顺序反=超卖）；
 *   - PENDING→REFUNDED：满员/终态自动退款分支（回调遇 FULL/FAILED/EXPIRED 等，R-01
 *     「未成团自动退款」；F2 受理在前后、本迁移+F4 解冻同事务终态化）；
 *   - PAID→REFUNDED：退款完成收敛（RefundCompleted 消费——流标批量退款/部分退款完成）；
 *   - REFUNDED 终态无出边：终态后重报同场次=新行（ux_enroll_active 部分唯一索引保证，
 *     §10 验收项）。无 CANCELLED/EXPIRED 态——R-W3-O 裁决（流标未付清场保持 PENDING
 *     +F4 解冻，晚到回调经自动退款分支 PENDING→REFUNDED，任务报告注明）。
 *   - PAID→CONVERTED_OUT（M2-W2 T4，C4 §3）：律师确认/认领转化的参与者迁移出标记——迁移
 *     事务=旧行置 CONVERTED_OUT + 新建 session 型行（prev_enrollment_id 回链+快照复制）；
 *     审计链铁律=迁移靠新建行承载，旧行仅 pay_status 位翻转（ref_type/ref_id/快照列禁
 *     UPDATE）。CONVERTED_OUT 机终态无出边：原单退款完成（如 24h 转化窗退款）的收敛走
 *     后继行（enrollment.service advanceToRefunded 迁移链重定向），旧行不复活。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type EnrollmentPayStatus = 'PENDING' | 'PAID' | 'REFUNDED' | 'CONVERTED_OUT';

export const ENROLLMENT_MACHINE = createStateMachine<EnrollmentPayStatus>({
  entityType: 'enrollment',
  states: ['PENDING', 'PAID', 'REFUNDED', 'CONVERTED_OUT'],
  transitions: [
    { from: 'PENDING', to: 'PAID' },
    { from: 'PENDING', to: 'REFUNDED' },
    { from: 'PAID', to: 'REFUNDED' },
    { from: 'PAID', to: 'CONVERTED_OUT' }, // M2-W2 T4：C4 迁移出标记（头注）
  ],
});
