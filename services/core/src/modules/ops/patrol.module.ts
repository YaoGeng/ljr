/**
 * H4 资损巡检模块（M1-W4 Task 1）：ops schema owner（V34 两表——巡检运行记录+违例台账），
 * 代码放 modules/ops/（patrol.* 前缀，check-schema-refs 目录→schema 约定；与 rule-center/
 * word-dict/lawyer-admin 同为 ops 域平级子模块）。
 *
 * 施工依据：docs/02-架构设计.md §7.2 五类不变量 + docs/plans/M1-W4-执行计划.md 序 1（⚠W4-2/3/4/5
 * 裁决：ops 域 patrol 子模块 / 告警供应商位 / I2 分钟级 jobType / 阈值全配置化）。
 *
 * 依赖（单向叶子消费，无环）：InfrastructureModule（pool）+ SchedulerModule（I2 机制+backlog
 * 判定面）+ SlotLockModule（②类锁检测件）+ PaymentModule（④类指令检测件+①类退款核对导出面）
 * + TradeModule（①类候选检测件）+ PricingChangeModule（⑤类候选检测件）+ BenefitsModule
 * （⑤类 F4 授予流水核对面）。检测 SQL 各域自持——本模块只做聚合编排与台账，禁跨 schema join。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { SlotLockModule } from '../schedule/slot-lock.module';
import { PaymentModule } from '../payment/payment.module';
import { TradeModule } from '../trade/trade.module';
import { PricingChangeModule } from '../pricing/price-change.module';
import { BenefitsModule } from '../benefits/points.module';
import { MockPatrolAlertSink, PATROL_ALERT_SINK } from './patrol.alerts';
import { PATROL_CONFIG, patrolConfigFromEnv } from './patrol.config';
import { PatrolJobExecutors } from './patrol.executors';
import { PatrolService } from './patrol.service';

@Module({
  imports: [
    InfrastructureModule,
    SchedulerModule,
    SlotLockModule,
    PaymentModule,
    TradeModule,
    PricingChangeModule,
    BenefitsModule,
  ],
  providers: [
    // 配置装配（LJR_PATROL_* env > 代码默认；Symbol token，测试 override 注入）
    { provide: PATROL_CONFIG, useFactory: () => patrolConfigFromEnv(process.env) },
    // 告警供应商位：dev 绑 mock（零外部调用零凭据）；M2+ 换装=替换本绑定（useExisting 缝合点）
    MockPatrolAlertSink,
    { provide: PATROL_ALERT_SINK, useExisting: MockPatrolAlertSink },
    PatrolService,
    // RISK_PATROL 执行器经 onModuleInit 注册到 I2 执行器注册表（真注册，非 NO_EXECUTOR 形态）
    PatrolJobExecutors,
  ],
  exports: [PatrolService, PatrolJobExecutors],
})
export class PatrolModule {}
