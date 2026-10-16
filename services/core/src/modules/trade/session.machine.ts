/**
 * C1 B2C 场次状态机（架构 §1.3「状态字段禁裸写」执行层）：全部迁移经 StateTransitionGuardService
 * 守卫并落 state_transition_log（entity_type='session'，拒绝留痕走独立连接）。
 *
 * 迁移矩阵（C1 §4 + Task 4 简报逐字，全用例钉住=session.machine.spec）：
 *   - CREATED→FULL：R-02 满员即成团——C3 成团守卫路径（T7 接线，C1 侧 markFull 消费位预留）；
 *   - FULL→CONFIRMED→OPEN→IN_SERVICE→FINISHED→HOLD→SETTLED：主链，D 域（开房/宽限/结算）
 *     与 F3（HOLD→SETTLED）推进，本批声明词汇、生产者随 M2 落位；
 *   - CREATED→FAILED：R-03 截止未满流标——仅 ENROLL_DEADLINE 截止 job 判定（本模块执行器），
 *     同事务释放占用锁（架构 §4.2）并出箱 SessionFailed；
 *   - CANCELLED：简报裁决「词汇保留不接线」——D4=M2 决定受限入边（§4「任意（受限）」的
 *     具体源态集是 D4 规则的一部分），本批不声明任何入边、无生产者。
 *
 * 终态集（B2 reaper TerminalStateProvider 同口径，「该 session 不再需要占用锁」）：
 *   FAILED / CANCELLED / FINISHED / SETTLED。
 *
 * 文档 §4 的 FAILED→REFUNDED / CANCELLED→REFUNDED 不落本机：REFUNDED 是退款指令域语义
 * （F2/payment 侧台账），非场次状态——简报状态机清单未含 REFUNDED，偏差在任务报告注明。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type SessionStatus =
  | 'CREATED'
  | 'FULL'
  | 'CONFIRMED'
  | 'OPEN'
  | 'IN_SERVICE'
  | 'FINISHED'
  | 'HOLD'
  | 'SETTLED'
  | 'FAILED'
  | 'CANCELLED';

/** 终态集：该 session 不再需要占用锁（B2 reaper isTerminalBatch 同口径，C1 §10 定义） */
export const SESSION_TERMINAL_STATUSES = [
  'FAILED',
  'CANCELLED',
  'FINISHED',
  'SETTLED',
] as const satisfies readonly SessionStatus[];

export const SESSION_MACHINE = createStateMachine<SessionStatus>({
  entityType: 'session',
  states: [
    'CREATED',
    'FULL',
    'CONFIRMED',
    'OPEN',
    'IN_SERVICE',
    'FINISHED',
    'HOLD',
    'SETTLED',
    'FAILED',
    'CANCELLED',
  ],
  transitions: [
    { from: 'CREATED', to: 'FULL' },
    { from: 'FULL', to: 'CONFIRMED' },
    { from: 'CONFIRMED', to: 'OPEN' },
    { from: 'OPEN', to: 'IN_SERVICE' },
    { from: 'IN_SERVICE', to: 'FINISHED' },
    { from: 'FINISHED', to: 'HOLD' },
    { from: 'HOLD', to: 'SETTLED' },
    { from: 'CREATED', to: 'FAILED' },
  ],
});
