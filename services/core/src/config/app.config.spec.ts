import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  configFilePath,
  devSecretsFilePath,
  loadAppConfig,
  normalizeEnvName,
  resolveAppConfig,
  withDevSecrets,
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

/** 随机口令（测试不落任何可用凭据字面量——Mimosa 修复口径） */
const randomPassword = (): string => randomUUID();

/** dev 形态的 env：凭据键默认随机注入（显式传 undefined 可制造「缺密钥」用例） */
function devEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { LJR_PG_PASSWORD: randomPassword(), ...extra };
}

function sources(overrides: {
  env?: Record<string, string | undefined>;
  file?: Record<string, string>;
}): ConfigSources {
  return { env: overrides.env ?? {}, file: overrides.file ?? baseFile };
}

describe('分层优先级：进程 env > config 文件 > 代码默认值', () => {
  it('env 覆盖文件（同键 PORT）', () => {
    const cfg = resolveAppConfig(sources({ env: devEnv({ PORT: '3200' }) }));
    expect(cfg.port).toBe(3200);
  });

  it('文件覆盖默认值（LJR_PG_HOST 等；默认层为 127.0.0.1）', () => {
    const cfg = resolveAppConfig(sources({ env: devEnv() }));
    expect(cfg.pg.host).toBe('file-host');
    expect(cfg.pg.port).toBe(6543);
    expect(cfg.pg.user).toBe('file-user');
    expect(cfg.pg.database).toBe('file-db');
    expect(cfg.redis.host).toBe('file-redis');
  });

  it('两层皆缺走默认值（rocketmq/nacos 未在文件层给出）', () => {
    const cfg = resolveAppConfig(sources({ env: devEnv() }));
    expect(cfg.rocketmq.namesrvAddr).toBe('127.0.0.1:9876');
    expect(cfg.nacos.serverAddr).toBe('127.0.0.1:8848');
    expect(cfg.redis.port).toBe(6380); // 默认层 dev 便携口径
  });

  it('env 空串视为未设置（回落文件层）', () => {
    const cfg = resolveAppConfig(sources({ env: devEnv({ PORT: '' }) }));
    expect(cfg.port).toBe(3100);
  });
});

