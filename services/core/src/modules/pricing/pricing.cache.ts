/**
 * B3 当前版本读缓存（§8/R-W2-8 决策位）：60s 进程内 TTL 适配位（无 Redis——dev 环境无 Redis，
 * prod 换装 Redis 同接口的适配位）。键=lawyerId（当前版本一行），写路径成功后主动失效
 * （pricing.service putPricing）+ TTL 过期兜底（外部写方场景最终一致 ≤60s 语义的载体）。
 *
 * 相对 time-table.cache 形态的两处台账修正（M1-W2 顺延 minor，本批落实）：
 *   ① set() 顺带清扫全部过期条目（防进程内存活期无界累积）；
 *   ② get() 返回 structuredClone 深拷贝（服务级调用者改写返回值不污染缓存）。
 */
import { Inject, Injectable, Optional, type InjectionToken } from '@nestjs/common';

export interface PricingCacheConfig {
  /** 当前版本缓存 TTL 毫秒（§8：60s）⚠决策位 W2-8 */
  readonly ttlMs: number;
}

/** DI 令牌（TIME_TABLE_CACHE_CONFIG 同款 Symbol 口径：纯 interface 无运行时类型 token） */
export const PRICING_CACHE_CONFIG: InjectionToken<PricingCacheConfig> =
  Symbol('PRICING_CACHE_CONFIG');

/** 默认 TTL=§8 文档口径 60s */
export const PRICING_CACHE_TTL_MS_DEFAULT = 60_000;

/** env > 代码默认；非法/非正回落默认（配置容错，time-table.cache 同款不抛） */
export function pricingCacheConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PricingCacheConfig {
  const raw = Number(env['LJR_PRICING_CACHE_TTL_MS']);
  return {
    ttlMs: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : PRICING_CACHE_TTL_MS_DEFAULT,
  };
}

interface CacheEntry {
  readonly lawyerId: number;
  readonly value: unknown;
  readonly expiresAt: number;
}

@Injectable()
export class CurrentPricingCache {
  private readonly entries = new Map<number, CacheEntry>();
  private readonly clock: () => number;

  constructor(
    // 纯 interface 无运行时类型 token，须经 Symbol 注入（module useFactory 装配，time-table 同款）
    @Inject(PRICING_CACHE_CONFIG) private readonly config: PricingCacheConfig,
    // 可注入时钟（测试确定性）；@Optional：DI 上下文缺省时回落系统时钟
    @Optional() now?: () => number,
  ) {
    this.clock = now ?? (() => Date.now());
  }

  /** 观测位/测试口：当前条目数（含未过期） */
  get size(): number {
    return this.entries.size;
  }

  /** TTL 内命中返回深拷贝（防调用者污染缓存）；过期惰性清除返回 null */
  get<T>(lawyerId: number): T | null {
    const hit = this.entries.get(lawyerId);
    if (!hit) return null;
    if (this.clock() >= hit.expiresAt) {
      this.entries.delete(lawyerId);
      return null;
    }
    return structuredClone(hit.value) as T;
  }

  set(lawyerId: number, value: unknown): void {
    this.sweepExpired(); // 顺带清扫（①防累积；条目量=活跃律师数，遍历代价可忽略）
    this.entries.set(lawyerId, {
      lawyerId,
      value,
      expiresAt: this.clock() + this.config.ttlMs,
    });
  }

  /** 写路径主动失效（putPricing 成功后调用）：失效该律师条目，返回失效条数（观测位）。天然幂等 */
  invalidateLawyer(lawyerId: number): number {
    return this.entries.delete(lawyerId) ? 1 : 0;
  }

  private sweepExpired(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}
