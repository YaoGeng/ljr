/**
 * demo 模块（M0-4 验收脚手架）：一张表（demo.orders）+ 两态状态机（DRAFT→DONE）
 * + 一个事件（demo.order.completed），验证 写→守卫→outbox→relay→幂等消费 全链路。
 * M1 起可整体下线（demo schema 由 V3 迁移管理）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { DemoOrderConsumer } from './demo-order.consumer';
import { DemoOrderService } from './demo-order.service';

@Module({
  imports: [InfrastructureModule],
  providers: [DemoOrderService, DemoOrderConsumer],
  exports: [DemoOrderService],
})
export class DemoModule {}
