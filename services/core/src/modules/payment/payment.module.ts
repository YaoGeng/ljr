/**
 * F1 支付网关与回调 Inbox 模块（M1-W3 T1；payment schema owner）+ A3b 进件子域（M1-W3 T3）
 * + F2 退款执行域（M1-W3 T6）。
 *
 * 落位（⚠W3-2）：架构 §3.3 独立网关=协议适配薄层、外部对接后置（通道全 mock）→ 开发期落 core，
 * 服务剥离=V2 演进路径。**可剥离纪律**：导出面只暴露应用服务（PaymentGatewayService /
 * PaymentReconcileService / FirmMerchantService / RefundService / RefundSourceRegistry）+ 事件契约
 * （shared/events.ts）+ HTTP 契约——适配器/路由/状态机/告警 sink/进件执行器/消费者均为模块内部件，
 * 其他模块禁 import（F3=R8/T8 经 FirmMerchantService 查询面消费 R-01；T10 H1 同；C3=T7 经
 * RefundSourceRegistry 注册退款源）。
 *
 * A3b 进件子域（firm_merchants/lawyer_deposits 两表归本模块，identity 只读——架构 §3.3-3）：
 * FirmMerchantService（进件状态机+R-01 查询面）、FirmMerchantJobExecutors（FIRM_REVERIFY，
 * I2 目录在册 producer/executor=A3b）、FirmMerchantConsumer（消费 LawyerAuditPassed——与 A1
 * 同 topic 双 handler，relay 扇出承接）。无独立 module：与 F1 共域平级文件（firm-merchant.*）。
 *
 * F2 退款执行域（refund.*，与 F1/A3b 同域平级）：RefundService（受理 ISSUE_REFUND/金额守恒/
 * 下发/回调收敛/失败重试/mine 查询）、RefundSourceRegistry（R-W3-M 付款人清单注册表——trade
 * 真源=T7 注册）、RefundConsumer（消费 SessionFailed 批量退款 + F1 回调事件 REFUND_SUCCESS
 * 收敛；与后续 C3 消费位同 topic 双 handler 由 relay 扇出承接）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { BenefitsModule } from '../benefits/points.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
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
import { PaymentPatrolService } from './payment.patrol';
import { PaymentReconcileService } from './payment.reconcile.service';
import { FIRM_MERCHANT_CONFIG, firmMerchantConfigFromEnv } from './firm-merchant.config';
import { FirmMerchantConsumer } from './firm-merchant.consumer';
import { FirmMerchantJobExecutors } from './firm-merchant.executors';
import { FirmMerchantService } from './firm-merchant.service';
import { FirmMerchantController } from './firm-merchant.controller';
import { DepositService } from './deposit.service';
import { RefundConsumer } from './refund.consumer';
import { RefundController } from './refund.controller';
import { RefundService } from './refund.service';
import { RefundSourceRegistry } from './refund.source';

@Module({
  // BenefitsModule（叶子，无循环）：F2 退款还原经 PointsService.refundRestore 真消费（R-03）；
  // IdentityAuthModule（叶子）：GET /refunds/mine 的 JWT 守卫件（notify/benefits 同款先例）
  imports: [InfrastructureModule, SchedulerModule, BenefitsModule, IdentityAuthModule],
  controllers: [PaymentController, FirmMerchantController, RefundController],
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
    // H4 资损巡检④类指令检测件（M1-W4 T1：payment 侧自持 SQL，ops 巡检聚合消费）
    PaymentPatrolService,
    FirmMerchantService,
    DepositService,
    // F2 退款执行域（R-W3-M 注册表：trade 真源=T7 经本注册表注册；测试假源 override 注入）
    RefundSourceRegistry,
    RefundService,
    // F2 消费者经 onModuleInit 注册到 outbox relay（SessionFailed + PaymentCallbackInboxed）
    RefundConsumer,
    // FIRM_REVERIFY 执行器经 onModuleInit 注册到 I2 执行器注册表（job 由进件生效时按商户注册）
    FirmMerchantJobExecutors,
    // LawyerAuditPassed 消费者经 onModuleInit 注册到 outbox relay（与 A1 同 topic 扇出）
    FirmMerchantConsumer,
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）；RefundSourceRegistry=R-W3-M 跨模块注册缝
  exports: [
    PaymentGatewayService,
    PaymentReconcileService,
    PaymentPatrolService,
    FirmMerchantService,
    RefundService,
    RefundSourceRegistry,
  ],
})
export class PaymentModule {}
