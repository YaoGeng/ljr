/**
 * 知识文档状态机（E3 §8 process_status：PENDING|READY|FAILED）。
 *
 * 「状态字段禁裸写」（架构 §1.3/§4.1）：process_status 的全部迁移经 infrastructure/state-machine
 * 守卫迁移并落 state_transition_log（终审 Important-1：原先两处条件 UPDATE 直写为全分支唯一旁路）。
 *   - PENDING→READY：ingest 成功（与分块落库/KnowledgeUpdated 同事务留痕）；
 *   - PENDING→FAILED：ingest 失败（独立连接留痕——业务事务已回滚，FAILED 审计不得随之丢失）。
 * 终态 READY/FAILED 无出边（重传同文=幂等回读不重处理）；FAILED→PENDING requeue 边随 M2
 * 重处理位一并补（当前无消费方，不预发边）。
 */
import { createStateMachine } from '../../infrastructure/state-machine/state-machine';

export type KnowledgeDocProcessStatus = 'PENDING' | 'READY' | 'FAILED';

export const KNOWLEDGE_DOC_MACHINE = createStateMachine<KnowledgeDocProcessStatus>({
  entityType: 'knowledge_doc',
  states: ['PENDING', 'READY', 'FAILED'],
  transitions: [
    { from: 'PENDING', to: 'READY' },
    { from: 'PENDING', to: 'FAILED' },
  ],
});
