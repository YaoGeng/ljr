/**
 * rule_definitions 发布状态机（H7 §2 变更流：DRAFT→PUBLISHED→EFFECTIVE + DRAFT→ABANDONED 废弃终态）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：三条边全部经 infrastructure/state-machine 守卫迁移并落
 * state_transition_log（entity_type='rule_definition'）。边与机制 API 一一对应：
 *   DRAFT→PUBLISHED      提交公示（同事务注册 RULE_EFFECTIVE job + RulePublished 事件，R-01）
 *   PUBLISHED→EFFECTIVE  公示期满（RULE_EFFECTIVE 执行器回查后迁移，recheck 锚点=publish_status
 *                        + effective_at 窗口；I2 catalog「RULE_EFFECTIVE 执行器=H7」的消费面）
 *   DRAFT→ABANDONED      废弃草案（控制者裁决加的终态：留痕优于删行，电商法 §34 变更历史可查；
 *                        PUBLISHED 后不可废弃——只能被新版本取代，故无 PUBLISHED 出边）
 * EFFECTIVE/ABANDONED 为终态无出边。
 *
 * §9 明文（AI 开发标准）：禁止规则未公示直接 EFFECTIVE——状态机无 DRAFT→EFFECTIVE 边，
 * 守卫必然拒绝并留痕。唯一例外=R-03 词库免公示通道（创建即 EFFECTIVE 的 INSERT 非迁移，
 * 同口径于 demo/notify「创建态无需守卫」先例；绕过公示是 R-03 语义使然，以 state_transition_log
 * 显式审计行留痕，仅限内部机制调用、不暴露 HTTP）。
 *
 * 创建（INSERT status='DRAFT'）非迁移，无需守卫（demo/notify/slot-lock 同口径）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';
import type { RulePublishStatus } from './rule-center.types';

export const RULE_PUBLISH_MACHINE = createStateMachine<RulePublishStatus>({
  entityType: 'rule_definition',
  states: ['DRAFT', 'PUBLISHED', 'EFFECTIVE', 'ABANDONED'],
  transitions: [
    { from: 'DRAFT', to: 'PUBLISHED' }, // 提交公示
    { from: 'PUBLISHED', to: 'EFFECTIVE' }, // 公示期满（RULE_EFFECTIVE）
    { from: 'DRAFT', to: 'ABANDONED' }, // 废弃草案
  ],
});
