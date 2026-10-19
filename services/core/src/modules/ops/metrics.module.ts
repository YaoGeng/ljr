/**
 * H4 数据看板·指标管道模块（M2-W2 T8）：ops schema owner（V46 两表——events_consumed
 * 去重表 + metrics_daily 日表），代码位 modules/ops/metrics.*（与 patrol/ticket 平级子模块）。
 *
 * 边界（02 §3.2 / schema-refs 0 为门）：指标口径=02 §7.2 映射表，来源列的表语义由
 * **事件**承载（02 §7.2 表头「业务指标经事件流实时聚合」）——本模块只读/写 ops 两表；
 * 跨域真源仅一处=补偿发放率分母（comp_snapshots 计数，pricing 域导出面
 * PriceChangeService.countCompSnapshotsBetween——patrol 检测件各域自持先例同款）。
 * 巡检（RISK_PATROL 五类）=patrol.* 既有模块，本批零改动（git diff 断言）。
 *
 * 依赖（单向叶子方向，无环）：InfrastructureModule（pool/relay/outbox 基座）+
 * IdentityAuthModule（JWT 守卫件叶子）+ PricingChangeModule（C6：补偿分母导出面）。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { PricingChangeModule } from '../pricing/price-change.module';
import { MetricsConsumer } from './metrics.consumer';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [InfrastructureModule, IdentityAuthModule, PricingChangeModule],
  controllers: [MetricsController],
  providers: [MetricsService, MetricsConsumer],
  exports: [MetricsService], // 后续 I1/运营页面扩装复用入口（本批无外部消费方）
})
export class MetricsModule {}