describe('密钥红线（ENV_ONLY_KEYS 机器强制）', () => {
  it('密钥键出现在文件层 → E_CONFIG_INVALID（防凭据入库）', () => {
    expect(() =>
      resolveAppConfig(sources({ file: { ...baseFile, LJR_PG_PASSWORD: randomPassword() } })),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
  });

  it('A1 identity 密钥键同样禁入文件层（R-W2-11：数据密钥/pepper/JWT 密钥只走 env）', () => {
    for (const key of [
      'LJR_IDENTITY_PHONE_DATA_KEY',
      'LJR_IDENTITY_PHONE_BLIND_PEPPER',
      'LJR_AUTH_JWT_SECRET',
    ]) {
      expect(() =>
        resolveAppConfig(sources({ file: { ...baseFile, [key]: randomPassword() } })),
      ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
    }
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

  it('非 dev 缺 identity 密钥 → E_CONFIG_MISSING（dev-only 默认不外溢到 staging/prod）', () => {
    const password = randomPassword();
    expect(() =>
      resolveAppConfig(sources({ env: { LJR_ENV: 'prod', LJR_PG_PASSWORD: password } })),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigMissing }) as AppError);
    expect(() =>
      resolveAppConfig(sources({
        env: {
          LJR_ENV: 'staging',
          LJR_PG_PASSWORD: password,
          LJR_AUTH_JWT_SECRET: randomPassword(),
          LJR_IDENTITY_PHONE_BLIND_PEPPER: randomPassword(),
        },
        file: {},
      })),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigMissing }) as AppError);
  });

  it('非 dev 经 env 注入 identity 三密钥则通过（原值透传，不做 dev 派生）', () => {
    const jwt = randomPassword();
    const pepper = randomPassword();
    const dataKey = Buffer.from(randomUUID()).toString('base64');
    const cfg = resolveAppConfig(sources({
      env: {
        LJR_ENV: 'prod',
        LJR_PG_PASSWORD: randomPassword(),
        LJR_AUTH_JWT_SECRET: jwt,
        LJR_IDENTITY_PHONE_BLIND_PEPPER: pepper,
        LJR_IDENTITY_PHONE_DATA_KEY: dataKey,
      },
      file: {},
    }));
    expect(cfg.identity.jwtSecret).toBe(jwt);
    expect(cfg.identity.phoneBlindPepper).toBe(pepper);
    expect(cfg.identity.phoneDataKey).toBe(dataKey);
  });

  it('dev 缺 identity 密钥 → dev-only 派生默认（可用但非生产强度，换 env 即失效）', () => {
    const cfg = resolveAppConfig(sources({ env: devEnv() }));
    expect(cfg.identity.jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(cfg.identity.phoneBlindPepper.length).toBeGreaterThanOrEqual(32);
    // dev 默认数据密钥可解出 32 字节（AES-256）
    expect(Buffer.from(cfg.identity.phoneDataKey, 'base64')).toHaveLength(32);
    // 且与显式注入值可区分（同 env 两次解析派生值稳定，换值即刻不同）
    const cfg2 = resolveAppConfig(sources({
      env: devEnv({ LJR_AUTH_JWT_SECRET: randomPassword() }),
    }));
    expect(cfg2.identity.jwtSecret).not.toBe(cfg.identity.jwtSecret);
    expect(cfg2.identity.phoneBlindPepper).toBe(cfg.identity.phoneBlindPepper);
  });

  it('非 dev 经 env 注入口令则通过；redis 口令非 dev 不落占位默认', () => {
    const password = randomPassword();
    const cfg = resolveAppConfig(sources({
      // M1-W2 起 prod 必须注入 identity 三密钥（A1 R-W2-11）——fixture 随契约补齐
      env: {
        LJR_ENV: 'prod',
        LJR_PG_PASSWORD: password,
        LJR_IDENTITY_PHONE_DATA_KEY: Buffer.from(randomUUID()).toString('base64'),
        LJR_IDENTITY_PHONE_BLIND_PEPPER: randomPassword(),
        LJR_AUTH_JWT_SECRET: randomPassword(),
      },
    }));
    expect(cfg.pg.password).toBe(password);
    expect(cfg.redis.password).toBeUndefined();
  });
});

describe('dev 凭据层（.secrets/dev.env，Mimosa 修复：无代码兜底字面量）', () => {
  it('dev 进程 env 与 secrets 皆缺 → E_CONFIG_MISSING（不静默回落任何占位口令）', () => {
    expect(() => resolveAppConfig(sources({ env: {} }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.ConfigMissing }) as AppError,
    );
  });

  it('withDevSecrets：env 缺的凭据键由 secrets 补齐（白名单键）', () => {
    const password = randomPassword();
    const merged = withDevSecrets({ LJR_PG_PORT: '5432' }, { LJR_PG_PASSWORD: password });
    expect(merged.LJR_PG_PASSWORD).toBe(password);
    expect(merged.LJR_PG_PORT).toBe('5432');
  });

  it('withDevSecrets：进程 env 已有值优先（secrets 不覆盖）', () => {
    const password = randomPassword();
    const merged = withDevSecrets(
      { LJR_PG_PASSWORD: password },
      { LJR_PG_PASSWORD: randomPassword() },
    );
    expect(merged.LJR_PG_PASSWORD).toBe(password);
  });

  it('withDevSecrets：非凭据键白名单外一概忽略（secrets 文件不得注入任意配置）', () => {
    const merged = withDevSecrets(
      {},
      { LJR_PG_HOST: 'secrets-host', LJR_ENV: 'prod', LJR_PG_PASSWORD: randomPassword() },
    );
    expect(merged.LJR_PG_HOST).toBeUndefined();
    expect(merged.LJR_ENV).toBeUndefined();
    expect(merged.LJR_PG_PASSWORD).toBeDefined();
  });

  it('withDevSecrets：env 空串视为未设置，secrets 补齐（与 pick 同口径）', () => {
    const password = randomPassword();
    const merged = withDevSecrets({ LJR_PG_PASSWORD: '' }, { LJR_PG_PASSWORD: password });
    expect(merged.LJR_PG_PASSWORD).toBe(password);
  });

  it('loadAppConfig：dev 缺进程 env 时从 .secrets/dev.env 装载凭据键（临时文件注入）', () => {
    const password = randomPassword();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ljr-dev-secrets-'));
    const file = path.join(dir, 'dev.env');
    fs.writeFileSync(file, `LJR_PG_PASSWORD=${password}\nLJR_PG_HOST=secrets-host\n`);
    try {
      const cfg = loadAppConfig({ LJR_PG_PORT: '5432' }, file);
      expect(cfg.pg.password).toBe(password);
      expect(cfg.pg.port).toBe(5432);
      expect(cfg.pg.host).toBe('127.0.0.1'); // 非凭据键不认 secrets 层 → 文件层/默认层
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('devSecretsFilePath 指向仓库根 .secrets/dev.env', () => {
    expect(devSecretsFilePath().replaceAll('\\', '/').endsWith('.secrets/dev.env')).toBe(true);
  });
});

describe('取值校验（fail-fast）', () => {
  it('LJR_ENV 非 dev/staging/prod → E_CONFIG_INVALID', () => {
    expect(() => resolveAppConfig(sources({ env: devEnv({ LJR_ENV: 'sit' }) }))).toThrowError(
      expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError,
    );
    expect(normalizeEnvName(undefined)).toBe('dev');
    expect(normalizeEnvName('staging')).toBe('staging');
  });

  it('端口非 1-65535 整数 → E_CONFIG_INVALID（PORT 与 LJR_PG_PORT 同规则）', () => {
    for (const bad of ['abc', '0', '70000', '1.5']) {
      expect(
        () => resolveAppConfig(sources({ env: devEnv({ PORT: bad }) })),
        `PORT=${bad}`,
      ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
      expect(
        () => resolveAppConfig(sources({ env: devEnv({ LJR_PG_PORT: bad }) })),
        `LJR_PG_PORT=${bad}`,
      ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
    }
  });
});

describe('观测开关（M0-9：observability.enabled）', () => {
  it('默认 true；env 层可关（false）', () => {
    expect(resolveAppConfig(sources({ env: devEnv() })).observability.enabled).toBe(true);
    expect(
      resolveAppConfig(sources({ env: devEnv({ LJR_OBS_ENABLED: 'false' }) })).observability
        .enabled,
    ).toBe(false);
  });

  it('文件层同键生效（非敏感开关，可入库）', () => {
    const cfg = resolveAppConfig(
      sources({ env: devEnv(), file: { ...baseFile, LJR_OBS_ENABLED: 'false' } }),
    );
    expect(cfg.observability.enabled).toBe(false);
  });

  it('非 true/false 字面量 → E_CONFIG_INVALID（fail-fast 防歧义静默）', () => {
    expect(() =>
      resolveAppConfig(sources({ env: devEnv({ LJR_OBS_ENABLED: 'yes' }) })),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.ConfigInvalid }) as AppError);
  });
});

describe('loadAppConfig（装载入口：env + 按 LJR_ENV 选文件）', () => {
  it('缺省 LJR_ENV=dev：读真实 config/dev/app.env，非敏感项来自文件层', () => {
    const cfg = loadAppConfig(devEnv());
    expect(cfg.env).toBe('dev');
    expect(cfg.pg.port).toBe(5435);
    expect(cfg.pg.database).toBe('ljr_dev');
    expect(cfg.redis.port).toBe(6380);
  });

  it('env 参数覆盖真实文件层（模拟 CI 注入 LJR_PG_PORT=5432 的口径）', () => {
    const cfg = loadAppConfig(devEnv({ LJR_PG_PORT: '5432' }));
    expect(cfg.pg.port).toBe(5432);
  });

  it('configFilePath 按 src/dist 同深口径指向仓库 config/<env>/app.env', () => {
    const p = configFilePath('dev').replaceAll('\\', '/');
    expect(p.endsWith('config/dev/app.env')).toBe(true);
  });
});
