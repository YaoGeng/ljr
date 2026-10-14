/**
 * E3 领域事件——KnowledgeUpdated（§6：{specialty} 逐字，→E1 检索缓存失效；additive 定位字段
 * doc_id/reason 报告明示）。
 *
 * 产出时机=检索池实际变化的事务：文档处理完成转 READY（reason='ready'）、禁用/恢复
 * （reason='disabled'/'enabled'）。FAILED 不出事件（检索池未变化）。
 *
 * ⚠消费对接位（E1 缓存失效）：W1 检索 API 无缓存（直查），「缓存失效」验收以事件出箱断言
 * 承载；E1 侧缓存随 M2-W3 管线接线后消费本事件刷新。
 */

export const KNOWLEDGE_UPDATED_TOPIC = 'agent_assist.knowledge.updated';

/** reason=检索池变化的触发语义（additive；小写事件词汇，process_status 大写是列值口径） */
export type KnowledgeChangeReason = 'ready' | 'disabled' | 'enabled';

export interface KnowledgeUpdatedPayload {
  readonly specialty: string;
  readonly doc_id: number;
  readonly reason: KnowledgeChangeReason;
}
