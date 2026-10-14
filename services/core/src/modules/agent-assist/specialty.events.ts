/**
 * E3 领域事件——QuestionTreeUpdated（§6：{specialty, version} 逐字，→C2 引导页刷新）。
 *
 * topic 沿 'ops.rule.published' 同款点分惯例，schema 前缀=agent_assist。经 recordOutbox 与
 * 「配置包写入（specialty_configs 更新）」同事务（§6；业务回滚则事件不出）。
 *
 * ⚠消费对接位（C2）：W1 只生产不消费——C2 引导页消费随 W3 联调接线（外部对接后置约定）；
 * 消费方按 (specialty, version) 刷新本地缓存。
 */
export const QUESTION_TREE_UPDATED_TOPIC = 'agent_assist.specialty.question_tree.updated';

export interface QuestionTreeUpdatedPayload {
  readonly specialty: string;
  readonly version: number;
}
