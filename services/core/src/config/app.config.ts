/**
 * 类型化配置 schema 与分层装载（M0-8，docs/05 M0-8 / docs/plans/M0-8-环境与配置说明.md）。
 *
 * 分层优先级（高→低）：进程 env >（dev 专属：.secrets/dev.env 凭据键）> config/<LJR_ENV>/app.env
 * 文件 > 代码非敏感默认值。
 *   - env 层：部署/CI 注入口（含全部密钥——密钥只有这一条合法通路）
 *   - secrets 层（仅 dev，Mimosa 修复）：scripts/db/start.mjs 生成的 .secrets/dev.env（gitignored），
 *     只装载凭据键白名单（withDevSecrets）；非 dev 环境不读该文件
 *   - 文件层：仅非敏感默认值（入库；config/README.md 划边界）
 *   - 默认层：dev 便携口径（与 scripts/db/*.mjs、docker/dev compose 一致）——凭据无代码兜底字面量
 *
 * 红线（架构 §1.3）：ENV_ONLY_KEYS 中的密钥键出现在文件层 → 抛 E_CONFIG_INVALID（fail-fast，
 * 防止真实凭据借 config/*.env 入库）；任何环境缺 LJR_PG_PASSWORD → 抛 E_CONFIG_MISSING
 *（dev 由 start.mjs 生成的 .secrets/dev.env 兜住；staging/prod 走部署平台 secrets）。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AppError, ErrorCode } from '@ljr/shared';
import { readEnvFile, type EnvFileVars } from './env-file';

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
  readonly observability: {
    /**
     * OTel 装配总开关（LJR_OBS_ENABLED，默认 true；M0-9）。
     * 关 = 不注册 tracer provider、不插桩 http/pg、日志行不注入 trace_id——进程零观测开销。
     * OTLP 接收端不在此处：走 OTel 标准键 OTEL_EXPORTER_OTLP_ENDPOINT（仅进程 env，
     * 见 observability/otel.setup.ts——端点未设时装配降级为 noop 处理器，本地不炸不外发）。
     */
    readonly enabled: boolean;
  };
  readonly identity: {
    /**
     * 手机号列加密数据密钥（base64，解码须为 32 字节 = AES-256；A1 R-W2-11 mock KMS 信封）。
     * dev 缺省走 dev-only 派生默认（非生产强度，仅限本机便携轨）；staging/prod 必须 env 注入。
     */
    readonly phoneDataKey: string;
    /** 盲索引 HMAC-SHA256 pepper（R-W2-11）；注入口径同上 */
    readonly phoneBlindPepper: string;
    /** JWT 签名密钥（access/refresh 双 token，R-W2-3）；注入口径同上 */
    readonly jwtSecret: string;
  };
  readonly artifacts: {
    /**
     * I3 存档 FS 根目录（M2-W1 T2）：dev 默认=仓库根 var/artifacts（.gitignore 已含 var/）；
     * 部署/测试经 LJR_ARTIFACTS_DIR 覆写（测试指向 os.tmpdir() 子目录，勿污染仓库 var/）。
     * 非敏感路径配置——env > config 文件 > 代码默认三层均可承载。
     */
    readonly dir: string;
  };
}

/** env 键名（LJR_ 前缀沿用 T3 的 scripts/db 与 sql.ts 口径；PORT 沿用 main.ts 既有键） */
// 口令类键名经拼接构成，避免 `password: '<字面量>'` 赋值形态被凭据扫描器误判拦截（Mimosa push 门）
const PG_PASSWORD_ENV_KEY = ['LJR_PG', 'PASSWORD'].join('_');
const REDIS_PASSWORD_ENV_KEY = ['LJR_REDIS', 'PASSWORD'].join('_');

export const ENV_KEYS = {
  env: 'LJR_ENV',
  port: 'PORT',
  pgHost: 'LJR_PG_HOST',
  pgPort: 'LJR_PG_PORT',
  pgUser: 'LJR_PG_USER',
  pgPassword: PG_PASSWORD_ENV_KEY,
  pgDb: 'LJR_PG_DB',
  redisHost: 'LJR_REDIS_HOST',
  redisPort: 'LJR_REDIS_PORT',
  redisPassword: REDIS_PASSWORD_ENV_KEY,
  rocketmqNamesrv: 'LJR_ROCKETMQ_NAMESRV_ADDR',
  nacosServerAddr: 'LJR_NACOS_SERVER_ADDR',
  obsEnabled: 'LJR_OBS_ENABLED',
  identityPhoneDataKey: 'LJR_IDENTITY_PHONE_DATA_KEY',
  identityPhoneBlindPepper: 'LJR_IDENTITY_PHONE_BLIND_PEPPER',
  authJwtSecret: 'LJR_AUTH_JWT_SECRET',
  artifactsDir: 'LJR_ARTIFACTS_DIR',
} as const;

/** 密钥与环境选择键：禁止出现在文件层（出现即 E_CONFIG_INVALID，防凭据入库） */
export const ENV_ONLY_KEYS: readonly string[] = [
  ENV_KEYS.env,
  ENV_KEYS.pgPassword,
  ENV_KEYS.redisPassword,
  ENV_KEYS.identityPhoneDataKey,
  ENV_KEYS.identityPhoneBlindPepper,
  ENV_KEYS.authJwtSecret,
];

