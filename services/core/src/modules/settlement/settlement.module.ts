/**
 * F3 分账结算模块（M1-W3 T8；settlement schema owner）。
 *
 * 施工规格：docs/modules/F-资金/F3-分账结算.md（§1-§10）。
 *
 * 可剥离纪律（沿 F1 形态）：导出面只暴露应用服务（SettlementService）+ 事件契约
 * （shared/events）+ HTTP 契约——状态机/工单闸/消费者/执行器均为模块内部件，其他模块禁
 * import。跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2）：
 *   I2 SchedulerService（SETTLE_HOLD_RELEASE 预写）+ ScheduleExecutorRegistry（执行器注册）、
 *   F1 PaymentModule（/pay/split、/pay/deduct 指令面 + findOrderById 读缝：R-07 通道定位）、
 *   A3b FirmMerchantService（R-01 分账前置 assertSplittable 查询面——T3 交付约定消费缝）、
 *   A1 IdentityAuthModule（JWT 守卫件，GET /lawyer/settlements 本人语义面）。
 *
 * 消费面（W3 可达=合成事件桩 + A3b/I2 真通路；M2 转正位见 shared 契约注记）：
 *   RoomClosed/OneOnOneSettled（D1/D6）、AttendanceAdjudicated（D3）、TicketResolved（H3）、
 *   FirmMerchantSuspended/Activated（A3b 真事件）；SessionCancelled→APPLY_PENALTY 为内部
 *   指令面（R-W3-A：D4=M2 调用方自备快照金额）；ScheduleJobFired(SETTLE_HOLD_RELEASE)
 *   消费真通路=I2 执行器同事务承接（SettlementJobExecutors）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { PaymentModule } from '../payment/payment.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { OpenTicketGate } from './settlement.gate';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { SettlementConsumer } from './settlement.consumer';
import { SettlementJobExecutors } from './settlement.executors';

@Module({
  // PaymentModule（F1/A3b 导出服务）；IdentityAuthModule（叶子，JWT 守卫件；notify/benefits 先例）
  imports: [InfrastructureModule, SchedulerModule, PaymentModule, IdentityAuthModule],
  controllers: [SettlementController],
  providers: [
    // H3 工单闸（W3 无生产源=恒无未结工单；H3=M2 经 registerSource 换装）
    OpenTicketGate,
    SettlementService,
    // 消费器经 onModuleInit 注册到 outbox relay（同 topic 多 handler 扇出由 relay 承接）
    SettlementConsumer,
    // SETTLE_HOLD_RELEASE 执行器经 onModuleInit 注册到 I2 执行器注册表（producer/executor=F3）
    SettlementJobExecutors,
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）
  exports: [SettlementService],
})
export class SettlementModule {}
