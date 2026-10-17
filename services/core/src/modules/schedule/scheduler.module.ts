/**
 * I2 调度中心（M1-W1）：schedule_jobs 到期任务表事实源（R-01）+ SKIP LOCKED 抢占 + 执行器幂等回查（R-02）
 * + ROOM_OPEN 高优先级通道与准点告警（R-03）+ schedule_job_log 可重放（R-04）。
 * 施工规格：docs/modules/I-平台支撑/I2-调度中心.md；ADR-0003（自研 TS 调度器，与 Core 同进程）。
 * 只写 schedule.* 表（边界纪律）；I2 只做机制不做业务——真实执行器由各业务模块 register() 注册。
 */
import { Module } from '@nestjs/common';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { IdentityAuthModule } from '../identity/identity-auth.module';
import { SchedulerAdminController } from './scheduler-admin.controller';
import { ScheduleExecutorRegistry } from './scheduler-executor.registry';
import { MockPhoneAlertSink, SchedulerAlertService } from './scheduler-alerts';
import { SchedulerService } from './scheduler.service';
import { SchedulerWorker } from './scheduler.worker';

@Module({
  // IdentityAuthModule（叶子）：/admin/scheduler/jobs 运维视图的 JWT/角色守卫件（W3 T10 G-A 接线）
  imports: [InfrastructureModule, IdentityAuthModule],
  controllers: [SchedulerAdminController],
  providers: [
    // 执行器注册表默认空表：真实执行器（SLOT_*、RULE_EFFECTIVE 等）由后续任务经 register() 注册
    ScheduleExecutorRegistry,
    // 告警：电话告警 mock 适配器（外部对接后置约定，供应商位 M2+）；测试可 override MockPhoneAlertSink 注桩
    MockPhoneAlertSink,
    {
      provide: SchedulerAlertService,
      useFactory: (sink: MockPhoneAlertSink) => new SchedulerAlertService(sink),
      inject: [MockPhoneAlertSink],
    },
    SchedulerService,
    SchedulerWorker, // start() 仅 main.ts 调用——调度器不自启动（测试隔离）
  ],
  exports: [
    SchedulerService,
    ScheduleExecutorRegistry,
    SchedulerAlertService,
    MockPhoneAlertSink,
    SchedulerWorker,
  ],
})
export class SchedulerModule {}
