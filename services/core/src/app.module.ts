import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { ObservabilityModule } from './observability/observability.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { DemoModule } from './modules/demo/demo.module';
import { HealthController } from './health.controller';

// ObservabilityModule 紧随配置之后：http/pg 插桩先于 Infrastructure/Demo 建池注册
//（pg 插桩按 prototype patch，后建池同样生效；前置仅为装配序清晰）。
@Module({
  imports: [AppConfigModule, ObservabilityModule, InfrastructureModule, DemoModule],
  controllers: [HealthController],
})
export class AppModule {}
