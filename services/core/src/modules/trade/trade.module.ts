/**
 * Trade 交易域模块（架构 §3.2 trade schema owner；C1/C2/C3 同域，本任务落 C1=B2C 开团
 * （session.*）+ C2=C2B 发起拼团（group-buy.*）+ C3=报名与支付成团（enrollment.*，M1-W3 T7）
 * + C4=C2B 律师响应与双向转化（group-buy-response.*，M2-W2 T4），文件前缀平级）。施工规格：
 * docs/modules/C-交易/C1-B2C开团、C2-C2B发起拼团、C3-报名与支付成团、C4-C2B律师响应与双向转化（§1-§10）。
 *
 * 可剥离纪律（沿 F1 形态）：导出面只暴露应用服务（SessionService / GroupBuyService /
 * EnrollmentService）+ 事件契约（shared/events）+ HTTP 契约——状态机/缓存/执行器/终态 provider/
 * 查询件/退款源/消费者均为模块内部件，其他模块禁 import。C3 消费位：markFull（C1）、
 * assertJoinable/groupBuyReachedGuard（C2）、SessionRefundSource（F2 R-W3-M 注册表 onModuleInit
 * 注册 'session' 键——F2 批量退款换真源）。
 *
 * 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2）：
 *   B2 SlotLockService（发布/开团事务加锁、流标释放、activeStatusOf 查询 + TerminalStateRegistry
 *     终态 provider 注册）、I2 SchedulerService（job 预写）+ ScheduleExecutorRegistry
 *     （ENROLL_DEADLINE 执行器按 ref_type 分流 + C2B_CONFIRM_TIMEOUT 执行器）、
 *   B3 PricingConfigService（默认价/接受范围/快照版本锚）、G1 CreditService（限制令）、
 *   A3a LawyerQualificationService（isAuditPassed 列表闸）、A2 RealnameService（isRealnameVerified
 *   实名闸口）、A1 IdentityAuthModule（JWT 守卫件）、F4 PointsService（freezeInTx/settleInTx/
 *   unfreezeInTx 同事务编排）、F1 PaymentModule（createOrderInTx 同事务下单 + 幂等键只读定位面 +
 *   markFrozen/inbox 标记）、F2 RefundService（自动退款分支 ISSUE_REFUND）。
 *
 * B1（time-table）本批无进程内消费点：选段数据源由 B1 自有 HTTP 面承载（GET /lawyer/{id}/slots），
 * C1/C2 契约 §5 无对应端点，不发明契约——报告注明。C3 裁决：不注册 RESTRICTION_ISSUED/
 * CREDIT_EVENT_EMITTED 消费者（入口拉取校验已足，w2-smoke noop 维持 TODO(H4) 不动）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { SlotLockModule } from '../schedule/slot-lock.module';
import { PricingConfigModule } from '../pricing/pricing.module';
import { CreditModule } from '../credit/credit.module';
import { PaymentModule } from '../payment/payment.module';
import { BenefitsModule } from '../benefits/points.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { LawyerQualificationModule } from '../identity/lawyer-qualification.module';
import { RealnameConsentModule } from '../identity/realname-consent.module';
import { TRADE_SESSION_CONFIG, tradeSessionConfigFromEnv } from './session.config';
import { SessionListCache } from './session.cache';
import { SessionController } from './session.controller';
import { SessionJobExecutors } from './session.executors';
import { SessionService } from './session.service';
import { SessionTerminalProvider } from './session.terminal-provider';
import { TRADE_GROUP_BUY_CONFIG, tradeGroupBuyConfigFromEnv } from './group-buy.config';
import { GroupBuyListCache } from './group-buy.cache';
import { GroupBuyController } from './group-buy.controller';
import { GroupBuyJobExecutors } from './group-buy.executors';
import { GroupBuyResponseController } from './group-buy-response.controller';
import { GroupBuyResponseService } from './group-buy-response.service';
import { GroupBuyService } from './group-buy.service';
import { GroupBuyTerminalProvider } from './group-buy.terminal-provider';
import { EnrollmentConsumer } from './enrollment.consumer';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentPatrolService } from './enrollment.patrol';
import { EnrollmentQueryService } from './enrollment.query';
import { SessionRefundSource } from './enrollment.refund-source';
import { EnrollmentService } from './enrollment.service';

@Module({
  imports: [
    InfrastructureModule,
    SchedulerModule,
    SlotLockModule,
    PricingConfigModule,
    CreditModule,
    PaymentModule, // F1：C2 发布事务同事务下单（createOrderInTx）+ F3 幂等键只读定位面 + C3 回调/inbox
    BenefitsModule, // F4：C3 报名冻结/核销/解冻同事务编排（freezeInTx/settleInTx/unfreezeInTx，叶子无循环）
    IdentityAuthModule,
    LawyerQualificationModule,
    RealnameConsentModule, // A2：C3 实名闸口 isRealnameVerified（R-06；叶子无循环）
  ],
  controllers: [
    SessionController,
    GroupBuyController,
    GroupBuyResponseController,
    EnrollmentController,
  ],
  providers: [
    // 配置装配（LJR_TRADE_* env > 代码默认；⚠04§8-3 截止缺省 24h、§4 确认窗 12h 在此配置化）
    { provide: TRADE_SESSION_CONFIG, useFactory: () => tradeSessionConfigFromEnv(process.env) },
    { provide: TRADE_GROUP_BUY_CONFIG, useFactory: () => tradeGroupBuyConfigFromEnv(process.env) },
    SessionListCache,
    SessionService,
    GroupBuyListCache,
    GroupBuyService,
    // C4 C2B 律师响应与双向转化（M2-W2 T4）：接单大厅/confirm/reject/convert/response-stats
    // （应用服务+REST 面；Session 建面经 SessionService 单点，enrollment 迁移=trade 域内批量新建）
    GroupBuyResponseService,
    // C3 报名与支付成团（T7）：查询件（C2 cancel 计数缝）/应用服务/退款源（R-W3-M onModuleInit
    // 注册 'session'）/消费者（回调成团守卫+SessionFailed·GroupBuyExpired 扫场+RefundCompleted 收敛）
    EnrollmentQueryService,
    EnrollmentService,
    SessionRefundSource,
    EnrollmentConsumer,
    // H4 资损巡检①类候选检测件（M1-W4 T1：trade 侧自持 SQL，ops 巡检聚合消费——跨域经导出服务）
    EnrollmentPatrolService,
    // ENROLL_DEADLINE 执行器（按 ref_type 分流 session/groupbuy）+ C2B_CONFIRM_TIMEOUT 执行器
    // 经 onModuleInit 注册到 I2 执行器注册表（producer/executor=trade）
    SessionJobExecutors,
    GroupBuyJobExecutors,
    // session/groupbuy 终态 provider 经 onModuleInit 注册到 B2 终态注册表（isTerminalBatch 批量形态）
    SessionTerminalProvider,
    GroupBuyTerminalProvider,
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）
  exports: [
    SessionService,
    GroupBuyService,
    GroupBuyResponseService,
    EnrollmentService,
    EnrollmentPatrolService,
  ],
})
export class TradeModule {}
