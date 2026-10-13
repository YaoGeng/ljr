import { Module } from '@nestjs/common';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { DemoModule } from './modules/demo/demo.module';
import { HealthController } from './health.controller';

@Module({
  imports: [InfrastructureModule, DemoModule],
  controllers: [HealthController],
})
export class AppModule {}
