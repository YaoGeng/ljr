/**
 * 下发驱动 worker（I1 §8「通知发送 P95 ≤2s（队列）」的进程内驱动件）：
 * interval 轮询 processPending()，形态同 OutboxRelayService——start() 仅进程入口（main.ts）调用，
 * 测试/嵌入场景直接调 NotifyDispatcherService.processPending() 手动驱动。
 */
import { Injectable, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { NotifyDispatcherService } from './notify-dispatcher.service';

function pollIntervalFromEnv(): number {
  const raw = Number(process.env.LJR_NOTIFY_DISPATCH_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000;
}

@Injectable()
export class NotifyDispatchWorker implements OnApplicationShutdown {
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dispatcher: NotifyDispatcherService,
    @Optional() options?: { readonly pollIntervalMs?: number },
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? pollIntervalFromEnv();
  }

  /** 启动后台轮询（进程入口调用；重复调用无副作用）。单轮失败不终止轮询（错误已落 last_error） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.dispatcher.processPending().catch(() => undefined);
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop();
  }
}
