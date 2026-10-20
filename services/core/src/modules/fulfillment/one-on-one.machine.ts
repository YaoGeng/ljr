/**
 * D6 1对1 订单状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经 StateTransitionGuardService
 * 守卫并落 state_transition_log（entity_type='one_on_one_order'，拒绝留痕走独立连接）。
 *
 * 迁移矩阵（§4 逐边 + M2-W3 执行计划 T2 行冻结口径）：
 *   主链：CREATED→PAID（预付回调；同事务写 accept_deadline=paid_at+N+OneOnOnePaid 出箱+
 *     OOO_ACCEPT_TIMEOUT 预写）→ACCEPTED（律师接单，超时 409 TIMEOUT）→IN_SERVICE（W3-8 锚：
 *     text=accept 后首条用户消息/voice-video=首次时长回调，落 started_at）→FINISHED（finish，
 *     落 finished_at+settle_deadline+OOO_SETTLE_DEFAULT 预写）→SETTLING（首方实结确认）→SETTLED
 *     （双方一致/30min 默认；OneOnOneSettled 出箱）；
 *   实结分支：SETTLING→REFUND_PARTIAL（多退：F2 SETTLE_REFUND 指令受理先行）→SETTLED；
 *     SETTLING→DIFF_PENDING（少补：F1 补差单+OneOnOneDiffPending 出箱+DIFF_PAY_TIMEOUT 预写）
 *     →SETTLED（补差支付回调收敛，或 15min 未付 executor 按已服务比例结算 settle=prepaid）；
 *   超时：PAID→LAWYER_TIMEOUT（paid_at+N 未接单，executor；OneOnOneLawyerTimeout 出箱）→
 *     REFUNDED（F2 全退 RefundCompleted 收敛）；
 *   取消三档（R-03）：PAID/ACCEPTED→CANCELLED（①全退）→REFUNDED；IN_SERVICE→CANCELLED
 *     （②text 按轮实结退差/③voice-video 未满 1 单位收 50% 退其余）→PARTIAL_REFUNDED
 *     （零退款形态亦走本边——cancel 无补差出边，少补侧按 prepaid 封顶，服务面注记）。
 *
 * 终态集：SETTLED / LAWYER_TIMEOUT / REFUNDED / CANCELLED / PARTIAL_REFUNDED（LAWYER_TIMEOUT/
 * CANCELLED 为退款在途的过渡终态语义——REFUNDED 收敛边在，出边至 REFUNDED/PARTIAL_REFUNDED）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';
import type { OneOnOneStatus } from './one-on-one.types';

/** 终态词汇（退款收敛半边的过渡终态见类注；本表=无后续业务出边的收敛位） */
export const ONE_ON_ONE_MACHINE_TERMINAL_STATUSES = [
  'SETTLED',
  'LAWYER_TIMEOUT',
  'REFUNDED',
  'CANCELLED',
  'PARTIAL_REFUNDED',
] as const satisfies readonly OneOnOneStatus[];

export const ONE_ON_ONE_MACHINE = createStateMachine<OneOnOneStatus>({
  entityType: 'one_on_one_order',
  states: [
    'CREATED',
    'PAID',
    'ACCEPTED',
    'IN_SERVICE',
    'FINISHED',
    'SETTLING',
    'SETTLED',
    'LAWYER_TIMEOUT',
    'REFUNDED',
    'CANCELLED',
    'PARTIAL_REFUNDED',
    'REFUND_PARTIAL',
    'DIFF_PENDING',
  ],
  transitions: [
    // ---- 主链（§4 首行逐边） ----
    { from: 'CREATED', to: 'PAID' },
    { from: 'PAID', to: 'ACCEPTED' },
    { from: 'ACCEPTED', to: 'IN_SERVICE' },
    { from: 'IN_SERVICE', to: 'FINISHED' },
    { from: 'FINISHED', to: 'SETTLING' },
    { from: 'SETTLING', to: 'SETTLED' },
    // ---- 实结分支（多退/少补） ----
    { from: 'SETTLING', to: 'REFUND_PARTIAL' },
    { from: 'REFUND_PARTIAL', to: 'SETTLED' },
    { from: 'SETTLING', to: 'DIFF_PENDING' },
    { from: 'DIFF_PENDING', to: 'SETTLED' },
    // ---- 接单超时（executor → F2 全退 → 收敛） ----
    { from: 'PAID', to: 'LAWYER_TIMEOUT' },
    { from: 'LAWYER_TIMEOUT', to: 'REFUNDED' },
    // ---- 取消三档（R-03：①IN_SERVICE 前全退；②③开始后） ----
    { from: 'PAID', to: 'CANCELLED' },
    { from: 'ACCEPTED', to: 'CANCELLED' },
    { from: 'IN_SERVICE', to: 'CANCELLED' },
    { from: 'CANCELLED', to: 'REFUNDED' },
    { from: 'CANCELLED', to: 'PARTIAL_REFUNDED' },
  ],
});
