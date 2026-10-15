/**
 * G1 活跃限制令读缓存（§8/R-W2-8 决策位）：30s 进程内 TTL 适配位（无 Redis——dev 环境无 Redis，
 * prod 换装 Redis 同接口的适配位）。键=owner_type+owner_id（入口校验查询面一行），限制令发行
 * 路径主动失效（credit.service emit）+ TTL 过期兜底（外部写方场景最终一致 ≤30s 语义的载体）。
 *
 * 形态=pricing.cache（M1-W2 台账顺延 minor 已修正的两处本批直接继承）：
 *   ① set() 顺带清扫全部过期条目（防进程内存活期无界累积）；
 *   ② get() 返回 structuredClone 深拷贝（服务级调用者改写返回值不污染缓存）。
 * 热路径（§8 入口校验 P95 ≤20ms）：无限制令的干净 owner 缓存空数组防穿透。
 * 惰性失效（§3）：缓存行可能自然到期——读侧按 until>now 过滤（credit.service），缓存条目
 * 本身至多存活 TTL 窗口，双保险；until 比对用应用时钟与 DB 时钟微漂移由 30s TTL 界内吸收。
 */
import { Inject, Injectable, Optional, type InjectionToken } from '@nestjs/common';
import type { OwnerType, RestrictionView } from './credit.types';

export interface CreditCacheConfig {
  /** 活跃限制令缓存 TTL 毫秒（§8：30s）⚠决策位 R-W2-8 */
  readonly ttlMs: number;
}

/** DI 令牌（PRICING_CACHE_CONFIG 同款 Symbol 口径：纯 interface 无运行时类型 token） */
export const CREDIT_CACHE_CONFIG: InjectionToken<CreditCacheConfig> = Symbol('CREDIT_CACHE_CONFIG');

/** 默认 TTL=§8 文档口径 30s */
export const CREDIT_CACHE_TTL_MS_DEFAULT = 30_000;

/** env > 代码默认；非法/非正回落默认（配置容错，pricing.cache 同款不抛） */
export function creditCacheConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CreditCacheConfig {
  const raw = Number(env['LJR_CREDIT_CACHE_TTL_MS']);
  return {
    ttlMs: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : CREDIT_CACHE_TTL_MS_DEFAULT,
  };
}

/** 缓存键（owner 二元组；对象形态避免拼串歧义） */
export interface OwnerKey {
  readonly ownerType: OwnerType;
  readonly ownerId: number;
}

interface CacheEntry {
  readonly key: OwnerKey;
  readonly value: unknown;
  readonly expiresAt: number;
}

function keyOf(k: OwnerKey): string {
  return `${k.ownerType}:${k.ownerId}`;
}

@Injectable()
export class CreditRestrictionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly clock: () => number;

  constructor(
    // 纯 interface 无运行时类型 token，须经 Symbol 注入（module useFactory 装配，pricing 同款）
    @Inject(CREDIT_CACHE_CONFIG) private readonly config: CreditCacheConfig,
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
  get<T>(key: OwnerKey): T | null {
    const hit = this.entries.get(keyOf(key));
    if (!hit) return null;
    if (this.clock() >= hit.expiresAt) {
      this.entries.delete(keyOf(key));
      return null;
    }
    return structuredClone(hit.value) as T;
  }

  set(key: OwnerKey, value: readonly RestrictionView[]): void {
    this.sweepExpired(); // 顺带清扫（①防累积；条目量=被查询过的 owner 数，遍历代价可忽略）
    this.entries.set(keyOf(key), {
      key,
      value,
      expiresAt: this.clock() + this.config.ttlMs,
    });
  }

  /** 写路径主动失效（emit 发行限制令后调用）：失效该 owner 条目，返回失效条数（观测位）。天然幂等 */
  invalidateOwner(key: OwnerKey): number {
    return this.entries.delete(keyOf(key)) ? 1 : 0;
  }

  private sweepExpired(): void {
    const now = this.clock();
    for (const [k, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(k);
    }
  }
}
