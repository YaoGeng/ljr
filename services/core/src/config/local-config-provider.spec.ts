import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode, isAppError } from '@ljr/shared';
import { LocalConfigProvider } from './local-config-provider';

describe('LocalConfigProvider（本地实现：get/require）', () => {
  const provider = new LocalConfigProvider({
    port: 3000,
    pg: {
      host: '127.0.0.1',
      port: 5435,
      user: 'postgres',
      password: randomUUID(), // 随机值：测试不落可用凭据字面量（Mimosa 修复口径）
      database: 'ljr_dev',
    },
    empty: null,
  });

  it('get：点路径取值；缺失/中途非对象 → undefined', () => {
    expect(provider.get<number>('port')).toBe(3000);
    expect(provider.get<string>('pg.host')).toBe('127.0.0.1');
    expect(provider.get('pg.ssl.ca')).toBeUndefined(); // 中途标量
    expect(provider.get('nacos.serverAddr')).toBeUndefined(); // 首跳即缺
    expect(provider.get('empty.deeper')).toBeUndefined(); // null 非对象
  });

  it('require：命中返回值（泛型收窄由调用方持有）', () => {
    expect(provider.require<number>('port')).toBe(3000);
    expect(provider.require<string>('pg.user')).toBe('postgres');
  });

  it('require：缺失抛 AppError(E_CONFIG_MISSING)——启动期 fail-fast', () => {
    let caught: unknown;
    try {
      provider.require('pg.password.rotation');
    } catch (e) {
      caught = e;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe(ErrorCode.ConfigMissing);
    expect((caught as AppError).httpStatus).toBe(500);
    expect((caught as AppError).message).toContain('pg.password.rotation');
  });
});
