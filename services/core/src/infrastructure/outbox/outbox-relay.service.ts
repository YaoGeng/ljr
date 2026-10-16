/**
 * Outbox relay（M0-4）：独立轮询 at-least-once 投递，重试上限 → 死信表。
 *
 * 语义（架构 §5.1 outbox + §4.5 SKIP LOCKED 抢占模式 / task-3 锁定接口）：
 *   - 每 tick 逐条拾取（FOR UPDATE SKIP LOCKED 抢占，多实例安全），至多 batch 条；
 *   - handler 成功才标记 SENT（handler 效果与 SENT 标记同一事务提交）；
 *   - handler 失败：回滚 handler 写入，retry_count+1、记录 last_error、next_retry_at 按 backoff 推后；
 *   - retry_count 超过 maxRetry（尝试次数 = 1 + maxRetry）→ status=DEAD + 落 outbox_dead_letter；
 *   - at-least-once ≠ 恰好一次：崩溃窗口内可能重复投递，消费侧必须自带幂等键防重（Review Focus #4）。
 *
 * Nest 集成：后台轮询服务（interval 可配，测试手动 tick()）；
 * `start()` 仅在进程入口（main.ts）调用，测试/嵌套场景直接调 `tick()`。
 *
 * 同 topic 多 handler 扇出（M1-W3 T3 扩展，向后兼容）：registerHandler 追加不覆盖——一事件
 * 可被多模块消费（A3b 消费 LawyerAuditPassed 与 A1 授角色并存的前提）；任一 handler 失败
 * 整体回滚进重试轨道，重投时全部 handler 重跑（at-least-once 语义内，消费方自带幂等）。
 */
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import { Pool } from 'pg';
import type { SqlExecutor } from '../sql';
import { PgPoolService } from '../sql';

export interface RelayEvent {
  readonly id: number;
  readonly eventId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly retryCount: number;
}

/** 消费者：uow = relay 认领事务的 client（消费效果与 SENT 标记同事务；也可忽略 uow 做外部副作用） */
export type OutboxHandler = (event: RelayEvent, uow: SqlExecutor) => Promise<void>;

export interface OutboxRelayOptions {
  /** 单次 tick 至多处理条数（默认 10） */
  readonly batch?: number;
  /** 重试上限（总尝试 = 1 + maxRetry，默认 5） */
  readonly maxRetry?: number;
  /** 第 retryCount 次重试的退避毫秒（默认 30s 起、指数翻倍、封顶 1h） */
  readonly backoffMs?: (retryCount: number) => number;
  /** start() 轮询间隔毫秒（env LJR_OUTBOX_RELAY_INTERVAL_MS，默认 1000） */
  readonly pollIntervalMs?: number;
}

export interface RelayTickResult {
  readonly dispatched: number;
  readonly retried: number;
  readonly dead: number;
}

const defaultBackoffMs = (retryCount: number): number =>
  Math.min(30_000 * 2 ** (retryCount - 1), 3_600_000);

function pollIntervalFromEnv(): number {
  const raw = Number(process.env.LJR_OUTBOX_RELAY_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000;
}

@Injectable()
export class OutboxRelayService implements OnApplicationShutdown {
  private readonly store: PgPoolService;
  private readonly batch: number;
  private readonly maxRetry: number;
  private readonly backoffMs: (retryCount: number) => number;
  private readonly pollIntervalMs: number;
  /** topic → handler 列表（同 topic 多 handler 扇出：追加不覆盖，注册序即执行序） */
  private readonly handlers = new Map<string, OutboxHandler[]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: Pool | PgPoolService, options: OutboxRelayOptions = {}) {
    this.store = store instanceof Pool ? new PgPoolService(store) : store;
    this.batch = options.batch ?? 10;
    this.maxRetry = options.maxRetry ?? 5;
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.pollIntervalMs = options.pollIntervalMs ?? pollIntervalFromEnv();
  }

  registerHandler(topic: string, handler: OutboxHandler): this {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
    return this;
  }

  /** 启动后台轮询（进程入口调用；重复调用无副作用） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined); // 单轮失败不终止轮询；异常细节已落 outbox.last_error
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

  /** 单轮投递（测试手动驱动；返回本轮计数） */
  async tick(): Promise<RelayTickResult> {
    let dispatched = 0;
    let retried = 0;
    let dead = 0;
    // 单调 id 游标：本轮内已尝试过的事件（含失败退避的）不再重复拾取 ——
    // 「一个 tick 对一个事件至多投递一次」，零退避配置下也不会同轮热循环烧 batch。
    let cursor = 0;

    for (let i = 0; i < this.batch; i += 1) {
      const client = await this.store.pool.connect();
      let done = false;
      try {
        await client.query('BEGIN');
        const claimed = await client.query<{
          id: string;
          event_id: string;
          topic: string;
          payload: unknown;
          retry_count: number;
        }>(
          `SELECT id, event_id::text AS event_id, topic, payload, retry_count
             FROM platform.outbox
            WHERE status = 'PENDING' AND next_retry_at <= now() AND id > $1
            ORDER BY id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [cursor],
        );
        const row = claimed.rows[0];
        if (!row) {
          await client.query('COMMIT'); // 空轮/均被抢占
          break;
        }
        cursor = Number(row.id);
        const event: RelayEvent = {
          id: Number(row.id),
          eventId: row.event_id,
          topic: row.topic,
          payload: row.payload,
          retryCount: row.retry_count,
        };

        try {
          const handlers = this.handlers.get(event.topic);
          if (!handlers || handlers.length === 0) {
            throw new AppError(
              ErrorCode.OutboxHandlerFailed,
              `no handler registered for topic ${event.topic}（事件将进入重试轨道，不静默丢弃）`,
            );
          }
          for (const handler of handlers) {
            await handler(event, client); // 消费效果与 SENT 同事务；扇出按注册序依次执行
          }
          await client.query(
            `UPDATE platform.outbox SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = $1`,
            [event.id],
          );
          await client.query('COMMIT');
          dispatched += 1;
          done = true;
        } catch (err) {
          await client.query('ROLLBACK'); // 丢弃 handler 的部分写入
          const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          const newRetry = event.retryCount + 1;
          await client.query('BEGIN');
          if (newRetry > this.maxRetry) {
            await client.query(
              `UPDATE platform.outbox SET status = 'DEAD', retry_count = $2, last_error = $3 WHERE id = $1`,
              [event.id, newRetry, message],
            );
            await client.query(
              `INSERT INTO platform.outbox_dead_letter
                 (outbox_id, event_id, topic, payload, retry_count, last_error)
               VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6)`,
              [
                event.id,
                event.eventId,
                event.topic,
                JSON.stringify(event.payload ?? null),
                newRetry,
                message,
              ],
            );
            dead += 1;
          } else {
            await client.query(
              `UPDATE platform.outbox
                  SET retry_count = $2, last_error = $3,
                      next_retry_at = now() + ($4::bigint * interval '1 millisecond')
                WHERE id = $1`,
              [event.id, newRetry, message, this.backoffMs(newRetry)],
            );
            retried += 1;
          }
          await client.query('COMMIT');
          done = true;
        }
      } finally {
        if (!done) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // 连接级异常：事务已随连接失效
          }
        }
        client.release();
      }
    }
    return { dispatched, retried, dead };
  }
}
