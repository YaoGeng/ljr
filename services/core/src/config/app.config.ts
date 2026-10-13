/**
 * 类型化配置 schema 与三层装载（M0-8，docs/05 M0-8 / docs/plans/M0-8-环境与配置说明.md）。
 *
 * 分层优先级（高→低）：进程 env > config/<LJR_ENV>/app.env 文件 > 代码默认值。
 *   - env 层：部署/CI 注入口（含全部密钥——密钥只有这一条合法通路）
 *   - 文件层：仅非敏感默认值（入库；config/README.md 划边界）
 *   - 默认层：dev 便携口径（与 scripts/db/*.mjs、docker/dev compose 一致）
 *
 * 红线（架构 §1.3）：ENV_ONLY_KEYS 中的密钥键出现在文件层 → 抛 E_CONFIG_INVALID（fail-fast，
 * 防止真实凭据借 config/*.env 入库）；staging/prod 缺 LJR_PG_PASSWORD → 抛 E_CONFIG_MISSING。
 */
import path from 'node:path';
import { AppError, ErrorCode } from '@ljr/shared';
import { readEnvFile } from './env-file';

export type AppEnvName = 'dev' | 'staging' | 'prod';

/** PG 连接参数（自本文件定义；infrastructure/sql.ts 复用并对外再导出，保证单一事实源） */
export interface PgConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface AppConfig {
  /** 运行环境名（由 LJR_ENV 选择，仅可经进程 env 指定） */
  readonly env: AppEnvName;
  /** HTTP 监听端口（env PORT，main.ts /healthz 所在进程读此处） */
  readonly port: number;
  readonly pg: PgConfig;
  readonly redis: {
    readonly host: string;
    readonly port: number;
    /** dev 走占位默认；staging/prod 必须 env 注入（core M0 尚未消费 redis，M1 起接入） */
    readonly password?: string;
  };
  readonly rocketmq: {
    /** NameServer 地址（host:port；core M0 尚未消费 MQ，outbox relay 仍为进程内投递） */
    readonly namesrvAddr: string;
  };
  readonly nacos: {
    /** Nacos 控制台/客户端地址（host:port；ConfigProvider 的 Nacos 实现自 staging 起接入） */
    readonly serverAddr: string;
  };
}

/** env 键名（LJR_ 前缀沿用 T3 的 scripts/db 与 sql.ts 口径；PORT 沿用 main.ts 既有键） */
export const ENV_KEYS = {
  env: 'LJR_ENV',
  port: 'PORT',
  pgHost: 'LJR_PG_HOST',
  pgPort: 'LJR_PG_PORT',
  pgUser: 'LJR_PG_USER',
  pgPassword: 'LJR_PG_PASSWORD',
  pgDb: 'LJR_PG_DB',
  redisHost: 'LJR_REDIS_HOST',
  redisPort: 'LJR_REDIS_PORT',
  redisPassword: 'LJR_REDIS_PASSWORD',
  rocketmqNamesrv: 'LJR_ROCKETMQ_NAMESRV_ADDR',
  nacosServerAddr: 'LJR_NACOS_SERVER_ADDR',
} as const;

/** 密钥与环境选择键：禁止出现在文件层（出现即 E_CONFIG_INVALID，防凭据入库） */
export const ENV_ONLY_KEYS: readonly string[] = [
  ENV_KEYS.env,
  ENV_KEYS.pgPassword,
  ENV_KEYS.redisPassword,
];

export interface ConfigSources {
  /** 进程 env（最高优先级） */
  readonly env: Record<string, string | undefined>;
  /** config/<env>/app.env 解析产物（次优先级；只允许非敏感默认值） */
  readonly file: Record<string, string>;
}

/** LJR_ENV 归一化：缺省 dev；dev/staging/prod 之外抛 E_CONFIG_INVALID */
export function normalizeEnvName(value: string | undefined): AppEnvName {
  if (value === undefined || value === '') return 'dev';
  if (value === 'dev' || value === 'staging' || value === 'prod') return value;
  throw new AppError(
    ErrorCode.ConfigInvalid,
    `LJR_ENV 必须是 dev/staging/prod 之一（仅可经进程环境指定），收到：${value}`,
  );
}

/** 三层解析（纯函数，无 IO——单测直接注入 env/file 断言优先级矩阵） */
export function resolveAppConfig({ env, file }: ConfigSources): AppConfig {
  for (const key of ENV_ONLY_KEYS) {
    const v = file[key];
    if (v !== undefined && v !== '') {
      throw new AppError(
        ErrorCode.ConfigInvalid,
        `配置文件出现密钥/环境选择键 ${key}（值已截断不回显）：该类键只允许进程环境注入，密钥禁入文件（架构 §1.3）`,
      );
    }
  }

  const pick = (key: string): string | undefined => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    const fromFile = file[key];
    if (fromFile !== undefined && fromFile !== '') return fromFile;
    return undefined;
  };

  const envName = normalizeEnvName(env[ENV_KEYS.env]);

  const pgPassword = pick(ENV_KEYS.pgPassword) ?? (envName === 'dev' ? 'ljr-dev-only' : undefined);
  if (pgPassword === undefined) {
    throw new AppError(
      ErrorCode.ConfigMissing,
      `环境 ${envName} 必须注入 ${ENV_KEYS.pgPassword}（密钥禁入配置文件，只走进程环境）`,
    );
  }

  return {
    env: envName,
    port: parsePort(pick(ENV_KEYS.port) ?? '3000', ENV_KEYS.port),
    pg: {
      host: pick(ENV_KEYS.pgHost) ?? '127.0.0.1',
      port: parsePort(pick(ENV_KEYS.pgPort) ?? '5435', ENV_KEYS.pgPort),
      user: pick(ENV_KEYS.pgUser) ?? 'postgres',
      password: pgPassword,
      database: pick(ENV_KEYS.pgDb) ?? 'ljr_dev',
    },
    redis: {
      host: pick(ENV_KEYS.redisHost) ?? '127.0.0.1',
      port: parsePort(pick(ENV_KEYS.redisPort) ?? '6380', ENV_KEYS.redisPort),
      password: pick(ENV_KEYS.redisPassword) ?? (envName === 'dev' ? 'ljr-dev-only' : undefined),
    },
    rocketmq: {
      namesrvAddr: pick(ENV_KEYS.rocketmqNamesrv) ?? '127.0.0.1:9876',
    },
    nacos: {
      serverAddr: pick(ENV_KEYS.nacosServerAddr) ?? '127.0.0.1:8848',
    },
  };
}

/** 端口解析：非 1-65535 整数抛 E_CONFIG_INVALID（防 Number('abc')=NaN 静默入 Pool） */
function parsePort(raw: string, key: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new AppError(ErrorCode.ConfigInvalid, `${key} 必须是 1-65535 的整数，收到：${raw}`);
  }
  return n;
}

/** config/<env>/app.env 路径（src/config 与 dist/config 同深：上溯 4 级即仓库根） */
export function configFilePath(envName: AppEnvName): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'config', envName, 'app.env');
}

/** 装载入口：进程 env + 按 LJR_ENV 选文件 → 三层解析（每次调用现读文件，无缓存——调用频度=进程启动级） */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envName = normalizeEnvName(env[ENV_KEYS.env]);
  return resolveAppConfig({ env, file: readEnvFile(configFilePath(envName)) });
}
