/**
 * B1 状态视图缓存（§8/R-W2-8 决策位）：60s 进程内 TTL 适配位（无 Redis——W2-8：dev 环境无
 * Redis，prod 换装 Redis 同接口的适配位）。失效双通道：Slot* 事件消费主动失效（time-table.consumer）
 * + TTL 过期兜底（§10-3 最终一致 ≤60s 语义的实现载体）。纯内存键值：键=(lawyerId, from, to)。
 *
 * 形态对齐 pricing.cache/credit.cache（G-B 做项3，M-3）：
 *   ① set() 顺带清扫全部过期条目（防进程内存活期无界累积）；
 *   ② get() 返回 structuredClone 深拷贝（服务级调用者改写返回值不污染缓存）。
 */
import { Inject, Injectable, type InjectionToken, Optional } from '@nestjs/common';

export interface TimeTableCacheConfig {
  /** 视图缓存 TTL 毫秒（§8：60s）⚠决策位 W2-8 */
  readonly ttlMs: number;
}

/** DI 令牌（SLOT_LOCK_CONFIG 同款 Symbol 口径：纯 interface 无运行时类型 token） */
export const TIME_TABLE_CACHE_CONFIG: InjectionToken<TimeTableCacheConfig> =
  Symbol('TIME_TABLE_CACHE_CONFIG');

/** 默认 TTL=§8 文档口径 60s */
export const TIME_TABLE_CACHE_TTL_MS_DEFAULT = 60_000;

/** env > 代码默认；非法/非正回落默认（配置容错，slot-lock.config 同款不抛） */
export function timeTableCacheConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TimeTableCacheConfig {
  const raw = Number(env['LJR_TIME_TABLE_CACHE_TTL_MS']);
  return {
    ttlMs: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : TIME_TABLE_CACHE_TTL_MS_DEFAULT,
  };
}

interface CacheEntry {
  readonly lawyerId: number;
  readonly from: string;
  readonly to: string;
  readonly value: unknown;
  readonly expiresAt: number;
}

@Injectable()
export class SlotViewCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly clock: () => number;

  constructor(
    // 纯 interface 无运行时类型 token，须经 Symbol 注入（module useFactory 装配；slot-lock 同款）
    @Inject(TIME_TABLE_CACHE_CONFIG) private readonly config: TimeTableCacheConfig,
    // 可注入时钟（测试确定性）；@Optional：DI 上下文缺省时回落系统时钟
    @Optional() now?: () => number,
  ) {
    this.clock = now ?? (() => Date.now());
  }

  private key(lawyerId: number, from: string, to: string): string {
    return `${lawyerId}|${from}|${to}`;
  }

  /** 观测位/测试口：当前条目数（含未过期） */
  get size(): number {
    return this.entries.size;
  }

  /** TTL 内命中返回深拷贝（防调用者污染缓存）；过期惰性清除返回 null */
  get<T>(lawyerId: number, from: string, to: string): T | null {
    const key = this.key(lawyerId, from, to);
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (this.clock() >= hit.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return structuredClone(hit.value) as T;
  }

  set(lawyerId: number, from: string, to: string, value: unknown): void {
    this.sweepExpired(); // 顺带清扫（G-B 做项3①防累积；条目量=被查询过的律师区间数，遍历代价可忽略）
    this.entries.set(this.key(lawyerId, from, to), {
      lawyerId,
      from,
      to,
      value,
      expiresAt: this.clock() + this.config.ttlMs,
    });
  }

  /**
   * Slot* 事件主动失效（SlotLocked/SlotReleased/SlotTtlExpired → 本方法）：
   * 失效该律师全部区间条目，返回失效条数（观测位）。天然幂等——at-least-once 重投零副作用。
   */
  invalidateLawyer(lawyerId: number): number {
    let evicted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.lawyerId === lawyerId) {
        this.entries.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  private sweepExpired(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}
