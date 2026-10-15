/**
 * G1 信用体系（M1-W2 Task 6）：credit schema owner（V1 已建 schema/role，本模块首个落位），
 * 代码放 modules/credit/（credit.* 前缀，check-schema-refs 目录→schema 约定）。
 * 施工规格：docs/modules/G-信用与评价/G1-信用体系.md；V18__credit.sql 三表。
 *
 * 边界（§1）：CreditEvent 不可变流水+账户快照（唯一事实源）+ 规则表驱动限制令；不做入口拦截
 * 本体（C1/C3/A3a=W3 消费 /credit/restrictions 查询面）与规则公示（H7）。
 * 依赖（单向）：InfrastructureModule（pool/outbox/relay）+ IdentityAuthModule（JWT 守卫件，
 * 叶子模块反向无环）+ RuleCenterModule（H7 snapshotAt——跨 schema 只读经 service 接口，
 * 禁直查 ops 表）；六上游事件消费经 relay 注册（credit.consumer）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { RuleCenterModule } from '../ops/rule-center.module';
import {
  CREDIT_CACHE_CONFIG,
  CreditRestrictionCache,
  creditCacheConfigFromEnv,
} from './credit.cache';
import { CreditController } from './credit.controller';
import { CreditEventConsumer } from './credit.consumer';
import { CreditService } from './credit.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule, RuleCenterModule],
  controllers: [CreditController],
  providers: [
    // 缓存配置装配（LJR_CREDIT_CACHE_TTL_MS env > 代码默认 30s；Symbol token，pricing 同款）
    {
      provide: CREDIT_CACHE_CONFIG,
      useFactory: () => creditCacheConfigFromEnv(process.env),
    },
    CreditRestrictionCache,
    CreditService,
    // 六上游事件消费端（SlotAbuseDetected 真 topic 真接线；其余五件 W3/M2 生产者桩，docs/05 §2）
    CreditEventConsumer,
  ],
  exports: [
    CreditService, // EMIT_CREDIT_EVENT（W3 交易链内部调用）+ /credit/restrictions 机制面（入口拦截查询）
  ],
})
export class CreditModule {}
