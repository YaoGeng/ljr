import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { ObservabilityModule } from './observability/observability.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { DemoModule } from './modules/demo/demo.module';
import { IdentityModule } from './modules/identity/identity.module';
import { RealnameConsentModule } from './modules/identity/realname-consent.module';
import { LawyerQualificationModule } from './modules/identity/lawyer-qualification.module';
import { NotifyModule } from './modules/notify/notify.module';
import { SchedulerModule } from './modules/schedule/scheduler.module';
import { SlotLockModule } from './modules/schedule/slot-lock.module';
import { RuleCenterModule } from './modules/ops/rule-center.module';
import { WordDictModule } from './modules/ops/word-dict.module';
import { SpecialtyKnowledgeModule } from './modules/agent-assist/specialty.module';
import { SanitizeModule } from './modules/agent-assist/sanitize.module';
import { HealthController } from './health.controller';

// ObservabilityModule 紧随配置之后：http/pg 插桩先于 Infrastructure/Demo 建池注册
//（pg 插桩按 prototype patch，后建池同样生效；前置仅为装配序清晰）。
@Module({
  imports: [
    AppConfigModule,
    ObservabilityModule,
    InfrastructureModule,
    DemoModule,
    IdentityModule, // A1 注册登录与双角色（identity schema owner，M1-W2 Task 1；消费 NotifyModule 限频器）
    RealnameConsentModule, // A2 实名认证与同意管理（identity schema owner，M1-W2 Task 2；R-01 闸口查询面待 W3 C3/F1 消费）
    LawyerQualificationModule, // A3a 律师资质审核（identity schema owner，M1-W2 Task 3；R-01 isAuditPassed 待 W3 C3/接单大厅消费）
    NotifyModule,
    SchedulerModule,
    SlotLockModule, // B2 时间段占用锁（与 I2 同 schedule schema owner，M1-W1 Task 3）
    RuleCenterModule, // H7 规则中心（ops schema owner，M1-W1 Task 4）
    WordDictModule, // H5 风控词库切片（ops schema owner，M1-W1 Task 5；人审闭环 M2-W2）
    SpecialtyKnowledgeModule, // E3 专项配置与知识库基建（agent_assist schema owner，M1-W1 Task 6；E1 Task 7 同目录追加）
    SanitizeModule, // E1 实时脱敏层切片（agent_assist schema owner，M1-W1 Task 7；草稿管线接线 M2-W3）
  ],
  controllers: [HealthController],
})
export class AppModule {}
