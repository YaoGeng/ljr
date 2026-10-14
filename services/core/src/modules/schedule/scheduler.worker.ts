/**
 * 调度节拍器 worker（ADR-0003：进程内 interval 轮询，仅内存态节拍非事实源——正确性不依赖它，
 * 实例全宕重启后逾期 PENDING 由扫描自然捞取补执行）。双通道：
 *   priority — ROOM_OPEN 独立高优先级，周期 ≤5s（§4/§8，默认 5s）；
 *   normal   — 其余类型，周期 10-15s（默认 12s）。
 * start() 仅进程入口（main.ts）调用；测试/嵌入场景直接调 SchedulerService.tick() 手动驱动，
 * 调度器不自启动（避免 interval 干扰 vitest）。单轮失败不终止轮询（形态同 OutboxRelayService）。
 */
import { Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
// SchedulerService 须 value import（DI 元数据按构造参数类型解析，type-only import 会被擦除）
import { SchedulerService } from './scheduler.service';
import { schedulerConfigFromEnv } from './scheduler.config';

function intervalFromEnv(key: string, fallback: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

@Injectable()
export class SchedulerWorker implements OnApplicationShutdown {
  private readonly normalIntervalMs: number;
  private readonly priorityIntervalMs: number;
  private normalTimer: ReturnType<typeof setInterval> | null = null;
  private priorityTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly scheduler: SchedulerService,
    @Optional()
    options?: { readonly normalIntervalMs?: number; readonly priorityIntervalMs?: number },
  ) {
    const config = schedulerConfigFromEnv();
    this.normalIntervalMs =
      options?.normalIntervalMs ??
      intervalFromEnv('LJR_SCHEDULER_NORMAL_INTERVAL_MS', config.normalIntervalMs);
    this.priorityIntervalMs =
      options?.priorityIntervalMs ??
      intervalFromEnv('LJR_SCHEDULER_PRIORITY_INTERVAL_MS', config.priorityIntervalMs);
  }

  /** 启动双通道轮询（进程入口调用；重复调用无副作用）。单轮失败不终止轮询 */
  start(): void {
    if (this.normalTimer) return;
    this.normalTimer = setInterval(() => {
      void this.scheduler.tick('normal').catch(() => undefined);
    }, this.normalIntervalMs);
    this.priorityTimer = setInterval(() => {
      void this.scheduler.tick('priority').catch(() => undefined);
    }, this.priorityIntervalMs);
  }

  stop(): void {
    if (this.normalTimer) {
      clearInterval(this.normalTimer);
      this.normalTimer = null;
    }
    if (this.priorityTimer) {
      clearInterval(this.priorityTimer);
      this.priorityTimer = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop();
  }
}
