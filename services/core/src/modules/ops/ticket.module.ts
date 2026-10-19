/**
 * H3 纠纷工单模块（M2-W2 T1；ops schema owner）。
 *
 * 施工规格：docs/modules/H-运营后台/H3-纠纷工单与退款审核.md（§1-§10）。
 *
 * 依赖（单向，无环）：InfrastructureModule（pool/outbox/守卫/relay）+ IdentityAuthModule
 * （JWT 守卫件叶子）+ PricingChangeModule（C6 approve 导出面——处置回调真链，ticket.callbacks；
 * pricing 依赖树不含 ops，无环）+ SettlementModule（F3 闸导出面——修复环 I-1：R-04 工单源
 * 生产注册，TicketGateRegistration onModuleInit；settlement 依赖树不含 ops/pricing-change，
 * 无环）。消费面（ReconciliationDiffFound/RefundFailed）经 relay 既有框架注册
 * （settlement.consumer 同款）；跨域取数零处（工单正文自足留档，消费方回查走各域导出面）。
 *
 * 可剥离纪律：导出面=TicketService + TicketOpenTicketSource（R-04 工单源适配器）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { PricingChangeModule } from '../pricing/price-change.module';
import { SettlementModule } from '../settlement/settlement.module';
import { TicketResolveCallbackRegistry } from './ticket.callbacks';
import { TICKET_CONFIG, ticketConfigFromEnv } from './ticket.config';
import { TicketConsumer } from './ticket.consumer';
import { TicketController } from './ticket.controller';
import { TicketGateRegistration, TicketOpenTicketSource, TicketService } from './ticket.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule, PricingChangeModule, SettlementModule],
  controllers: [TicketController],
  providers: [
    // SLA 配置装配（env > 默认；Symbol token，缺装配 fail-fast——rule-center.config 同款）
    { provide: TICKET_CONFIG, useFactory: () => ticketConfigFromEnv(process.env) },
    // 处置回调器注册表（pricing 真链构造期注册；d4=W2 T3 接线位）
    TicketResolveCallbackRegistry,
    TicketService,
    // R-04 工单源适配器 + 生产注册件（修复环 I-1：onModuleInit registerSource 进 F3 闸）
    TicketOpenTicketSource,
    TicketGateRegistration,
    // 消费器经 onModuleInit 注册到 outbox relay
    TicketConsumer,
  ],
  // TicketResolveCallbackRegistry（M2-W2 T3 加法导出）：D4 cancellations approve 回调的
  // 注册缝（OpenTicketGate 导出同款裁决——目标侧 onModuleInit register，H3 侧本体零改动）
  exports: [TicketService, TicketOpenTicketSource, TicketResolveCallbackRegistry],
})
export class TicketModule {}
