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
import { TimeTableModule } from './modules/schedule/time-table.module';
import { PricingConfigModule } from './modules/pricing/pricing.module';
import { CreditModule } from './modules/credit/credit.module';
import { RuleCenterModule } from './modules/ops/rule-center.module';
import { WordDictModule } from './modules/ops/word-dict.module';
import { SpecialtyKnowledgeModule } from './modules/agent-assist/specialty.module';
import { SanitizeModule } from './modules/agent-assist/sanitize.module';
import { PaymentModule } from './modules/payment/payment.module';
import { BenefitsModule } from './modules/benefits/points.module';
import { TradeModule } from './modules/trade/trade.module';
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
    TimeTableModule, // B1 时间表管理（与 I2/B2 同 schedule schema owner，M1-W2 Task 4；消费 B2 Slot* 事件失效视图缓存）
    PricingConfigModule, // B3 默认价格与1对1价格配置（pricing schema owner，M1-W2 Task 5；版本化配置 R-03 只 INSERT，在团转 C6 适配位 R-W2-9）
    CreditModule, // G1 信用体系（credit schema owner，M1-W2 Task 6；不可变流水+规则表驱动限制令，入口拦截查询面待 W3 C1/C3 消费）
    RuleCenterModule, // H7 规则中心（ops schema owner，M1-W1 Task 4）
    WordDictModule, // H5 风控词库切片（ops schema owner，M1-W1 Task 5；人审闭环 M2-W2）
    SpecialtyKnowledgeModule, // E3 专项配置与知识库基建（agent_assist schema owner，M1-W1 Task 6；E1 Task 7 同目录追加）
    SanitizeModule, // E1 实时脱敏层切片（agent_assist schema owner，M1-W1 Task 7；草稿管线接线 M2-W3）
    PaymentModule, // F1 支付网关与回调 Inbox（payment schema owner，M1-W3 Task 1；指令面+回调验签+Inbox+对账；下游 C3=T7/H3=M2 接线）+ A3b 律所进件子域（M1-W3 Task 3：firm_merchants 状态机/R-01 查询面/FIRM_REVERIFY/保证金指令台账；下游 F3=T8/T10 H1 消费 FirmMerchantService）
    BenefitsModule, // F4 权益①切片（benefits schema owner，M1-W3 Task 2；积分账户/冻结核销解冻/退款还原/过期双路径；下游 C3=T7/F2=T6 消费 PointsService，券/备付=M2-W2 ②全量）
    TradeModule, // C1 B2C 开团（trade schema owner，M1-W3 Task 4；开团事务=B2 加锁+INSERT 同事务、幂等键=lawyer+slot_start、ENROLL_DEADLINE 流标执行器、session 终态 provider；下游 C3=T7 消费 markFull/SessionFull、F2=T6 消费 SessionFailed）
  ],
  controllers: [HealthController],
})
export class AppModule {}
