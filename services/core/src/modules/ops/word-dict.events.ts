/**
 * H5 词库切片领域事件（H5 §6：DictionaryUpdated）。
 *
 * topic 沿 H7 'ops.rule.published' 同款点分惯例。经 recordOutbox 与「词库新版本写入（H7
 * 免公示通道 createLexiconVersion）」同事务（§6；业务回滚则事件不出）。
 *
 * ⚠消费对接位（D5/E1 缓存刷新）：本进程内词库自动机由版本号比对即时失效（putDictionary
 * 写路径主动重建）；跨进程消费者（多实例 D5/E1）依赖本事件刷新——M2 对接（外部对接后置约定）。
 *
 * ⚠M2 后置位（H5 §2/§4/§6 明文，本批不建机制）：MQ 二次模型复核（消费 MessageSent → 命中
 * 补拦截+工单）与 RiskBlocked{message_id, hits} 生产（→H3 工单/G1 规则）——依赖 D5 消息链路
 * 与 H3，随 M2-W2 人审闭环批次落位；此处仅留事件注释位，不注册消费、不产出事件。
 */
import type { DictType } from './word-dict.types';

export const DICTIONARY_UPDATED_TOPIC = 'ops.risk.dictionary.updated';

/**
 * DictionaryUpdated（§6 载荷要求字段=rule_version 逐字；其余为 additive 消费便利，报告明示）：
 * rule_key=wordlist.<dict_type>；rule_version=新生效版本号；effective_at 为 ISO 8601 出站口径。
 */
export interface DictionaryUpdatedPayload {
  readonly rule_key: string;
  readonly rule_version: number;
  readonly dict_type: DictType;
  readonly effective_at: string;
}
