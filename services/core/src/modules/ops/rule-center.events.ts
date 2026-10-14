/**
 * H7 领域事件（H7 §6 具名清单：RulePublished）。
 *
 * topic 前缀对齐 schema 名 + 实体 + 动词惯例（I2 'schedule.job.fired' / B2 'schedule.slot.*' 同款）。
 * 经 recordOutbox 与「DRAFT→PUBLISHED 迁移 + RULE_EFFECTIVE job 注册」同事务（业务回滚则事件不出）。
 *
 * ⚠消费对接位（I1 公示通知）：RulePublished 是广播型事件（无 user_id，与 I1 §5 DISPATCH_NOTIFY
 * 的单用户载荷契约不同型）——I1 消费管线已就位但本事件 topic 未注册（注册即进重试轨道/死信，
 * 误投递面为零）；「公示通知 fan-out 到关注用户」的载荷适配属 I1 侧联调项（W2+ 批次），
 * 本模块只保证事件同事务出箱（控制者裁决口径）。其余消费方：D5 须知刷新、各消费方缓存失效。
 */

export const RULE_PUBLISHED_TOPIC = 'ops.rule.published';

/** RulePublished{rule_key, version, effective_at}（§6 载荷逐字；effective_at 为 ISO 8601 出站口径） */
export interface RulePublishedPayload {
  readonly rule_key: string;
  readonly version: number;
  readonly effective_at: string;
}
