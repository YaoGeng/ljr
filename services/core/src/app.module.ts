import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { DemoModule } from './modules/demo/demo.module';
import { HealthController } from './health.controller';

@Module({
  imports: [AppConfigModule, InfrastructureModule, DemoModule],
  controllers: [HealthController],
})
export class AppModule {}