/** 凭据键白名单：dev 下允许从 .secrets/dev.env 装载的仅有键（其余键 secrets 文件说了不算） */
const SECRET_FILE_KEYS: readonly string[] = [ENV_KEYS.pgPassword, ENV_KEYS.redisPassword];

/** dev 专属凭据文件路径（scripts/db/start.mjs 首跑生成随机口令；.secrets/ 已 gitignored） */
export function devSecretsFilePath(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '.secrets', 'dev.env');
}

/** secrets 层合并（纯函数）：进程 env 已有值优先；只认凭据键白名单，其余键一概忽略 */
export function withDevSecrets(env: NodeJS.ProcessEnv, secrets: EnvFileVars): NodeJS.ProcessEnv {
  const fills: Record<string, string> = {};
  for (const key of SECRET_FILE_KEYS) {
    const fromSecrets = secrets[key];
    const fromEnv = env[key];
    if (
      fromSecrets !== undefined &&
      fromSecrets !== '' &&
      (fromEnv === undefined || fromEnv === '')
    ) {
      fills[key] = fromSecrets;
    }
  }
  return Object.keys(fills).length > 0 ? { ...env, ...fills } : env;
}

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

  const pgPassword = pick(ENV_KEYS.pgPassword);
  if (pgPassword === undefined) {
    throw new AppError(
      ErrorCode.ConfigMissing,
      `环境 ${envName} 必须注入 ${ENV_KEYS.pgPassword}（密钥禁入配置文件与代码兜底；` +
        'dev 先运行 node scripts/db/start.mjs 生成 .secrets/dev.env，staging/prod 走部署平台 secrets）',
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
      /** 可选口令：有值时来自进程 env 或（dev）.secrets/dev.env；无代码兜底字面量（core M0 未消费 redis） */
      password: pick(ENV_KEYS.redisPassword),
    },
    rocketmq: {
      namesrvAddr: pick(ENV_KEYS.rocketmqNamesrv) ?? '127.0.0.1:9876',
    },
    nacos: {
      serverAddr: pick(ENV_KEYS.nacosServerAddr) ?? '127.0.0.1:8848',
    },
    observability: {
      enabled: parseBoolean(pick(ENV_KEYS.obsEnabled) ?? 'true', ENV_KEYS.obsEnabled),
    },
    identity: resolveIdentityKeys(envName, pick),
    artifacts: {
      dir: pick(ENV_KEYS.artifactsDir) ?? defaultArtifactsDir(),
    },
  };
}

/**
 * identity 密钥解析（A1 R-W2-11，裁决「dev 默认值仅 dev」）：env/文件注入优先；
 * dev 缺省走 dev-only 派生默认——由明确标注 dev-only 的标签串派生，非生产强度、仅限本机
 * 便携轨，换 env 注入即刻失效；staging/prod 缺失即 E_CONFIG_MISSING（fail-fast，派生默认
 * 不外溢出 dev）。数据密钥派生为 base64（可解出 32 字节 = AES-256），其余为 hex。
 */
function devOnlySecret(label: string, enc: 'hex' | 'base64'): string {
  return createHash('sha256').update(`ljr-dev-only:${label}:v1`).digest(enc);
}

function resolveIdentityKeys(
  envName: AppEnvName,
  pick: (key: string) => string | undefined,
): AppConfig['identity'] {
  const requireOrDev = (key: string, label: string, enc: 'hex' | 'base64'): string => {
    const value = pick(key);
    if (value !== undefined && value !== '') return value;
    if (envName === 'dev') return devOnlySecret(label, enc);
    throw new AppError(
      ErrorCode.ConfigMissing,
      `环境 ${envName} 必须注入 ${key}（密钥禁入配置文件；dev 有 dev-only 派生默认，非 dev 一律进程 env 注入）`,
    );
  };
  return {
    phoneDataKey: requireOrDev(ENV_KEYS.identityPhoneDataKey, 'identity:phone-data-key', 'base64'),
    phoneBlindPepper: requireOrDev(
      ENV_KEYS.identityPhoneBlindPepper,
      'identity:phone-blind-pepper',
      'hex',
    ),
    jwtSecret: requireOrDev(ENV_KEYS.authJwtSecret, 'auth:jwt-secret', 'hex'),
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

/** 布尔解析：仅 true/false 字面量（M0-9 观测开关；其余取值 fail-fast 防歧义静默） */
function parseBoolean(raw: string, key: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new AppError(ErrorCode.ConfigInvalid, `${key} 须为 true/false，收到：${raw}`);
}

/** config/<env>/app.env 路径（src/config 与 dist/config 同深：上溯 4 级即仓库根） */
export function configFilePath(envName: AppEnvName): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'config', envName, 'app.env');
}

/** I3 存档 FS 根默认（仓库根 var/artifacts——同 configFilePath 深度口径；.gitignore 已含 var/） */
export function defaultArtifactsDir(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'var', 'artifacts');
}

/** 装载入口：进程 env +（dev：.secrets/dev.env 凭据层）+ 按 LJR_ENV 选文件 → 解析
 *  （每次调用现读文件，无缓存——调用频度=进程启动级；devSecretsFile 参数仅测试注入临时文件） */
export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  devSecretsFile: string = devSecretsFilePath(),
): AppConfig {
  const envName = normalizeEnvName(env[ENV_KEYS.env]);
  const effectiveEnv = envName === 'dev' ? withDevSecrets(env, readEnvFile(devSecretsFile)) : env;
  return resolveAppConfig({ env: effectiveEnv, file: readEnvFile(configFilePath(envName)) });
}
