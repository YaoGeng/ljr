/**
 * 律师资质审核状态机（A3a §4：DRAFT → SUBMITTED → IN_REVIEW → PASSED｜REJECTED；
 * PASSED→SUSPENDED→PASSED；REJECTED 重提与 PASSED 后材料修改均回 SUBMITTED）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：迁移全部经 infrastructure/state-machine 守卫并落
 * state_transition_log。DRAFT=lawyer_profiles 无行态（创建行即带 SUBMITTED，consent/realname
 * 同口径）；现行状态事实源=lawyer_profiles.audit_status 列（§3 原文列，非 STL 推导）。
 * entityId=identity.users.id（user_id 唯一，一账号一实体，A2 两状态机同口径）。
 * 迁移矩阵（§4 原文八边）：
 *   - DRAFT→SUBMITTED：提交（建行 v1）
 *   - REJECTED→SUBMITTED：重提（守卫：新材料版本号——material_version 递增且指纹不同）
 *   - PASSED→SUBMITTED：PASSED 后材料修改（守卫同上）
 *   - SUBMITTED→IN_REVIEW：H1 领取
 *   - IN_REVIEW→PASSED｜REJECTED：审核结论（PASSED 同事务发 LawyerAuditPassed）
 *   - PASSED→SUSPENDED：停用（同事务发 LawyerSuspended）
 *   - SUSPENDED→PASSED：恢复
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type LawyerAuditStatus =
  'DRAFT' | 'SUBMITTED' | 'IN_REVIEW' | 'PASSED' | 'REJECTED' | 'SUSPENDED';

export const LAWYER_AUDIT_MACHINE = createStateMachine<LawyerAuditStatus>({
  entityType: 'identity_lawyer_profile',
  states: ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'PASSED', 'REJECTED', 'SUSPENDED'],
  transitions: [
    { from: 'DRAFT', to: 'SUBMITTED' },
    { from: 'REJECTED', to: 'SUBMITTED' },
    { from: 'PASSED', to: 'SUBMITTED' },
    { from: 'SUBMITTED', to: 'IN_REVIEW' },
    { from: 'IN_REVIEW', to: 'PASSED' },
    { from: 'IN_REVIEW', to: 'REJECTED' },
    { from: 'PASSED', to: 'SUSPENDED' },
    { from: 'SUSPENDED', to: 'PASSED' },
  ],
});
