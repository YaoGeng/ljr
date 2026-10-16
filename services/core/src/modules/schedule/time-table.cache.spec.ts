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
 * G-B 做项3 对齐 B3/G1 形态：过期条目清扫（set 顺带）+ 出站深拷贝（调用者改写不污染缓存）。
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
    expect(cache.get(501, '2026-11-02', '2026-11-02')).toEqual(rows);
    clock.advance(1); // 恰好越界 → 过期
    expect(cache.get(501, '2026-11-02', '2026-11-02')).toBeNull();
  });

  it('出站防御拷贝（G-B 做项3②）：改写 get 返回对象不影响缓存内容（deep）', () => {
    const clock = fakeClock();
    const cache = new SlotViewCache({ ttlMs: 60_000 }, clock.now);
    const rows = [
      { slotStart: new Date(0), status: 'FREE', ref: null },
      { slotStart: new Date(1), status: 'LOCKED', ref: { refType: 'session', refId: 1 } },
    ];
    const expected = structuredClone(rows); // 快照：与缓存值、被改写引用三方独立
    cache.set(501, '2026-11-02', '2026-11-02', rows);
    const got = cache.get<{ slotStart: Date; status: string; ref: unknown }[]>(
      501,
      '2026-11-02',
      '2026-11-02',
    )!;
    got[0]!.status = 'OCCUPIED';
    (got[1]!.ref as { refId: number }).refId = 999;
    got.push({ slotStart: new Date(2), status: 'FREE', ref: null });
    expect(cache.get(501, '2026-11-02', '2026-11-02')).toEqual(expected); // 缓存原值未污染
  });

  it('set() 顺带清扫全部过期条目（G-B 做项3①，防进程内存活期累积）', () => {
    const clock = fakeClock();
    const cache = new SlotViewCache({ ttlMs: 60_000 }, clock.now);
    cache.set(1, '2026-11-02', '2026-11-02', ['a']);
    cache.set(2, '2026-11-02', '2026-11-02', ['b']);
    expect(cache.size).toBe(2);
    clock.advance(61_000); // 两条全过期
    cache.set(3, '2026-11-02', '2026-11-02', ['c']); // 写入触发清扫
    expect(cache.size).toBe(1);
    expect(cache.get(3, '2026-11-02', '2026-11-02')).toEqual(['c']);
    expect(cache.get(1, '2026-11-02', '2026-11-02')).toBeNull();
    expect(cache.get(2, '2026-11-02', '2026-11-02')).toBeNull();
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
