/**
 * B3 默认价格与1对1价格配置（M1-W2 Task 5）：版本化价格配置（R-03 只 INSERT）+ 区间校验
 * （R-02 双层）+ 在团修改转 C6 适配位（R-W2-9）。施工规格：docs/modules/B-律师配置/
 * B3-默认价格与1对1价格配置.md；pricing schema owner（V1 已建 schema/role，本模块首个落位），
 * 代码放 modules/pricing/（pricing.* 前缀，check-schema-refs 目录→schema 约定）。
 *
 * 边界（§1）：不做改价规则判定（C6）、价格快照（C3）；无状态机（版本化配置，不涉 STL）；
 * I1 参与者通知 / C6 回流 = W3 消费位（本批只生产 PriceVersionCreated）。
 * 依赖（单向）：InfrastructureModule（pool/outbox）+ IdentityAuthModule（JWT 守卫件，
 * 叶子模块反向无环——identity-auth 头注依赖图不变）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import {
  PRICING_CACHE_CONFIG,
  CurrentPricingCache,
  pricingCacheConfigFromEnv,
} from './pricing.cache';
import { IN_GROUP_PROBE, InGroupProbeStub } from './pricing.adapters';
import { PricingController } from './pricing.controller';
import { PricingConfigService } from './pricing.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule],
  controllers: [PricingController],
  providers: [
    // 缓存配置装配（LJR_PRICING_CACHE_TTL_MS env > 代码默认 60s；Symbol token，time-table 同款）
    {
      provide: PRICING_CACHE_CONFIG,
      useFactory: () => pricingCacheConfigFromEnv(process.env),
    },
    CurrentPricingCache,
    // R-W2-9 在团判定适配位：本批恒 false（C1/C2 W3 接线转真，换 provider 不换接口）
    { provide: IN_GROUP_PROBE, useClass: InGroupProbeStub },
    PricingConfigService,
  ],
  exports: [PricingConfigService],
})
export class PricingConfigModule {}
