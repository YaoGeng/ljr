import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { ObservabilityModule } from './observability/observability.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { DemoModule } from './modules/demo/demo.module';
import { NotifyModule } from './modules/notify/notify.module';
import { SchedulerModule } from './modules/schedule/scheduler.module';
import { SlotLockModule } from './modules/schedule/slot-lock.module';
import { RuleCenterModule } from './modules/ops/rule-center.module';
import { HealthController } from './health.controller';

// ObservabilityModule 紧随配置之后：http/pg 插桩先于 Infrastructure/Demo 建池注册
//（pg 插桩按 prototype patch，后建池同样生效；前置仅为装配序清晰）。
@Module({
  imports: [
    AppConfigModule,
    ObservabilityModule,
    InfrastructureModule,
    DemoModule,
    NotifyModule,
    SchedulerModule,
    SlotLockModule, // B2 时间段占用锁（与 I2 同 schedule schema owner，M1-W1 Task 3）
    RuleCenterModule, // H7 规则中心（ops schema owner，M1-W1 Task 4）
  ],
  controllers: [HealthController],
})
export class AppModule {}
