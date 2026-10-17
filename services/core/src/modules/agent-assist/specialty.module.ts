/**
 * E3 专项配置与知识库——W1 配置基建切片（M1-W1 Task 6）：专项配置包（问题树/提示词模板/
 * 语料授权登记）+ 知识库存储（上传→分块→向量化→检索机制）+ 管理面/消费面/公开只读接口。
 * 施工规格：docs/modules/E-AI辅助/E3-专项配置与知识库.md；只写 agent_assist.* 表（V9；边界纪律）。
 *
 * 目录前缀约定（控制者裁决授权自定，报告明示）：配置包面=specialty.前缀、知识库面=knowledge.前缀；
 * Task 7 E1 草稿管线同目录追加（文件名前缀由 Task 7 定）。
 *
 * R4 双路径（V9 迁移头注）：knowledge.vector 按列型分派 pgvector/jsonb，本仓 dev=jsonb 兜底 ⚠；
 * embedding 供应商=确定性 mock ⚠（真实境内供应商 D11/M2-W3）；E1 草稿管线（Task 7）消费
 * KnowledgeService.retrieve（§5 检索内部 API，top_k=8 cosine）。
 *
 * ⚠M2 后置位：FAILED requeue/管理列表与删除 REST（W2+）、pdf/docx 解析+I3 引用、C2/E1 事件
 * 消费接线（W3 联调）、多实例换 MQ。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { ObservabilityModule } from '../../observability/observability.module';
import { knowledgeConfig, KNOWLEDGE_CONFIG } from './knowledge.config';
import { EMBEDDING_PROVIDER, mockEmbeddingProviderFactory } from './knowledge.embedding';
import { KnowledgeService } from './knowledge.service';
import { SpecialtyAdminController } from './specialty-admin.controller';
import { SpecialtyPublicController } from './specialty-public.controller';
import { SpecialtyConfigService } from './specialty.service';

@Module({
  // InfrastructureModule：PgPoolService/OutboxService（KnowledgeUpdated/QuestionTreeUpdated 出箱）；
  // ObservabilityModule（@Global）：TRACE_LOGGER（ingest FAILED 的运维侧 warn）——显式 import
  // 使本模块独立装配（模块级测试）也自洽；AppModule 已 import，进程内 dedupe 为同一实例
  // IdentityAuthModule（叶子）：/admin/specialty 管理面的 JWT/角色守卫件（W3 T10 修复轮 G-A 接线）
  imports: [InfrastructureModule, ObservabilityModule, IdentityAuthModule],
  controllers: [SpecialtyAdminController, SpecialtyPublicController],
  providers: [
    // 配置装配（文档口径默认值；W1 不开 env 覆盖）：KnowledgeConfig 是纯 interface，经 Symbol
    // token 工厂注入（RULE_CENTER_CONFIG 同款）；缺此 provider 即启动期 fail-fast
    { provide: KNOWLEDGE_CONFIG, useFactory: () => knowledgeConfig() },
    // embedding 供应商位 ⚠：缺省确定性 mock（零网络）；真实境内供应商适配器 D11/M2-W3 换装
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: mockEmbeddingProviderFactory,
      inject: [KNOWLEDGE_CONFIG],
    },
    SpecialtyConfigService,
    KnowledgeService,
  ],
  exports: [
    SpecialtyConfigService, // C2 问题树（HTTP 公开面）/ E1 提示词（getPrompts 机制面）消费口
    KnowledgeService, // E1 检索内部 API（Task 7 消费 retrieve）；setDocActive 机制面
  ],
})
export class SpecialtyKnowledgeModule {}
