/**
 * C2 C2B 拼团状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经 StateTransitionGuardService
 * 守卫并落 state_transition_log（entity_type='group_buy'，拒绝留痕走独立连接）。
 *
 * 迁移矩阵（C2 §4 + Task 5 简报逐字，全用例钉住=group-buy.machine.spec）：
 *   - PUBLISHED→REACHED→PENDING_LAWYER：R-05 达 sub_min 锁人——C3（T7）消费 EnrollmentPaid 经
 *     GroupBuyService.groupBuyReachedGuard 推进（守卫一次跨两边：REACHED=GroupBuyReached 出箱点+
 *     锁人语义，PENDING_LAWYER=待律师确认 12h 窗口起点/lawyer_confirm_by 落列，STL 双边留痕）；
 *   - PENDING_LAWYER→CONFIRMED：律师确认（C4=M2，确认时生成履约 Session——R-W3-K 经 C1 导出的
 *     创建服务方法落 trade.sessions mode='C2B'）；本批只声明边，无生产者（简报逐字）；
 *   - PUBLISHED→EXPIRED：截止未成流标——仅 ENROLL_DEADLINE 截止 job 判定（本模块执行器），
 *     同事务释放占用锁（架构 §4.2）并出箱 GroupBuyExpired（退款指令面=F2=T6）；
 *   - PENDING_LAWYER→REJECTED：拒绝/超时=自动拒——超时=本模块 C2B_CONFIRM_TIMEOUT 执行器
 *     （via_timeout=true 出箱）；C4 显式拒=M2（via_timeout=false）；
 *   - EXPIRED/REJECTED→REFUNDED：退款完成（F2=T6 推进；本批只声明边）；
 *   - PUBLISHED/REACHED→CONVERTED：C4 认领转化（C4=M2，只声明边）；
 *   - PENDING_LAWYER→CONVERTED：M2-W2 T4 增边（执行计划 T4 行裁定「PENDING_LAWYER 可直接
 *     转化=认领」）：12h 确认窗内的高需求拼团可直接认领转化，不必先确认再处置。C2 §4 文档
 *     原文仅 PUBLISHED/REACHED 两边——本边为文档外受控增量（生产者=GroupBuyResponseService
 *     convert），文档回写随 M2-W2 勾账。
 *
 * 终态两集（口径区分，同 C1 session.machine 先例）：
 *   - 锁终态 GROUP_BUY_TERMINAL_STATUSES（B2 reaper isTerminalBatch 同口径，「该 group_buy 不再
 *     需要占用锁」）：EXPIRED / REJECTED / REFUNDED / CONVERTED——PUBLISHED/REACHED/
 *     PENDING_LAWYER/CONFIRMED 仍需占用段位（EXPIRED/REJECTED 的锁在业务终态迁移同事务释放，
 *     与 C1 FAILED 同口径）；
 *   - 机终态（无出边）：REFUNDED / CONVERTED；EXPIRED/REJECTED 唯一出边 REFUNDED（退款推进期
 *     锁已释放）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type GroupBuyStatus =
  | 'PUBLISHED'
  | 'REACHED'
  | 'PENDING_LAWYER'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'REFUNDED'
  | 'CONVERTED';

/** 锁终态集：该 group_buy 不再需要占用锁（B2 reaper isTerminalBatch 同口径，C2 §4 定义） */
export const GROUP_BUY_TERMINAL_STATUSES = [
  'EXPIRED',
  'REJECTED',
  'REFUNDED',
  'CONVERTED',
] as const satisfies readonly GroupBuyStatus[];

export const GROUP_BUY_MACHINE = createStateMachine<GroupBuyStatus>({
  entityType: 'group_buy',
  states: [
    'PUBLISHED',
    'REACHED',
    'PENDING_LAWYER',
    'CONFIRMED',
    'EXPIRED',
    'REJECTED',
    'REFUNDED',
    'CONVERTED',
  ],
  transitions: [
    { from: 'PUBLISHED', to: 'REACHED' },
    { from: 'REACHED', to: 'PENDING_LAWYER' },
    { from: 'PENDING_LAWYER', to: 'CONFIRMED' },
    { from: 'PUBLISHED', to: 'EXPIRED' },
    { from: 'EXPIRED', to: 'REFUNDED' },
    { from: 'PENDING_LAWYER', to: 'REJECTED' },
    { from: 'REJECTED', to: 'REFUNDED' },
    { from: 'PUBLISHED', to: 'CONVERTED' },
    { from: 'REACHED', to: 'CONVERTED' },
    { from: 'PENDING_LAWYER', to: 'CONVERTED' }, // M2-W2 T4 增边（头注）
  ],
});
