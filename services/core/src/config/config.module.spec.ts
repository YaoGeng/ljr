import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { AppConfigModule } from './config.module';
import { CONFIG_PROVIDER, type ConfigProvider } from './config-provider.interface';

describe('AppConfigModule 装配（@nestjs/config 承载 + CONFIG_PROVIDER 接缝）', () => {
  it('CONFIG_PROVIDER 可解析：require 命中三层装载结果', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();
    const provider = moduleRef.get<ConfigProvider>(CONFIG_PROVIDER, { strict: false });
    expect(provider.require<number>('port')).toBeGreaterThan(0);
    expect(provider.get<string>('pg.database')).toBe('ljr_dev'); // dev 文件层
    await moduleRef.close();
  });

  it('ConfigService 同源：internal config 即同一份 AppConfig（生态消费口）', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();
    const cs = moduleRef.get(ConfigService, { strict: false });
    expect(cs.get('env')).toBe('dev');
    expect(cs.get('pg.port')).toBe(5435);
    expect(cs.get('nacos.serverAddr')).toBe('127.0.0.1:8848');
    await moduleRef.close();
  });
});
