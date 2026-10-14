import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RULE_CENTER_CONFIG,
  RULE_CENTER_DEFAULT_CONFIG,
  ruleCenterConfigFromEnv,
  type RuleCenterConfig,
} from './rule-center.config';
import { RuleCenterModule } from './rule-center.module';
import { RuleCenterService } from './rule-center.service';

/**
 * H7 配置装载纯单元（口径同 slot-lock.config.spec）：默认值=文档口径（§2/§4 公示 7 日 +
 * ⚠决策位：生效 job 缓冲 60s / 缓存 TTL 60s / 须知键 room_notice），env 覆盖生效，非法值回落默认。
 */
describe('rule-center 配置', () => {
  it('默认值=文档口径：公示 7d / 生效 job 缓冲 60s / 现行版缓存 TTL 60s / 须知键 room_notice', () => {
    expect(RULE_CENTER_DEFAULT_CONFIG).toEqual({
      publicationMs: 604_800_000,
      effectiveJobDelayMs: 60_000,
      currentCacheTtlMs: 60_000,
      noticeRuleKey: 'room_notice',
    });
    expect(ruleCenterConfigFromEnv({})).toEqual(RULE_CENTER_DEFAULT_CONFIG);
  });

  it('env 覆盖生效（LJR_RULE_*）', () => {
    expect(
      ruleCenterConfigFromEnv({
        LJR_RULE_PUBLICATION_MS: '3600000',
        LJR_RULE_EFFECTIVE_JOB_DELAY_MS: '5000',
        LJR_RULE_CURRENT_CACHE_TTL_MS: '0',
        LJR_RULE_NOTICE_KEY: 'consult_notice',
      }),
    ).toEqual({
      publicationMs: 3_600_000,
      effectiveJobDelayMs: 5_000,
      currentCacheTtlMs: 0,
      noticeRuleKey: 'consult_notice',
    });
  });

  it('非法/负值回落默认；TTL=0 合法（纯失效模式）；空键回落默认（不抛，配置容错口径同 scheduler）', () => {
    expect(
      ruleCenterConfigFromEnv({
        LJR_RULE_PUBLICATION_MS: 'abc',
        LJR_RULE_EFFECTIVE_JOB_DELAY_MS: '-5',
        LJR_RULE_NOTICE_KEY: '',
      }),
    ).toEqual(RULE_CENTER_DEFAULT_CONFIG);
  });
});

/**
 * 生产装配断言（slot-lock 评审修复①同口径：RuleCenterConfig 纯 interface 经 Symbol token 装配，
 * service @Inject 注入；缺装配即启动期 fail-fast）。本组用例不触 PG（模块 init 惰性建池）。
 */
describe('rule-center 配置 DI 装配（无 PG）', () => {
  const apps: INestApplication[] = [];
  afterAll(async () => {
    for (const a of apps.reverse()) await a.close().catch(() => undefined);
  });

  const boot = async (): Promise<INestApplication> => {
    const app = (
      await Test.createTestingModule({ imports: [RuleCenterModule] }).compile()
    ).createNestApplication();
    apps.push(app);
    await app.init();
    return app;
  };

  it('RULE_CENTER_CONFIG token 可注入且值=代码默认：注入 service（同一实例，非 Optional 回退）', async () => {
    const app = await boot();
    const cfg = app.get<RuleCenterConfig>(RULE_CENTER_CONFIG);
    expect(cfg).toEqual(RULE_CENTER_DEFAULT_CONFIG);
    expect(app.get(RuleCenterService).config).toBe(cfg);
  });

  it('useFactory 读 process.env：LJR_RULE_* 覆盖经 DI 生效（生产装配不断链）', async () => {
    const prev = process.env['LJR_RULE_PUBLICATION_MS'];
    process.env['LJR_RULE_PUBLICATION_MS'] = '123456';
    try {
      const app = await boot();
      expect(app.get<RuleCenterConfig>(RULE_CENTER_CONFIG).publicationMs).toBe(123_456);
      expect(app.get(RuleCenterService).config.publicationMs).toBe(123_456);
    } finally {
      if (prev === undefined) delete process.env['LJR_RULE_PUBLICATION_MS'];
      else process.env['LJR_RULE_PUBLICATION_MS'] = prev;
    }
  });
});
