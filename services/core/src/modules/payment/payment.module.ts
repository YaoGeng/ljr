/**
 * F1 支付网关与回调 Inbox 模块（M1-W3 T1；payment schema owner）+ A3b 进件子域（M1-W3 T3）。
 *
 * 落位（⚠W3-2）：架构 §3.3 独立网关=协议适配薄层、外部对接后置（通道全 mock）→ 开发期落 core，
 * 服务剥离=V2 演进路径。**可剥离纪律**：导出面只暴露应用服务（PaymentGatewayService /
 * PaymentReconcileService / FirmMerchantService）+ 事件契约（shared/events.ts）+ HTTP 契约
 * ——适配器/路由/状态机/告警 sink/进件执行器/消费者均为模块内部件，其他模块禁 import
 * （F3=R8/T8 经 FirmMerchantService 查询面消费 R-01；T10 H1 同）。
 *
 * A3b 进件子域（firm_merchants/lawyer_deposits 两表归本模块，identity 只读——架构 §3.3-3）：
 * FirmMerchantService（进件状态机+R-01 查询面）、FirmMerchantJobExecutors（FIRM_REVERIFY，
 * I2 目录在册 producer/executor=A3b）、FirmMerchantConsumer（消费 LawyerAuditPassed——与 A1
 * 同 topic 双 handler，relay 扇出承接）。无独立 module：与 F1 共域平级文件（firm-merchant.*）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
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
import {
  FIRM_MERCHANT_CONFIG,
  firmMerchantConfigFromEnv,
  type FirmMerchantConfig,
} from './firm-merchant.config';
import { FirmMerchantConsumer } from './firm-merchant.consumer';
import { FirmMerchantJobExecutors } from './firm-merchant.executors';
import { FirmMerchantService } from './firm-merchant.service';
import { DepositService } from './deposit.service';

@Module({
  imports: [InfrastructureModule, SchedulerModule],
  controllers: [PaymentController],
  providers: [
    // 配置装配（LJR_PAYMENT_* env > dev mock 缺省；Symbol token，测试 override 注入测试密钥）
    { provide: PAYMENT_CONFIG, useFactory: () => paymentConfigFromEnv(process.env) },
    // A3b 进件配置（保证金默认金额/复验期；dev 缺省占位，staging/prod 缺失 fail-fast）
    { provide: FIRM_MERCHANT_CONFIG, useFactory: () => firmMerchantConfigFromEnv(process.env) },
    // 双通道 mock（⚠W3-3：wechat_ecom 主 + alipay 备；M2 真实适配器同接口替换，含 A3b 进件原语）
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
    FirmMerchantService,
    DepositService,
    // FIRM_REVERIFY 执行器经 onModuleInit 注册到 I2 执行器注册表（job 由进件生效时按商户注册）
    FirmMerchantJobExecutors,
    // LawyerAuditPassed 消费者经 onModuleInit 注册到 outbox relay（与 A1 同 topic 扇出）
    FirmMerchantConsumer,
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）
  exports: [PaymentGatewayService, PaymentReconcileService, FirmMerchantService],
})
export class PaymentModule {}
