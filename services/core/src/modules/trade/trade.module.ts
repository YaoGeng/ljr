/**
 * Trade 交易域模块（架构 §3.2 trade schema owner；C1/C2/C3 同域，本任务落 C1=B2C 开团
 * （session.*）+ C2=C2B 发起拼团（group-buy.*），文件前缀平级）。施工规格：
 * docs/modules/C-交易/C1-B2C开团、C2-C2B发起拼团（§1-§10）。
 *
 * 可剥离纪律（沿 F1 形态）：导出面只暴露应用服务（SessionService / GroupBuyService）+ 事件契约
 * （shared/events）+ HTTP 契约——状态机/缓存/执行器/终态 provider 均为模块内部件，其他模块禁
 * import（C3=T7 经 SessionService.markFull / GroupBuyService.assertJoinable/groupBuyReachedGuard
 * 消费位推进；F2=T6 消费 SessionFailed/GroupBuyExpired 事件）。
 *
 * 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2）：
 *   B2 SlotLockService（发布/开团事务加锁、流标释放、activeStatusOf 查询 + TerminalStateRegistry
 *     终态 provider 注册）、I2 SchedulerService（job 预写）+ ScheduleExecutorRegistry
 *     （ENROLL_DEADLINE 执行器按 ref_type 分流 + C2B_CONFIRM_TIMEOUT 执行器）、
 *   B3 PricingConfigService（默认价/接受范围）、G1 CreditService（限制令）、
 *   A3a LawyerQualificationService（isAuditPassed 列表闸）、A1 IdentityAuthModule（JWT 守卫件）、
 *   F1 PaymentModule（C2 发布事务 createOrderInTx 同事务下单 + 幂等键定位只读面）。
 *
 * B1（time-table）本批无进程内消费点：选段数据源由 B1 自有 HTTP 面承载（GET /lawyer/{id}/slots），
 * C1/C2 契约 §5 无对应端点，不发明契约——报告注明。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { SlotLockModule } from '../schedule/slot-lock.module';
import { PricingConfigModule } from '../pricing/pricing.module';
import { CreditModule } from '../credit/credit.module';
import { PaymentModule } from '../payment/payment.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { LawyerQualificationModule } from '../identity/lawyer-qualification.module';
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
import { GroupBuyService } from './group-buy.service';
import { GroupBuyTerminalProvider } from './group-buy.terminal-provider';

@Module({
  imports: [
    InfrastructureModule,
    SchedulerModule,
    SlotLockModule,
    PricingConfigModule,
    CreditModule,
    PaymentModule, // F1：C2 发布事务同事务下单（createOrderInTx）+ 幂等键只读定位面
    IdentityAuthModule,
    LawyerQualificationModule,
  ],
  controllers: [SessionController, GroupBuyController],
  providers: [
    // 配置装配（LJR_TRADE_* env > 代码默认；⚠04§8-3 截止缺省 24h、§4 确认窗 12h 在此配置化）
    { provide: TRADE_SESSION_CONFIG, useFactory: () => tradeSessionConfigFromEnv(process.env) },
    { provide: TRADE_GROUP_BUY_CONFIG, useFactory: () => tradeGroupBuyConfigFromEnv(process.env) },
    SessionListCache,
    SessionService,
    GroupBuyListCache,
    GroupBuyService,
    // ENROLL_DEADLINE 执行器（按 ref_type 分流 session/groupbuy）+ C2B_CONFIRM_TIMEOUT 执行器
    // 经 onModuleInit 注册到 I2 执行器注册表（producer/executor=trade）
    SessionJobExecutors,
    GroupBuyJobExecutors,
    // session/groupbuy 终态 provider 经 onModuleInit 注册到 B2 终态注册表（isTerminalBatch 批量形态）
    SessionTerminalProvider,
    GroupBuyTerminalProvider,
  ],
  // 可剥离纪律：只导出应用服务（内部件不外泄）
  exports: [SessionService, GroupBuyService],
})
export class TradeModule {}
