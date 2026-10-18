/**
 * Fulfillment 履约域模块（架构 §3.2 fulfillment schema owner；本域第一个模块=D1 房间生命周期
 * （room.*），D5 会话与消息=M2-W1 T3 同目录追加（⚠W1-2：开发期落 core 单进程，独立 rtc-im
 * 服务剥离=V2 演进；可剥离纪律=他域仅经导出接口/事件消费））。施工规格：
 * docs/modules/D-履约/D1-房间生命周期（§1-§10）。
 *
 * 可剥离纪律（沿 trade/payment 形态）：导出面只暴露应用服务（RoomService）+事件契约
 * （shared/events）+HTTP 契约——状态机/执行器/RTC 适配器为模块内部件，其他模块禁 import。
 *
 * 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2）：
 *   I2 SchedulerService（GRACE_END 同事务预写）+ ScheduleExecutorRegistry（ROOM_OPEN/
 *     GRACE_END 执行器 onModuleInit 注册）、C1 SessionService（快照/聚合锚导出面）、
 *   F2 RefundSourceRegistry（close 的 paid 清单，'session' 键=trade 真源注册）、
 *   A1 IdentityAuthModule（close 律师端 JWT/角色守卫件）。
 * RTC 通道=Symbol 令牌适配器（RTC_PROVIDER）：W1=MockRtcProvider 内存实现（声网 R11=M3-W1
 * 前不开通，外部对接后置），prod 换装只改本模块工厂。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { TradeModule } from '../trade/trade.module';
import { PaymentModule } from '../payment/payment.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { RoomController } from './room.controller';
import { RoomJobExecutors } from './room.executors';
import { RoomService } from './room.service';
import { RTC_PROVIDER, MockRtcProvider } from './rtc-provider';

@Module({
  imports: [
    InfrastructureModule,
    SchedulerModule, // I2：GRACE_END 预写（registerJob）+ 执行器注册表
    TradeModule, // C1：getDetail 快照面 + sessionOpenable/closeAnchorOf 纯读窄面（T1 加法）
    PaymentModule, // F1/F2：RefundSourceRegistry（'session' 退款源=close gross 聚合链）
    IdentityAuthModule, // A1：close 律师端 JWT/角色守卫件（叶子模块）
  ],
  controllers: [RoomController],
  providers: [
    // RTC 通道适配器（供应商位：mock=W1；声网=M3-W1 换装只改工厂；测试可 override 注失败形态）
    MockRtcProvider,
    {
      provide: RTC_PROVIDER,
      useFactory: (mock: MockRtcProvider) => mock,
      inject: [MockRtcProvider],
    },
    RoomService,
    // ROOM_OPEN（highPriority 通道）/GRACE_END 执行器经 onModuleInit 注册到 I2 注册表
    RoomJobExecutors,
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）
  exports: [RoomService],
})
export class FulfillmentModule {}
