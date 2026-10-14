/**
 * E1 实时脱敏层（M1-W1 Task 7）：正则规则集 + 可测试替换管线 + 命中审计。
 * 施工规格：docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md（§4 脱敏段 / §7 R-02 / §8 / §10①）；
 * 只写 agent_assist.* 表（V10 sanitize_audit；边界纪律）。
 *
 * 与同目录先例（specialty/knowledge 两前缀，E3）的目录前缀约定一致：Task 7 面=sanitize 前缀。
 * ⚠M2-W3：草稿管线（MQ 消费→意图→RAG→LLM→气泡）在同目录落位并消费 SanitizeService；
 * 敏感话术硬拦词集经 H5 WordDictService.currentBlockWords（Task 5 已留消费位）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { ObservabilityModule } from '../../observability/observability.module';
import { SanitizeService } from './sanitize.service';

@Module({
  // InfrastructureModule：PgPoolService（sanitize_audit 命中审计写）；ObservabilityModule（@Global）：
  // TRACE_LOGGER（审计旁路 warn）——显式 import 使本模块独立装配（模块级测试）也自洽；
  // AppModule 已 import，进程内 dedupe 为同一实例
  imports: [InfrastructureModule, ObservabilityModule],
  providers: [SanitizeService],
  exports: [
    SanitizeService, // M2 草稿管线消费口：sanitize({text}) → {sanitized, placeholders, hits, ...}
  ],
})
export class SanitizeModule {}
