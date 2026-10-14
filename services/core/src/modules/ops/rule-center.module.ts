/**
 * H7 规则中心（M1-W1 Task 4）：ops.rule_definitions 通用规则版本化唯一事实源（R-01 公示≥7日+
 * 行为时快照）+ 房间须知内容块（R-02，D5 消费）+ 词库免公示通道（R-03，Task 5 H5 消费）。
 * 施工规格：docs/modules/H-运营后台/H7-规则中心.md；只写 ops.* 表（边界纪律）；
 * RULE_EFFECTIVE 执行器经 onModuleInit 注册到 I2 执行器注册表（catalog 裁决：生产方/执行器=H7）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from '../schedule/scheduler.module';
import { InProcessRuleCurrentCache, RULE_CURRENT_CACHE } from './rule-center.cache';
import { RULE_CENTER_CONFIG, ruleCenterConfigFromEnv } from './rule-center.config';
import { RuleCenterJobExecutors } from './rule-center.executors';
import { RuleAdminController } from './rule-admin.controller';
import { RuleAppController } from './rule-app.controller';
import { RoomNoticeController } from './room-notice.controller';
import { RuleCenterService } from './rule-center.service';

@Module({
  imports: [InfrastructureModule, SchedulerModule],
  controllers: [RuleAdminController, RuleAppController, RoomNoticeController],
  providers: [
    // 配置装配（LJR_RULE_* env > 代码默认）：RuleCenterConfig 是纯 interface，经 Symbol token
    // 工厂注入 service（@Inject(RULE_CENTER_CONFIG)）——缺此 provider 即启动期 fail-fast
    { provide: RULE_CENTER_CONFIG, useFactory: () => ruleCenterConfigFromEnv(process.env) },
    // 现行版缓存：缺省进程内实现（Ruling-3 无 Redis；TTL 安全网+写路径失效）；M2+ 可换装 Redis
    {
      provide: RULE_CURRENT_CACHE,
      useFactory: (config: { currentCacheTtlMs: number }) =>
        new InProcessRuleCurrentCache(config.currentCacheTtlMs),
      inject: [RULE_CENTER_CONFIG],
    },
    RuleCenterService,
    // RULE_EFFECTIVE 执行器经 onModuleInit 注册到 I2 执行器注册表
    RuleCenterJobExecutors,
  ],
  exports: [RuleCenterService], // H5 词库（R-03 免公示通道）等机制消费入口
})
export class RuleCenterModule {}
