/**
 * H5 风控与敏感词管理（M1-W1 词库切片 + M2-W2 人审闭环）：双词库管理 + CHECK_RISK 同步判定 +
 * 词库热更新（走 H7 版本化免公示通道）+ 人审队列/处置/审计（risk-review.*，V45 处置留痕列）。
 * 施工规格：docs/modules/H-运营后台/H5-风控与敏感词管理.md；只写 ops.* 表（risk_records V8/V45、
 * audit_logs）；rule_definitions 词库正文经 H7 机制 API 取（不直查）。
 * 异步模型复核/定期巡查=R3 裁决后置（word-dict.events.ts 头注留位，⚠W2-7 维持）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { NotifyModule } from '../notify/notify.module';
import { RuleCenterModule } from './rule-center.module';
import { AuditLogService } from './audit-log.service';
import { WordAdminController } from './word-admin.controller';
import { RiskReviewController } from './risk-review.controller';
import { RiskReviewService } from './risk-review.service';
import { WordDictAutomatonCache } from './word-dict.cache';
import { WordDictService } from './word-dict.service';

@Module({
  // InfrastructureModule：PgPoolService/OutboxService（本模块自身写面——risk_records/DictionaryUpdated
  // 出箱；InfrastructureModule 不 re-export，须显式 import）；RuleCenterModule：H7 免公示通道与
  // 现行版查询（词库版本化唯一事实源的机制 API）
  // IdentityAuthModule（叶子）：/admin/risk/* 管理面的 JWT/角色守卫件（W3 T10 修复轮）
  // NotifyModule（叶子，M2-W2 T7）：人审 FALSE_POSITIVE 通知位直发桩——NotifyTemplateService
  //   模板在册判定（RESCHEDULE_EXPIRED/C6 同款；price-change.module 先例，无循环依赖）
  imports: [InfrastructureModule, RuleCenterModule, IdentityAuthModule, NotifyModule],
  controllers: [WordAdminController, RiskReviewController],
  providers: [
    WordDictAutomatonCache,
    WordDictService,
    // 人审闭环（T7）：处置审计双面的 audit 面（行内回填面=risk_records 本体）；同 schema
    // owner=ops 双 provide 实例（AuditLogService 无状态纯写面，LawyerAdminModule 同款先例）
    RiskReviewService,
    AuditLogService,
  ],
  exports: [
    WordDictService, // D5 CHECK_RISK（M2）/ E1 currentBlockWords（Task 7）机制消费口
    WordDictAutomatonCache, // 测试隔离（clear）与 M2 Redis 换装观测位
    RiskReviewService, // H4 指标管道（M2-W2 T8）人审积压口径查询位预留
  ],
})
export class WordDictModule {}
