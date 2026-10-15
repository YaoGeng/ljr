import { describe, expect, it } from 'vitest';
import {
  SlotViewCache,
  TIME_TABLE_CACHE_TTL_MS_DEFAULT,
  timeTableCacheConfigFromEnv,
} from './time-table.cache';

/**
 * B1 状态视图缓存纯单测（§8/R-W2-8，不需 PG）：60s 进程内 TTL 适配位——
 * TTL 内命中 / 过期失效（兜底路径）/ invalidateLawyer 主动失效（Slot* 事件消费位）/ 键隔离。
 * 事件消费端到端接线（真 Slot* 事件 → 失效 → 新读）在 time-table.spec（需 PG）覆盖。
 */

/** 假时钟：手动推进（确定性，免真实 sleep） */
function fakeClock() {
  let now = 1_000_000;
  return {
    now: (): number => now,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

describe('B1 状态视图缓存（R-W2-8：60s 进程内 TTL 适配位）', () => {
  it('默认 TTL=60s（§8 文档口径）；env 覆盖生效、非法/非正回落默认', () => {
    expect(TIME_TABLE_CACHE_TTL_MS_DEFAULT).toBe(60_000);
    expect(timeTableCacheConfigFromEnv({ LJR_TIME_TABLE_CACHE_TTL_MS: '120000' }).ttlMs).toBe(
      120_000,
    );
    expect(timeTableCacheConfigFromEnv({ LJR_TIME_TABLE_CACHE_TTL_MS: 'abc' }).ttlMs).toBe(60_000);
    expect(timeTableCacheConfigFromEnv({ LJR_TIME_TABLE_CACHE_TTL_MS: '-5' }).ttlMs).toBe(60_000);
  });

  it('TTL 内命中、过期后失效（60s TTL 兜底失效路径）', () => {
    const clock = fakeClock();
    const cache = new SlotViewCache({ ttlMs: 60_000 }, clock.now);
    const rows = [{ slotStart: new Date(0), status: 'FREE', ref: null }];
    cache.set(501, '2026-11-02', '2026-11-02', rows);
    clock.advance(59_999);
    expect(cache.get(501, '2026-11-02', '2026-11-02')).toBe(rows);
    clock.advance(1); // 恰好越界 → 过期
    expect(cache.get(501, '2026-11-02', '2026-11-02')).toBeNull();
  });

  it('invalidateLawyer 只失效该律师全部区间条目并返回条数（Slot* 事件主动失效位）', () => {
    const clock = fakeClock();
    const cache = new SlotViewCache({ ttlMs: 60_000 }, clock.now);
    cache.set(501, '2026-11-02', '2026-11-02', ['a']);
    cache.set(501, '2026-11-09', '2026-11-15', ['b']);
    cache.set(502, '2026-11-02', '2026-11-02', ['c']);
    expect(cache.invalidateLawyer(501)).toBe(2);
    expect(cache.get(501, '2026-11-02', '2026-11-02')).toBeNull();
    expect(cache.get(501, '2026-11-09', '2026-11-15')).toBeNull();
    expect(cache.get(502, '2026-11-02', '2026-11-02')).toEqual(['c']); // 他律师不受影响
    expect(cache.invalidateLawyer(501)).toBe(0); // 重投（at-least-once）幂等
  });
});
