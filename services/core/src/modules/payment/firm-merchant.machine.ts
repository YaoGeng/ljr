/**
 * A3b 状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经 StateTransitionGuardService
 * 守卫并落 state_transition_log（拒绝留痕走独立连接）。
 *
 * firm_merchant（entity_type='firm_merchant'，A3b §4 图逐字）：六态八边，矩阵语义与非法全序对
 * 穷举断言见 firm-merchant.machine.spec.ts。要点：
 *   - ACTIVE→CHANGING：对公账户变更发起（R-02）；R-W3-C2 裁决=进入 CHANGING 即分账暂停语义
 *     （F3 查询态 CHANGING 与 SUSPENDED 同拒），FirmMerchantSuspended(ACCOUNT_CHANGING) 由
 *     服务层同事务出箱（状态机只管迁移合法性，事件面在服务层）；
 *   - →ACTIVE 三入边（首次生效/变更完成/复验恢复）同「生效」口径：服务层刷新 verified_at/
 *     reverify_due + 注册 FIRM_REVERIFY job + FirmMerchantActivated 出箱；
 *   - SUSPENDED→ACTIVE：复验/变更完成（复验经 POST reverify 端点）；ACTIVE→SUSPENDED：
 *     R-03 复验到期未复验（FIRM_REVERIFY 执行器）；CHANGING→SUSPENDED：变更流程转暂停；
 *   - STOPPED 唯一终态无出边（复开通=重新进件，唯一约束 (firm_id,channel) 下须走新迁移扩边，
 *     本批不发明）；SUBMITTING/IN_REVIEW 无跳变出边（未受理不得生效/暂停/停用）。
 *
 * lawyer_deposit（entity_type='lawyer_deposit'）：保证金冻结指令两态 ISSUED→FROZEN（指令下发→
 * 通道确认；mock 同步确认恒当场 FROZEN，ISSUED 承载崩溃窗口/真实异步通道）。FROZEN 无出边
 * （释放/扣减划转是 F3 处置词汇，落位时走新迁移扩边，本批不发明）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type FirmMerchantStatus =
  'SUBMITTING' | 'IN_REVIEW' | 'ACTIVE' | 'CHANGING' | 'SUSPENDED' | 'STOPPED';

export type LawyerDepositStatus = 'ISSUED' | 'FROZEN';

export const FIRM_MERCHANT_MACHINE = createStateMachine<FirmMerchantStatus>({
  entityType: 'firm_merchant',
  states: ['SUBMITTING', 'IN_REVIEW', 'ACTIVE', 'CHANGING', 'SUSPENDED', 'STOPPED'],
  transitions: [
    { from: 'SUBMITTING', to: 'IN_REVIEW' },
    { from: 'IN_REVIEW', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'CHANGING' },
    { from: 'CHANGING', to: 'ACTIVE' },
    { from: 'CHANGING', to: 'SUSPENDED' },
    { from: 'ACTIVE', to: 'SUSPENDED' },
    { from: 'ACTIVE', to: 'STOPPED' },
    { from: 'SUSPENDED', to: 'ACTIVE' },
  ],
});

export const LAWYER_DEPOSIT_MACHINE = createStateMachine<LawyerDepositStatus>({
  entityType: 'lawyer_deposit',
  states: ['ISSUED', 'FROZEN'],
  transitions: [{ from: 'ISSUED', to: 'FROZEN' }],
});
