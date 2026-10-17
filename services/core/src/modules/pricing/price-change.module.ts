/**
 * C6 改价与补偿模块（M1-W3 T9）：与 B3（PricingConfigModule）同 pricing 域但独立装配——
 * C6 消费 TradeModule 导出服务（在团判定/补偿对象），而 TradeModule 依赖 PricingConfigModule
 * （B3 快照锚）；若 C6 并入 PricingConfigModule 将成 module 环（NestJS 禁），故平级独立 module，
 * 文件仍落 modules/pricing/（C6 与 B3 同域，check-schema-refs 目录→schema 约定不变）。
 *
 * 依赖（单向，无环）：InfrastructureModule（pool/outbox）+ IdentityAuthModule（JWT 守卫件，
 * 叶子）+ PricingConfigModule（B3 版本服务——R-W3-P 单写者：C6 生效/恢复经 B3 导出方法）
 * + TradeModule（C1/C2/C3 导出：在团判定/补偿对象）+ BenefitsModule（F4 grant COMPENSATION
 * 真链）+ NotifyModule（I1 三档话术真消费：registerForEvent 事务内登记 + worker 下发）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { PricingConfigModule } from './pricing.module';
import { TradeModule } from '../trade/trade.module';
import { BenefitsModule } from '../benefits/points.module';
import { NotifyModule } from '../notify/notify.module';
import { PriceChangeController } from './price-change.controller';
import { PriceChangeService } from './price-change.service';
import { PriceChangePatrolService } from './price-change.patrol';

@Module({
  imports: [
    InfrastructureModule,
    IdentityAuthModule,
    PricingConfigModule,
    TradeModule,
    BenefitsModule,
    NotifyModule,
  ],
  controllers: [PriceChangeController],
  providers: [
    PriceChangeService,
    // H4 资损巡检⑤类补偿检测件（M1-W4 T1：pricing 侧自持 SQL，ops 巡检聚合消费）
    PriceChangePatrolService,
  ],
  exports: [PriceChangeService, PriceChangePatrolService],
})
export class PricingChangeModule {}
