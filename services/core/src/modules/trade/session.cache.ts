/**
 * C1 列表读缓存（§8「列表 P95 ≤300ms（缓存 30s）」）：30s 进程内 TTL 适配位（沿 W2 形态——
 * pricing.cache 台账口径同源）：①set() 顺带清扫全部过期条目；②get() 返回 structuredClone
 * 深拷贝（服务级调用者改写返回值不污染缓存）；③开团成功后主动失效全表（create 写路径调用——
 * 列表键空间是筛选元组，粗粒度 invalidateAll 最小正确；状态迁移/流标走 TTL 兜底 ≤30s 最终一致，
 * W2 缓存适配位同口径）。
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TRADE_SESSION_CONFIG, type TradeSessionConfig } from './session.config';

interface CacheEntry {
  readonly key: string;
  readonly value: unknown;
  readonly expiresAt: number;
}

@Injectable()
export class SessionListCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly clock: () => number;

  constructor(
    // 纯 interface 无运行时类型 token，须经 Symbol 注入（module useFactory 装配，pricing 同款）
    @Inject(TRADE_SESSION_CONFIG) private readonly config: TradeSessionConfig,
    // 可注入时钟（测试确定性）；@Optional：DI 上下文缺省时回落系统时钟
    @Optional() now?: () => number,
  ) {
    this.clock = now ?? (() => Date.now());
  }

  /** 观测位/测试口：当前条目数（含未过期） */
  get size(): number {
    return this.entries.size;
  }

  /** TTL 内命中返回深拷贝；过期惰性清除返回 null */
  get<T>(key: string): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (this.clock() >= hit.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return structuredClone(hit.value) as T;
  }

  set(key: string, value: unknown): void {
    this.sweepExpired(); // 顺带清扫（防累积；条目量=活跃筛选组合数，遍历代价可忽略）
    this.entries.set(key, { key, value, expiresAt: this.clock() + this.config.listCacheTtlMs });
  }

  /** 写路径主动失效（create 成功后调用）：清空全部列表条目。天然幂等 */
  invalidateAll(): number {
    const n = this.entries.size;
    this.entries.clear();
    return n;
  }

  private sweepExpired(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}
