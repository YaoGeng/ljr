/**
 * E1 Agent 草稿气泡管线（M2-W3 T4）：管线（脱敏→硬拦→意图→RAG→mock LLM→气泡）+ 律师三
 * 动作 + MessageSent 消费。施工规格：docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md（§1-§10）；
 * 只写 agent_assist.* 表（V48 drafts/agent_review_logs；边界纪律）。
 *
 * 目录前缀约定（sanitize/knowledge/specialty 先例一致）：Task 4 面=draft- 与 llm- 前缀
 *（状态机/类型/服务/消费端/HTTP 面/夹具；llm.adapter=供应商隔离位）。
 *
 * 跨域装配（A.4 导出面清单；禁跨 schema 直读写——check-schema-refs 0 为门）：
 *   FulfillmentModule（D5 导出面：ConversationService.readMessageForAgent=消息回查唯一入口 +
 *     sendMessage=R-01 发送唯一路径 + ConversationHub=publishTo 气泡帧（W3-6 本批新增导出））；
 *   WordDictModule（H5：currentBlockWords('legal_industry') 硬拦词集）；
 *   SpecialtyKnowledgeModule（E3：KnowledgeService.retrieve=RAG；SpecialtyConfigService=意图段
 *     问题树版本锚）+ SanitizeModule（E1 既有：SanitizeService 脱敏）；
 *   IdentityAuthModule（叶子：HTTP 面 JWT/角色守卫件）。
 *
 * ⚠W3-3/D11：LLM_ADAPTER 缺省=MockLlmAdapter（零网络确定性模板）；境内真供应商 DPA 签署后
 * 换装=本模块工厂单点替换（禁境外 SDK——R-07）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { ObservabilityModule } from '../../observability/observability.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { WordDictModule } from '../ops/word-dict.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { DraftConsumer } from './draft.consumer';
import { DraftController } from './draft.controller';
import { DraftService } from './draft.service';
import { SanitizeModule } from './sanitize.module';
import { SpecialtyKnowledgeModule } from './specialty.module';
import { LLM_ADAPTER, llmAdapterFactory } from './llm.adapter';

@Module({
  // InfrastructureModule：PgPoolService/OutboxService（drafts/审查日志写+两事件出箱）/守卫；
  // ObservabilityModule（@Global）：TRACE_LOGGER（降级 warn）——显式 import 使本模块独立装配
  //（模块级测试）也自洽；AppModule 已 import，进程内 dedupe 为同一实例
  imports: [
    InfrastructureModule,
    ObservabilityModule,
    FulfillmentModule,
    WordDictModule,
    SpecialtyKnowledgeModule,
    SanitizeModule,
    IdentityAuthModule,
  ],
  controllers: [DraftController],
  providers: [
    // LLM 供应商位 ⚠（W3-3/D11）：缺省 mock（零网络，env 故障注入键见 llm.adapter）；
    // 境内真供应商 DPA 签署后换装只改本工厂（接口隔离，主流程零改动）
    { provide: LLM_ADAPTER, useFactory: llmAdapterFactory },
    DraftService,
    // MessageSent 消费（onModuleInit 注册 relay handler——同 topic 多 handler 扇出追加）
    DraftConsumer,
  ],
  exports: [DraftService], // 测试/后续 E2 待办消费位复用入口（本批无外部生产消费方）
})
export class DraftModule {}
