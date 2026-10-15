import { describe, expect, it } from 'vitest';
import {
  CreditRestrictionCache,
  CREDIT_CACHE_TTL_MS_DEFAULT,
  creditCacheConfigFromEnv,
} from './credit.cache';
import type { RestrictionView } from './credit.types';

/**
 * G1 活跃限制令 30s 进程内缓存适配位单测（假时钟，§8/R-W2-8）：
 * TTL 过期惰性清除 + set 顺带清扫过期条目（台账顺延 minor 修正形态，pricing.cache 同款）+
 * get 深拷贝（服务级调用者改写返回值不污染缓存）+ env 配置容错。
 * 热路径语义：入口校验查询 P95 ≤20ms（§8）——无限制令的干净 owner 也缓存空数组（防穿透）。
 */

const view = (id: number, kind: string): RestrictionView =>
  ({
    id,
    kind,
    until: '2026-10-23T00:00:00.000Z',
    reason: 'test',
    created_at: '2026-10-16T00:00:00.000Z',
  }) as RestrictionView;

describe('G1 活跃限制令缓存适配位（30s TTL，假时钟）', () => {
  it('env 配置：LJR_CREDIT_CACHE_TTL_MS 优先，非法/非正回落默认 30000', () => {
    expect(creditCacheConfigFromEnv({ LJR_CREDIT_CACHE_TTL_MS: '500' }).ttlMs).toBe(500);
    expect(creditCacheConfigFromEnv({ LJR_CREDIT_CACHE_TTL_MS: '-1' }).ttlMs).toBe(
      CREDIT_CACHE_TTL_MS_DEFAULT,
    );
    expect(creditCacheConfigFromEnv({ LJR_CREDIT_CACHE_TTL_MS: 'abc' }).ttlMs).toBe(
      CREDIT_CACHE_TTL_MS_DEFAULT,
    );
    expect(creditCacheConfigFromEnv({}).ttlMs).toBe(CREDIT_CACHE_TTL_MS_DEFAULT);
  });

  it('TTL 内命中 / 过期惰性清除返回 null；set 顺带清扫全部过期条目（防存活期无界累积）', () => {
    let now = 1_000_000;
    const cache = new CreditRestrictionCache({ ttlMs: 30_000 }, () => now);
    const key = { ownerType: 'user' as const, ownerId: 601 };

    cache.set(key, [view(1, 'BAN_JOIN')]);
    expect(cache.get<RestrictionView[]>(key)).toHaveLength(1);

    now += 29_999; // TTL 边界内仍命中
    expect(cache.get<RestrictionView[]>(key)).toHaveLength(1);

    now += 2; // 过期：惰性清除
    expect(cache.get<RestrictionView[]>(key)).toBeNull();

    cache.set(key, [view(2, 'BAN_PUBLISH')]);
    cache.set({ ownerType: 'lawyer', ownerId: 9101 }, [view(3, 'SUSPEND_TAKE_3D')]);
    now += 40_000; // 两条全过期
    cache.set({ ownerType: 'user', ownerId: 602 }, []); // 触发清扫
    expect(cache.size).toBe(1); // 过期条目已清，仅存新写入
  });

  it('get 返回深拷贝：调用者改写返回值不污染缓存（empty 数组同样防穿透缓存）', () => {
    const now = 1_000_000;
    const cache = new CreditRestrictionCache({ ttlMs: 30_000 }, () => now);
    const key = { ownerType: 'lawyer' as const, ownerId: 9101 };

    cache.set(key, [view(1, 'BAN_JOIN')]);
    const first = cache.get<RestrictionView[]>(key);
    first!.push(view(999, 'SUSPEND_TAKE_7D')); // 数组身份可变（深拷贝隔离断言点）
    expect(cache.get<RestrictionView[]>(key)).toEqual([view(1, 'BAN_JOIN')]);

    cache.set({ ownerType: 'user', ownerId: 601 }, []);
    const empty = cache.get<RestrictionView[]>({ ownerType: 'user', ownerId: 601 });
    empty!.push(view(998, 'BAN_JOIN'));
    expect(cache.get<RestrictionView[]>({ ownerType: 'user', ownerId: 601 })).toEqual([]);
  });

  it('invalidateOwner：写路径主动失效（发行限制令后调用），天然幂等', () => {
    const cache = new CreditRestrictionCache({ ttlMs: 30_000 });
    const key = { ownerType: 'user' as const, ownerId: 601 };
    cache.set(key, [view(1, 'BAN_JOIN')]);
    expect(cache.invalidateOwner(key)).toBe(1);
    expect(cache.get<RestrictionView[]>(key)).toBeNull();
    expect(cache.invalidateOwner(key)).toBe(0);
  });
});
