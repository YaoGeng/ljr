/**
 * I2 调度中心配置（⚠决策位：节拍/退避/阈值取文档默认值，env 可覆盖；拍板项随 H4 联调集中汇报）。
 *
 * 读取口径与 notify.config.ts 相同：进程 env > 代码默认；键前缀 LJR_SCHEDULER_*，
 * 非法/缺省回落默认值。节拍器为进程内存态 interval（ADR-0003：仅内存态节拍，非事实源，
 * 正确性不依赖它——实例全宕重启后逾期 PENDING 由扫描自然捞取补执行）。
 */
export interface SchedulerConfig {
  /** 常规扫描周期毫秒（§8：10-15s；默认 12s）⚠决策位 */
  readonly normalIntervalMs: number;
  /** ROOM_OPEN 高优先级扫描周期毫秒（§8：≤5s；默认 5s）⚠决策位 */
  readonly priorityIntervalMs: number;
  /** 失败退避重试上限（§4：退避重试 3 次后 FAILED；总尝试=1+max）⚠决策位 */
  readonly maxRetries: number;
  /** 退避基值毫秒（第 n 次重试 = base·2^(n-1)，封顶 cap） */
  readonly backoffBaseMs: number;
  /** 退避封顶毫秒 */
  readonly backoffCapMs: number;
  /** R-03：ROOM_OPEN 触发延迟 >30s 电话告警（mock 适配器，供应商位 M2+） */
  readonly roomOpenDelayAlertMs: number;
  /** 监控指标：积压 >60s 告警判定（H4 巡检联动的阈值事实源） */
  readonly backlogAlertMs: number;
  /** FAILED 告警收敛：同类型 5min 去重（§4） */
  readonly failedAlertDedupMs: number;
}

/** 默认值=I2 §4/§8 文档口径 */
export const SCHEDULER_DEFAULT_CONFIG: SchedulerConfig = {
  normalIntervalMs: 12_000,
  priorityIntervalMs: 5_000,
  maxRetries: 3,
  backoffBaseMs: 10_000,
  backoffCapMs: 3_600_000,
  roomOpenDelayAlertMs: 30_000,
  backlogAlertMs: 60_000,
  failedAlertDedupMs: 300_000,
};

/** 第 n 次重试的退避毫秒：base·2^(n-1)，封顶 cap（口径同 platform.outbox 默认退避曲线） */
export function defaultBackoffMs(config: SchedulerConfig): (retryCount: number) => number {
  return (retryCount: number) =>
    Math.min(config.backoffBaseMs * 2 ** (retryCount - 1), config.backoffCapMs);
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function schedulerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  return {
    normalIntervalMs: intFromEnv(
      env,
      'LJR_SCHEDULER_NORMAL_INTERVAL_MS',
      SCHEDULER_DEFAULT_CONFIG.normalIntervalMs,
    ),
    priorityIntervalMs: intFromEnv(
      env,
      'LJR_SCHEDULER_PRIORITY_INTERVAL_MS',
      SCHEDULER_DEFAULT_CONFIG.priorityIntervalMs,
    ),
    maxRetries: intFromEnv(env, 'LJR_SCHEDULER_MAX_RETRIES', SCHEDULER_DEFAULT_CONFIG.maxRetries),
    backoffBaseMs: intFromEnv(
      env,
      'LJR_SCHEDULER_BACKOFF_BASE_MS',
      SCHEDULER_DEFAULT_CONFIG.backoffBaseMs,
    ),
    backoffCapMs: intFromEnv(
      env,
      'LJR_SCHEDULER_BACKOFF_CAP_MS',
      SCHEDULER_DEFAULT_CONFIG.backoffCapMs,
    ),
    roomOpenDelayAlertMs: intFromEnv(
      env,
      'LJR_SCHEDULER_ROOM_OPEN_DELAY_ALERT_MS',
      SCHEDULER_DEFAULT_CONFIG.roomOpenDelayAlertMs,
    ),
    backlogAlertMs: intFromEnv(
      env,
      'LJR_SCHEDULER_BACKLOG_ALERT_MS',
      SCHEDULER_DEFAULT_CONFIG.backlogAlertMs,
    ),
    failedAlertDedupMs: intFromEnv(
      env,
      'LJR_SCHEDULER_FAILED_ALERT_DEDUP_MS',
      SCHEDULER_DEFAULT_CONFIG.failedAlertDedupMs,
    ),
  };
}
