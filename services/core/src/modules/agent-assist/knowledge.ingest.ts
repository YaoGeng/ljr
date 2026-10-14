/**
 * E3 知识库向量化同进程异步队列（§8「文档上传异步处理（≤5min）」的 dev 形态）。
 *
 * 形态论证（控制者裁决二选一，报告明示）：**同进程异步队列（setImmediate 内存队列）**而非
 * 同步直处理——§8 明文要求「异步处理」，同步直做会把向量化耗时压进上传应答（超长文档明显
 * 破坏接口语义）；dev 无 MQ（外部对接后置约定），进程内队列 + 文档状态位（PENDING→READY|
 * FAILED）是 §8 可观测性要求的最小满足。M2 换 MQ/多实例时仅替换本件（status 位语义不变，
 * 未处理文档 stay PENDING 可重放 ⚠ M2 补 requeue 机制位）。
 *
 * 可观测完成（TDD 铁律：非 sleep 等待）：waitIdle() 返回「队列空且无在途任务」的 Promise——
 * 测试/运维以回调形态等待终态，状态位轮询亦可。
 */
import type { OnApplicationShutdown } from '@nestjs/common';

export type IngestProcessor = (docId: number) => Promise<void>;

export class IngestQueue implements OnApplicationShutdown {
  private readonly ids: number[] = [];
  private inFlight = 0;
  private scheduled = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly processor: IngestProcessor) {}

  /** 入队（非阻塞）；重复入队由处理端状态位幂等挡（PENDING 检查+行锁） */
  enqueue(docId: number): void {
    this.ids.push(docId);
    this.schedule();
  }

  /** 队列空且无在途任务时 resolve（当下已 idle 则立即 resolve）；测试/观测的可观测完成口 */
  waitIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private isIdle(): boolean {
    return this.ids.length === 0 && this.inFlight === 0;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.ids.length > 0) {
      const id = this.ids.shift();
      if (id === undefined) break;
      this.inFlight += 1;
      try {
        await this.processor(id); // 失败已由处理端落 FAILED 状态+告警；队列不得被单文档毒死
      } catch {
        // 防御性兜底（processor 自身已 catch；此处保队列继续）
      } finally {
        this.inFlight -= 1;
      }
    }
    if (this.inFlight === 0) this.resolveIdle();
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** 进程关停：丢弃未处理 id（文档 stay PENDING，M2 requeue 机制位 ⚠ 见类注） */
  onApplicationShutdown(): void {
    this.ids.length = 0;
    this.resolveIdle();
  }
}
