/**
 * B2 时间段占用锁（M1-W1 Task 3）：slot_locks 唯一事实源（R-01 部分唯一索引物理防线）+
 * 同事务加锁/释放（R-02，uow 形态）+ TTL 自动释放 / 滥用防护（R-03）+ reaper 兜底（R-04）。
 * 施工规格：docs/modules/B-律师配置/B2-时间段占用锁.md；与 I2 同属 schedule schema owner，
 * 代码放 modules/schedule/ 下（slot-lock.* 前缀，check-schema-refs 目录→schema 约定）。
 * 机制 API 不暴露 HTTP；C1/C2/C5（M1-W3）以 uow 形态消费。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { SchedulerModule } from './scheduler.module';
import { MockSlotLockAlertSink, SlotLockAlertService } from './slot-lock.alerts';
import { SlotLockJobExecutors } from './slot-lock.executors';
import { SlotLockService } from './slot-lock.service';
import { TerminalStateRegistry } from './slot-lock.terminal-registry';

@Module({
  imports: [InfrastructureModule, SchedulerModule],
  providers: [
    // 终态判定注册表默认空表：真实 provider（session/groupbuy/reschedule）由 C1/C2/C5 落位时 register()
    TerminalStateRegistry,
    // 告警：mock 适配器（外部对接后置约定，供应商位 M2+）；测试可 override 注桩
    MockSlotLockAlertSink,
    {
      provide: SlotLockAlertService,
      useFactory: (sink: MockSlotLockAlertSink) => new SlotLockAlertService(sink),
      inject: [MockSlotLockAlertSink],
    },
    SlotLockService,
    // SLOT_TTL/SLOT_REAPER 执行器经 onModuleInit 注册到 I2 执行器注册表
    SlotLockJobExecutors,
  ],
  exports: [
    SlotLockService,
    SlotLockJobExecutors,
    TerminalStateRegistry,
    SlotLockAlertService,
    MockSlotLockAlertSink,
  ],
})
export class SlotLockModule {}
