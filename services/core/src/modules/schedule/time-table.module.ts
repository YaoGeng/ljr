/**
 * B1 时间表管理（M1-W2 Task 4）：按周重复的可预约时间段模板管理 + 物化入口 + 状态视图。
 * 施工规格：docs/modules/B-律师配置/B1-时间表管理.md；schedule schema owner（I2/B2 同库），
 * 代码放 modules/schedule/（time-table.* 前缀，check-schema-refs 目录→schema 约定）。
 *
 * 边界（§1）：无状态机（模板为本地配置，enabled boolean）；不代 B2 加锁——C1/C2（W3）选段后
 * 自己调 SlotLockService.lockSlot；Slot* 事件只消费不改（缓存失效）。
 * 依赖（单向）：InfrastructureModule（pool/relay）+ IdentityAuthModule（JWT 守卫件，叶子模块
 * 反向无环——identity-auth 头注依赖图不变）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import {
  TIME_TABLE_CACHE_CONFIG,
  SlotViewCache,
  timeTableCacheConfigFromEnv,
} from './time-table.cache';
import { SlotViewCacheEvictConsumer } from './time-table.consumer';
import { TimeTableController } from './time-table.controller';
import { TimeTableService } from './time-table.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule],
  controllers: [TimeTableController],
  providers: [
    // 缓存配置装配（LJR_TIME_TABLE_CACHE_TTL_MS env > 代码默认 60s；Symbol token，slot-lock 同款）
    {
      provide: TIME_TABLE_CACHE_CONFIG,
      useFactory: () => timeTableCacheConfigFromEnv(process.env),
    },
    SlotViewCache,
    TimeTableService,
    // Slot* 事件消费：onModuleInit 注册缓存失效 handler 到 relay
    SlotViewCacheEvictConsumer,
  ],
  exports: [TimeTableService],
})
export class TimeTableModule {}
