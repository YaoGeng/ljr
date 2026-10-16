/**
 * F1 支付网关与回调 Inbox 模块（M1-W3 T1；payment schema owner）。
 *
 * 落位（⚠W3-2）：架构 §3.3 独立网关=协议适配薄层、外部对接后置（通道全 mock）→ 开发期落 core，
 * 服务剥离=V2 演进路径。**可剥离纪律**：导出面只暴露应用服务（PaymentGatewayService /
 * PaymentReconcileService）+ 事件契约（shared/events.ts）+ HTTP 契约（§5 表）——适配器/路由/
 * 状态机/告警 sink 均为模块内部件，其他模块禁 import。
 *
 * 无事件消费（§6 指令型服务）：PaymentCallbackInboxed/ReconciliationDiffFound/ChannelDegraded
 * 出箱即止（下游 C3=T7、H3=M2、告警 sink=mock M2+ 换装）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import {
  ChannelRouter,
  MockChannelAdapter,
  PAYMENT_CHANNEL_ADAPTERS,
  type PaymentChannelAdapter,
} from './payment.channels';
import { PAYMENT_CONFIG, paymentConfigFromEnv, type PaymentConfig } from './payment.config';
import { MockPaymentAlertSink, PaymentAlertService } from './payment.alerts';
import { PaymentController } from './payment.controller';
import { PaymentGatewayService } from './payment.gateway.service';
import { PaymentReconcileService } from './payment.reconcile.service';

@Module({
  imports: [InfrastructureModule],
  controllers: [PaymentController],
  providers: [
    // 配置装配（LJR_PAYMENT_* env > dev mock 缺省；Symbol token，测试 override 注入测试密钥）
    { provide: PAYMENT_CONFIG, useFactory: () => paymentConfigFromEnv(process.env) },
    // 双通道 mock（⚠W3-3：wechat_ecom 主 + alipay 备；M2 真实适配器同接口替换）
    {
      provide: PAYMENT_CHANNEL_ADAPTERS,
      useFactory: (cfg: PaymentConfig): readonly PaymentChannelAdapter[] => [
        new MockChannelAdapter(cfg.primary.channel, cfg.primary.merchantId, cfg.primary.secret),
        new MockChannelAdapter(cfg.backup.channel, cfg.backup.merchantId, cfg.backup.secret),
      ],
      inject: [PAYMENT_CONFIG],
    },
    {
      provide: ChannelRouter,
      useFactory: (adapters: readonly PaymentChannelAdapter[], cfg: PaymentConfig) =>
        new ChannelRouter({
          adapters: [adapters[0]!, adapters[1]!],
          switchWindowMs: cfg.switchWindowMs,
        }),
      inject: [PAYMENT_CHANNEL_ADAPTERS, PAYMENT_CONFIG],
    },
    // 告警位（mock sink，沿 B2 先例；M2+ 换装真实通道，工单位=H3）
    MockPaymentAlertSink,
    {
      provide: PaymentAlertService,
      useFactory: (sink: MockPaymentAlertSink) => new PaymentAlertService(sink),
      inject: [MockPaymentAlertSink],
    },
    PaymentGatewayService,
    PaymentReconcileService,
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）
  exports: [PaymentGatewayService, PaymentReconcileService],
})
export class PaymentModule {}
