/**
 * B2 时间段占用锁配置（⚠决策位：TTL/节拍/阈值取文档口径默认值，env 可覆盖；拍板项随批次集中汇报）。
 *
 * 读取口径与 scheduler.config.ts 相同：进程 env > 代码默认；键前缀 LJR_SLOT_LOCK_*，
 * 非法/非正值回落默认（配置容错，不抛）。
 */
import type { InjectionToken } from '@nestjs/common';

export interface SlotLockConfig {
  /** PENDING_PAYMENT 自动释放 TTL 毫秒（§2/R-03：10min）⚠决策位 */
  readonly ttlMs: number;
  /** reaper 扫描周期毫秒（§8：每 5min 一轮；SLOT_REAPER 周期 job 的自投间隔）⚠决策位 */
  readonly reaperIntervalMs: number;
  /** reaper 终态超阈毫秒（R-04：关联实体终态超 15min 强制释放）⚠决策位 */
  readonly staleMs: number;
}

/**
 * DI 令牌（CONFIG_PROVIDER 同款 Symbol 口径）：SlotLockConfig 是纯 interface，运行时无类型 token
 * 可寻址——经此 Symbol 装配（module providers: { provide, useFactory: () => slotLockConfigFromEnv
 * (process.env) }），service @Inject(SLOT_LOCK_CONFIG) 注入；缺装配即启动期 fail-fast，不静默回落。
 */
export const SLOT_LOCK_CONFIG: InjectionToken<SlotLockConfig> = Symbol('SLOT_LOCK_CONFIG');

/** 默认值=B2 §2/§7/§8 文档口径 */
export const SLOT_LOCK_DEFAULT_CONFIG: SlotLockConfig = {
  ttlMs: 600_000,
  reaperIntervalMs: 300_000,
  staleMs: 900_000,
};

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function slotLockConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SlotLockConfig {
  return {
    ttlMs: intFromEnv(env, 'LJR_SLOT_LOCK_TTL_MS', SLOT_LOCK_DEFAULT_CONFIG.ttlMs),
    reaperIntervalMs: intFromEnv(
      env,
      'LJR_SLOT_LOCK_REAPER_INTERVAL_MS',
      SLOT_LOCK_DEFAULT_CONFIG.reaperIntervalMs,
    ),
    staleMs: intFromEnv(env, 'LJR_SLOT_LOCK_STALE_MS', SLOT_LOCK_DEFAULT_CONFIG.staleMs),
  };
}
