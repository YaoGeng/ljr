import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  configFilePath,
  loadAppConfig,
  normalizeEnvName,
  resolveAppConfig,
  type ConfigSources,
} from './app.config';

const baseFile: Record<string, string> = {
  PORT: '3100',
  LJR_PG_HOST: 'file-host',
  LJR_PG_PORT: '6543',
  LJR_PG_USER: 'file-user',
  LJR_PG_DB: 'file-db',
  LJR_REDIS_HOST: 'file-redis',
};

function sources(overrides: {
  env?: Record<string, string>;
  file?: Record<string, string>;
}): ConfigSources {
  return { env: overrides.env ?? {}, file: overrides.file ?? baseFile };
}

describe('分层优先级：进程 env > config 文件 > 代码默认值', () => {
  it('env 覆盖文件（同键 PORT）', () => {
    const cfg = resolveAppConfig(sources({ env: { PORT: '3200' } }));
    expect(cfg.port).toBe(3200);
  });

  it('文件覆盖默认值（LJR_PG_HOST 等；默认层为 127.0.0.1）', () => {
    const cfg = resolveAppConfig(sources({}));
    expect(cfg.pg.host).toBe('file-host');
    expect(cfg.pg.port).toBe(6543);
    expect(cfg.pg.user).toBe('file-user');
    expect(cfg.pg.database).toBe('file-db');
    expect(cfg.redis.host).toBe('file-redis');
  });

  it('两层皆缺走默认值（rocketmq/nacos 未在文件层给出）', () => {
    const cfg = resolveAppConfig(sources({}));
    expect(cfg.rocketmq.namesrvAddr).toBe('127.0.0.1:9876');
    expect(cfg.nacos.serverAddr).toBe('127.0.0.1:8848');
    expect(cfg.redis.port).toBe(6380); // 默认层 dev 便携口径
  });

  it('env 空串视为未设置（回落文件层）', () => {
    const cfg = resolveAppConfig(sources({ env: { PORT: '' } }));
    expect(cfg.port).toBe(3100);
  });
});

describe('密钥红线（ENV_ONLY_KEYS 机器强制）', () => {
  it('密钥键出现在文件层 → E_CONFIG_INVALID（防凭据入库）', () => {
    expect(() =>
      resolveAppConfig(sources({ file: { ...baseFile, LJR_PG_PASSWORD: 'real-secret' } })),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
  });

  it('LJR_ENV 出现在文件层同样拒绝（环境选择只走进程 env）', () => {
    expect(() =>
      resolveAppConfig(sources({ file: { ...baseFile, LJR_ENV: 'prod' } })),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
  });

  it('非 dev 缺 LJR_PG_PASSWORD → E_CONFIG_MISSING（fail-fast）', () => {
    expect(() => resolveAppConfig(sources({ env: { LJR_ENV: 'staging' }, file: {} }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.ConfigMissing }) as AppError,
    );
  });

  it('非 dev 经 env 注入口令则通过；redis 口令非 dev 不落占位默认', () => {
    const cfg = resolveAppConfig(sources({ env: { LJR_ENV: 'prod', LJR_PG_PASSWORD: 'x' } }));
    expect(cfg.pg.password).toBe('x');
    expect(cfg.redis.password).toBeUndefined();
  });

  it('dev 缺省走占位口令 ljr-dev-only（与 portable 轨/ compose 默认一致）', () => {
    const cfg = resolveAppConfig(sources({}));
    expect(cfg.pg.password).toBe('ljr-dev-only');
    expect(cfg.redis.password).toBe('ljr-dev-only');
  });
});

describe('取值校验（fail-fast）', () => {
  it('LJR_ENV 非 dev/staging/prod → E_CONFIG_INVALID', () => {
    expect(() => resolveAppConfig(sources({ env: { LJR_ENV: 'sit' } }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError,
    );
    expect(normalizeEnvName(undefined)).toBe('dev');
    expect(normalizeEnvName('staging')).toBe('staging');
  });

  it('端口非 1-65535 整数 → E_CONFIG_INVALID（PORT 与 LJR_PG_PORT 同规则）', () => {
    for (const bad of ['abc', '0', '70000', '1.5']) {
      expect(() => resolveAppConfig(sources({ env: { PORT: bad } })), `PORT=${bad}`).toThrowError(
        expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError,
      );
      expect(
        () => resolveAppConfig(sources({ env: { LJR_PG_PORT: bad } })),
        `LJR_PG_PORT=${bad}`,
      ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
    }
  });
});

describe('loadAppConfig（装载入口：env + 按 LJR_ENV 选文件）', () => {
  it('缺省 LJR_ENV=dev：读真实 config/dev/app.env，非敏感项来自文件层', () => {
    const cfg = loadAppConfig({});
    expect(cfg.env).toBe('dev');
    expect(cfg.pg.port).toBe(5435);
    expect(cfg.pg.database).toBe('ljr_dev');
    expect(cfg.redis.port).toBe(6380);
  });

  it('env 参数覆盖真实文件层（模拟 CI 注入 LJR_PG_PORT=5432 的口径）', () => {
    const cfg = loadAppConfig({ LJR_PG_PORT: '5432' });
    expect(cfg.pg.port).toBe(5432);
  });

  it('configFilePath 按 src/dist 同深口径指向仓库 config/<env>/app.env', () => {
    const p = configFilePath('dev').replaceAll('\\', '/');
    expect(p.endsWith('config/dev/app.env')).toBe(true);
  });
});
