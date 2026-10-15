import { describe, expect, it } from 'vitest';
import {
  PRICING_CACHE_TTL_MS_DEFAULT,
  CurrentPricingCache,
  pricingCacheConfigFromEnv,
  type PricingCacheConfig,
} from './pricing.cache';

/**
 * B3 当前版本读缓存（§8/R-W2-8：60s 进程内 TTL 适配位，写后失效）。
 * 假时钟确定性；另钉两条台账顺延项的修正形态：过期条目清扫（T4 minor ②）与
 * 出站防御拷贝（T4 minor ③——服务级调用者改返回值不得污染缓存）。
 */

const view = (version: number) => ({
  version,
  created_at: '2026-10-16T00:00:00.000Z',
  pricing: { per_head: '80.00', session_total: null },
});

describe('B3 当前版本缓存（TTL 命中/过期/主动失效）', () => {
  it('TTL 内命中；过期后惰性清除返回 null', () => {
    let now = 1_000;
    const cache = new CurrentPricingCache({ ttlMs: 60_000 }, () => now);
    cache.set(9101, view(1) as never);
    expect(cache.get(9101)).toEqual(view(1));
    now += 59_999;
    expect(cache.get(9101)).toEqual(view(1));
    now += 1;
    expect(cache.get(9101)).toBeNull();
  });

  it('set() 顺带清扫全部过期条目（防进程内存活期累积）', () => {
    let now = 1_000;
    const cache = new CurrentPricingCache({ ttlMs: 60_000 }, () => now);
    cache.set(1, view(1) as never);
    cache.set(2, view(2) as never);
    expect(cache.size).toBe(2);
    now += 61_000; // 两条全过期
    cache.set(3, view(3) as never); // 写入触发清扫
    expect(cache.size).toBe(1);
    expect(cache.get(3)).toEqual(view(3));
    expect(cache.get(1)).toBeNull();
    expect(cache.get(2)).toBeNull();
  });

  it('invalidateLawyer 定向失效并返回失效条数；他律师条目不受影响（天然幂等）', () => {
    const cache = new CurrentPricingCache({ ttlMs: 60_000 }, () => 1_000);
    cache.set(9101, view(1) as never);
    cache.set(9102, view(2) as never);
    expect(cache.invalidateLawyer(9101)).toBe(1);
    expect(cache.get(9101)).toBeNull();
    expect(cache.get(9102)).toEqual(view(2));
    expect(cache.invalidateLawyer(9101)).toBe(0); // 重投零副作用
  });

  it('出站防御拷贝：改写 get 返回对象不影响缓存内容（deep）', () => {
    const cache = new CurrentPricingCache({ ttlMs: 60_000 }, () => 1_000);
    cache.set(9101, view(7) as never);
    const got = cache.get<{ version: number; pricing: { per_head: string } }>(9101)!;
    got.pricing.per_head = '1.00';
    got.version = 999;
    expect(cache.get(9101)).toEqual(view(7));
  });
});

describe('B3 缓存配置装载（env > 代码默认；非法回落默认，不抛）', () => {
  it('默认 60s；LJR_PRICING_CACHE_TTL_MS 覆盖；非法/非正回落默认', () => {
    expect(pricingCacheConfigFromEnv({}).ttlMs).toBe(PRICING_CACHE_TTL_MS_DEFAULT);
    expect(pricingCacheConfigFromEnv({ LJR_PRICING_CACHE_TTL_MS: '250' }).ttlMs).toBe(250);
    expect(pricingCacheConfigFromEnv({ LJR_PRICING_CACHE_TTL_MS: 'abc' }).ttlMs).toBe(
      PRICING_CACHE_TTL_MS_DEFAULT,
    );
    expect(pricingCacheConfigFromEnv({ LJR_PRICING_CACHE_TTL_MS: '0' }).ttlMs).toBe(
      PRICING_CACHE_TTL_MS_DEFAULT,
    );
  });

  it('PricingCacheConfig 形状钉死（DI Symbol token 装配契约）', () => {
    const config: PricingCacheConfig = { ttlMs: 1_000 };
    expect(config.ttlMs).toBe(1_000);
  });
});
