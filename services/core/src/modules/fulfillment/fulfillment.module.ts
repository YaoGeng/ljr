/**
 * Fulfillment 履约域模块（架构 §3.2 fulfillment schema owner；D1 房间生命周期（room.*，M2-W1 T1）
 * + D5 会话与消息（conversation.*，M2-W1 T3）+ D3 到场与缺席判定（attendance.*，M2-W2 T2）
 * 同目录追加——⚠W1-2：开发期落 core 单进程，独立 rtc-im 服务剥离=V2 演进；可剥离纪律=他域
 * 仅经导出接口/事件消费）。施工规格：docs/modules/D-履约/D1-房间生命周期.md、
 * docs/modules/D-履约/D5-会话与消息.md、docs/modules/D-履约/D3-到场与缺席判定.md（§1-§10）。
 *
 * 可剥离纪律（沿 trade/payment 形态）：导出面只暴露应用服务（RoomService/ConversationService）
 * +事件契约（shared/events）+HTTP/WSS 契约——状态机/执行器/RTC 适配器/网关为模块内部件，
 * 其他模块禁 import。
 *
 * 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2）：
 *   I2 SchedulerService（GRACE_END 同事务预写）+ ScheduleExecutorRegistry（ROOM_OPEN/GRACE_END/
 *     COLD_ARCHIVE 执行器 onModuleInit 注册）、C1 SessionService（快照/聚合锚导出面）、
 *   F2 RefundSourceRegistry（close 的 paid 清单，'session' 键=trade 真源注册）、
 *   A1 IdentityAuthModule（close 律师端 JWT/角色守卫件 + D5 WSS 首帧 auth 的 JwtService）、
 *   H5 WordDictModule（checkRisk 同步判定面——D5 发送链消费，R-01 单入口）、
 *   H7 RuleCenterModule（GET /rooms/{id}/notice 薄代理取数面，禁跨 schema 直读）、
 *   I3 ArtifactsModule（冷存 putArtifact 统一入口——横切基座先例，写 platform.artifacts
 *     经基座服务，禁直连基座表）。
 * RTC 通道=Symbol 令牌适配器（RTC_PROVIDER）：W1=MockRtcProvider 内存实现（声网 R11=M3-W1
 * 前不开通，外部对接后置），prod 换装只改本模块工厂。
 * WSS 网关（ConversationGateway）挂 core 单进程（main.ts WsAdapter 装配，/ws 路径）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { ArtifactsModule } from '../../infrastructure/artifacts/artifacts.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { TradeModule } from '../trade/trade.module';
import { PaymentModule } from '../payment/payment.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { RuleCenterModule } from '../ops/rule-center.module';
import { WordDictModule } from '../ops/word-dict.module';
import { RoomController } from './room.controller';
import { RoomJobExecutors } from './room.executors';
import { RoomService } from './room.service';
import { RTC_PROVIDER, MockRtcProvider } from './rtc-provider';
import { ConversationController } from './conversation.controller';
import { ConversationConsumer } from './conversation.consumer';
import { ConversationJobExecutors } from './conversation.executors';
import { ConversationGateway } from './conversation.gateway';
import { ConversationHub } from './conversation.hub';
import { ConversationService } from './conversation.service';
import { WSS_AUTH_TIMEOUT_MS, DEFAULT_WSS_AUTH_TIMEOUT_MS } from './conversation.gateway';
import { AttendanceController } from './attendance.controller';
import { AttendanceConsumer } from './attendance.consumer';
import { AttendanceJobExecutors } from './attendance.executors';
import { AttendanceService } from './attendance.service';
import { ATTENDANCE_CONFIG, attendanceConfigFromEnv } from './attendance.config';

@Module({
  imports: [
    InfrastructureModule,
    SchedulerModule, // I2：GRACE_END/COLD_ARCHIVE 预写与自投 + 执行器注册表
    TradeModule, // C1：getDetail 快照面 + sessionOpenable/closeAnchorOf 纯读窄面（T1 加法）
    PaymentModule, // F1/F2：RefundSourceRegistry（'session' 退款源=close gross 聚合链）
    IdentityAuthModule, // A1：close 律师端 JWT/角色守卫件 + D5 WSS 首帧 auth（叶子模块）
    RuleCenterModule, // H7：GET /rooms/{id}/notice 薄代理取数面（noticeContent 导出）
    WordDictModule, // H5：checkRisk 同步判定（D5 发送链 R-01 单入口）
    ArtifactsModule, // I3：冷存 putArtifact 统一入口（COLD_ARCHIVE 日扫写入面）
  ],
  controllers: [RoomController, ConversationController, AttendanceController],
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
    // D5：进程内广播总线 + 应用服务 + WSS 网关 + 事件消费端 + COLD_ARCHIVE 执行器
    ConversationHub,
    ConversationService,
    ConversationGateway,
    ConversationConsumer,
    ConversationJobExecutors,
    // WSS 鉴权超时（⚠W1-6 默认 10s；测试 override 缩短覆盖同一分支）
    { provide: WSS_AUTH_TIMEOUT_MS, useValue: DEFAULT_WSS_AUTH_TIMEOUT_MS },
    // D3 到场与缺席判定（M2-W2 T2）：应用服务 + presence/GracePeriodEnded 消费端 +
    // ABSENT_15M/NO_SHOW_CLOSE 执行器 + 容忍窗口配置（D3 §11 配置项默认 60s）
    AttendanceService,
    AttendanceConsumer,
    AttendanceJobExecutors,
    { provide: ATTENDANCE_CONFIG, useFactory: attendanceConfigFromEnv },
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）；ConversationService=D2 房间内提醒
  // （postInternalMessage 系统消息写入面，T4 消费）与 W3 E1（agent 写入接线位）的导出面
  exports: [RoomService, ConversationService],
})
export class FulfillmentModule {}
