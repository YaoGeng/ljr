/**
 * D2 提醒服务模块（M2-W1 T4；docs/modules/D-履约/D2-提醒服务.md）——代码位=notify 域
 * （架构 §3.2 notify 职责=「提醒编排」，消费 schedule/fulfillment/trade 导出面）。
 *
 * 独立成模块（不并入 NotifyModule）的原因（防 spec 回归）：NotifyModule 是 I1 通知中心的
 * 自持面（identity-auth 叶子依赖），D2 消费链需 FulfillmentModule（D5 postInternalMessage
 * 房间消息）+TradeModule（场次/报名导出面）+SchedulerModule（执行器注册表）——并入会把
 * WSS 网关等重依赖带进既有 notify spec 的测试图（WsAdapter 装配前置），零收益。
 * schedule/ 目录多模块同域先例：scheduler.module/slot-lock.module/time-table.module。
 *
 * 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2 红线）：
 *   I2 SchedulerModule（ScheduleExecutorRegistry——REMIND×4/REMIND_GRACE_END 注册）+
 *   OutboxRelayService（RoomOpened 消费）、C1 SessionService（getDetail/sessionOpenable）、
 *   C3 EnrollmentService（listPaidEnrollmentUsers 窄面，T4 加法）、D1 RoomService
 *   （statusOf/activeRoomIdOfSession 窄面，T4 加法）、D5 ConversationService
 *   （ensureConversation/postInternalMessage uow 形态，T4 加法）、I1 NotifyDispatcherService
 *   （逐人通知登记）+NotifyTemplateService（模板自愈读）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { TradeModule } from '../trade/trade.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { NotifyModule } from './notify.module';
import { ReminderDispatchService } from './reminder.service';
import { ReminderJobExecutors } from './reminder.executors';
import { ReminderConsumer } from './reminder.consumer';

@Module({
  imports: [
    InfrastructureModule,
    SchedulerModule, // I2：REMIND×4/REMIND_GRACE_END 执行器注册表 + relay（RoomOpened 消费）
    TradeModule, // C1/C3：场次快照与有效性导出面 + PAID 报名清单窄面
    FulfillmentModule, // D1/D5：房间状态窄面 + postInternalMessage 系统消息写入面
    NotifyModule, // I1：通知分发/模板中心（D7 默认=站内信）
  ],
  providers: [ReminderDispatchService, ReminderJobExecutors, ReminderConsumer],
})
export class ReminderModule {}
