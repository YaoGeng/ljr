/**
 * 实名核验状态机（A2 §4：NONE → PENDING(核验中) → VERIFIED / FAILED(可重提)）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：迁移全部经 infrastructure/state-machine 守卫并落
 * state_transition_log。real_name_infos 无独立状态列（§3 原文列；VERIFIED 的持久化形态=
 * 表行本身），故现行状态推导：行存在→VERIFIED；否则取 STL 该实体最近一次迁移的 to_status
 * （无记录→NONE）。entityId=identity.users.id（real_name_infos.user_id 唯一，一账号一实体）。
 * 迁移矩阵（§4 原文五边，FAILED→PENDING=可重提）：
 *   - NONE→PENDING / FAILED→PENDING：提交实名（重提=FAILED 侧新_submission）
 *   - PENDING→VERIFIED：通道通过（同事务 INSERT real_name_infos + outbox 事件）
 *   - PENDING→FAILED：通道否决（不留行，仅 STL 拒绝/放行留痕；可重提）
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type RealnameStatus = 'NONE' | 'PENDING' | 'VERIFIED' | 'FAILED';

export const REALNAME_MACHINE = createStateMachine<RealnameStatus>({
  entityType: 'identity_realname',
  states: ['NONE', 'PENDING', 'VERIFIED', 'FAILED'],
  transitions: [
    { from: 'NONE', to: 'PENDING' },
    { from: 'FAILED', to: 'PENDING' },
    { from: 'PENDING', to: 'VERIFIED' },
    { from: 'PENDING', to: 'FAILED' },
  ],
});
