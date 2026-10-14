import { describe, expect, it } from 'vitest';
import { SLOT_LOCK_DEFAULT_CONFIG, slotLockConfigFromEnv } from './slot-lock.config';

/**
 * B2 配置装载纯单元（口径同 scheduler.config.spec/notify）：默认值=文档口径（§2/§8），
 * env 覆盖生效，非法值回落默认。
 */
describe('slot-lock 配置', () => {
  it('默认值=文档口径：TTL 10min / reaper 5min / 终态超阈 15min', () => {
    expect(SLOT_LOCK_DEFAULT_CONFIG).toEqual({
      ttlMs: 600_000,
      reaperIntervalMs: 300_000,
      staleMs: 900_000,
    });
    expect(slotLockConfigFromEnv({})).toEqual(SLOT_LOCK_DEFAULT_CONFIG);
  });

  it('env 覆盖生效（LJR_SLOT_LOCK_*）', () => {
    expect(
      slotLockConfigFromEnv({
        LJR_SLOT_LOCK_TTL_MS: '120000',
        LJR_SLOT_LOCK_REAPER_INTERVAL_MS: '60000',
        LJR_SLOT_LOCK_STALE_MS: '300000',
      }),
    ).toEqual({ ttlMs: 120_000, reaperIntervalMs: 60_000, staleMs: 300_000 });
  });

  it('非法/非正值回落默认（不抛，配置容错口径同 scheduler）', () => {
    expect(
      slotLockConfigFromEnv({
        LJR_SLOT_LOCK_TTL_MS: 'abc',
        LJR_SLOT_LOCK_REAPER_INTERVAL_MS: '-5',
        LJR_SLOT_LOCK_STALE_MS: '0',
      }),
    ).toEqual(SLOT_LOCK_DEFAULT_CONFIG);
  });
});
