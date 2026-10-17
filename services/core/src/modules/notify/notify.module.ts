/**
 * I1 通知中心（M1-W1）：通知统一编排（推送/SMS/站内信 mock 适配）、模板中心（PRD §8.2 三档话术 seed）、
 * 触达台账（幂等+守卫+回执事件）、验证码限频计数（R-02，A1 W2 承接消费）。
 * 施工规格：docs/modules/I-平台支撑/I1-通知中心.md；只写 notify.* 表（边界纪律）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { NotificationPrefsController } from './notification-prefs.controller';
import { NotificationsController } from './notifications.controller';
import {
  InboxChannelAdapter,
  MockPushChannelAdapter,
  MockSmsChannelAdapter,
  NotifyChannelRegistry,
  NOTIFY_CHANNEL_ADAPTERS,
} from './notify.channels';
import { NotifyDispatchWorker } from './notify-dispatch.worker';
import { NotifyDispatcherService } from './notify-dispatcher.service';
import { NotifyPrefsService } from './notify-prefs.service';
import { NotifyTemplateService } from './notify-template.service';
import { VerifyCodeRateLimiter } from './verify-code-rate-limiter.service';

@Module({
  // IdentityAuthModule（叶子模块，无循环）：I1 用户面 REST 的身份由 A1 JWT 守卫承接（W2 交接 4-B）
  imports: [InfrastructureModule, IdentityAuthModule],
  controllers: [NotificationsController, NotificationPrefsController],
  providers: [
    NotifyTemplateService,
    NotifyPrefsService,
    // 通道适配器：默认 mock 三件套（外部对接后置约定）；测试 override NOTIFY_CHANNEL_ADAPTERS 注入桩
    MockPushChannelAdapter,
    MockSmsChannelAdapter,
    InboxChannelAdapter,
    {
      provide: NOTIFY_CHANNEL_ADAPTERS,
      useFactory: (push, sms, inbox) => [push, sms, inbox],
      inject: [MockPushChannelAdapter, MockSmsChannelAdapter, InboxChannelAdapter],
    },
    NotifyChannelRegistry,
    NotifyDispatcherService,
    VerifyCodeRateLimiter,
    NotifyDispatchWorker,
  ],
  exports: [
    NotifyDispatcherService,
    NotifyTemplateService,
    NotifyPrefsService,
    NotifyChannelRegistry,
    VerifyCodeRateLimiter,
  ],
})
export class NotifyModule {}
