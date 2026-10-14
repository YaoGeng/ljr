/**
 * H5 风控与敏感词管理——W1 词库切片（M1-W1 Task 5）：双词库管理 + CHECK_RISK 同步判定 +
 * 词库热更新（走 H7 版本化免公示通道）。施工规格：docs/modules/H-运营后台/H5-风控与敏感词管理.md；
 * 只写 ops.* 表（risk_records，V8）；rule_definitions 词库正文经 H7 机制 API 取（不直查）。
 * 人审闭环/二次模型复核/定期巡查=M2-W2（模块/服务头注明示）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { RuleCenterModule } from './rule-center.module';
import { WordAdminController } from './word-admin.controller';
import { WordDictAutomatonCache } from './word-dict.cache';
import { WordDictService } from './word-dict.service';

@Module({
  // InfrastructureModule：PgPoolService/OutboxService（本模块自身写面——risk_records/DictionaryUpdated
  // 出箱；InfrastructureModule 不 re-export，须显式 import）；RuleCenterModule：H7 免公示通道与
  // 现行版查询（词库版本化唯一事实源的机制 API）
  imports: [InfrastructureModule, RuleCenterModule],
  controllers: [WordAdminController],
  providers: [WordDictAutomatonCache, WordDictService],
  exports: [
    WordDictService, // D5 CHECK_RISK（M2）/ E1 currentBlockWords（Task 7）机制消费口
    WordDictAutomatonCache, // 测试隔离（clear）与 M2 Redis 换装观测位
  ],
})
export class WordDictModule {}
