import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SLOT_LOCK_CONFIG,
  SLOT_LOCK_DEFAULT_CONFIG,
  slotLockConfigFromEnv,
  type SlotLockConfig,
} from './slot-lock.config';
import { SlotLockModule } from './slot-lock.module';
import { SlotLockService } from './slot-lock.service';

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

/**
 * 生产装配断言（评审修复①：SlotLockConfig 是纯 interface 非 DI token——旧实现 @Optional 注入恒
 * undefined，LJR_SLOT_LOCK_* 生产永不生效且断裂静默）。修复后：SLOT_LOCK_CONFIG Symbol token 经
 * module useFactory=slotLockConfigFromEnv(process.env) 装配，service @Inject 注入。
 * 本组用例不触 PG（模块 init 惰性建池）。
 */
describe('slot-lock 配置 DI 装配（无 PG）', () => {
  const apps: INestApplication[] = [];
  afterAll(async () => {
    for (const a of apps.reverse()) await a.close().catch(() => undefined);
  });

  /** 独立装配一个 SlotLockModule 应用（可对 builder 定制，如 overrideProvider） */
  const boot = async (
    customize?: (b: ReturnType<typeof Test.createTestingModule>) => unknown,
  ): Promise<INestApplication> => {
    const builder = Test.createTestingModule({ imports: [SlotLockModule] });
    if (customize) customize(builder);
    const app = (await builder.compile()).createNestApplication();
    apps.push(app);
    await app.init();
    return app;
  };

  it('SLOT_LOCK_CONFIG token 可注入且值来自 env/默认：缺省 env ⇒ 代码默认（文档口径）', async () => {
    const app = await boot();
    const cfg = app.get<SlotLockConfig>(SLOT_LOCK_CONFIG);
    expect(cfg).toEqual(SLOT_LOCK_DEFAULT_CONFIG);
    // token 值确实注入 service（同一实例——非 Optional 回退路径）
    expect(app.get(SlotLockService).config).toBe(cfg);
  });

  it('useFactory 读 process.env：LJR_SLOT_LOCK_* 覆盖经 DI 生效（生产装配不断链）', async () => {
    const prev = process.env.LJR_SLOT_LOCK_TTL_MS;
    process.env.LJR_SLOT_LOCK_TTL_MS = '123456';
    try {
      const app = await boot();
      expect(app.get<SlotLockConfig>(SLOT_LOCK_CONFIG).ttlMs).toBe(123_456);
      expect(app.get(SlotLockService).config.ttlMs).toBe(123_456);
    } finally {
      if (prev === undefined) delete process.env.LJR_SLOT_LOCK_TTL_MS;
      else process.env.LJR_SLOT_LOCK_TTL_MS = prev;
    }
  });

  it('overrideProvider(SLOT_LOCK_CONFIG) 覆盖注入 service：注入通道=token（非 @Optional 位置参数回退）', async () => {
    const app = await boot((b) =>
      b
        .overrideProvider(SLOT_LOCK_CONFIG)
        .useValue({ ttlMs: 111, reaperIntervalMs: 222, staleMs: 333 } satisfies SlotLockConfig),
    );
    expect(app.get(SlotLockService).config).toEqual({
      ttlMs: 111,
      reaperIntervalMs: 222,
      staleMs: 333,
    });
  });
});
