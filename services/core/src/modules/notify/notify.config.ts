/**
 * I1 通知中心配置（⚠决策位：限频/重试参数取架构默认值，env 可覆盖；拍板项随 A1/I1 联调集中汇报）。
 *
 * 读取口径与 OutboxRelayService.pollIntervalFromEnv 相同：进程 env > 代码默认；
 * 键前缀 LJR_NOTIFY_*，非法/缺省回落默认值。
 */
export interface NotifyConfig {
  /** 下发失败重试上限（总尝试=1+max；默认 3=模块文档 §4「失败重试 3 次」）⚠决策位 */
  readonly dispatchMaxRetries: number;
  /** 验证码限频：60s 窗上限（A1 R-01 默认 1 条）⚠决策位 */
  readonly verifyMaxPer60s: number;
  /** 验证码限频：1h 窗上限（A1 R-01 默认 5 条）⚠决策位 */
  readonly verifyMaxPer1h: number;
  /** 验证码限频：1d 窗上限（A1 R-01 默认 10 条）⚠决策位 */
  readonly verifyMaxPer1d: number;
}

/** 默认值=A1 R-01 四档（同号 60s/1 条、1h/5 条、1d/10 条）+ §4 重试 3 次 */
export const NOTIFY_DEFAULT_CONFIG: NotifyConfig = {
  dispatchMaxRetries: 3,
  verifyMaxPer60s: 1,
  verifyMaxPer1h: 5,
  verifyMaxPer1d: 10,
};

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function notifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  return {
    dispatchMaxRetries: intFromEnv(
      env,
      'LJR_NOTIFY_DISPATCH_MAX_RETRIES',
      NOTIFY_DEFAULT_CONFIG.dispatchMaxRetries,
    ),
    verifyMaxPer60s: intFromEnv(
      env,
      'LJR_NOTIFY_VERIFY_MAX_PER_60S',
      NOTIFY_DEFAULT_CONFIG.verifyMaxPer60s,
    ),
    verifyMaxPer1h: intFromEnv(
      env,
      'LJR_NOTIFY_VERIFY_MAX_PER_1H',
      NOTIFY_DEFAULT_CONFIG.verifyMaxPer1h,
    ),
    verifyMaxPer1d: intFromEnv(
      env,
      'LJR_NOTIFY_VERIFY_MAX_PER_1D',
      NOTIFY_DEFAULT_CONFIG.verifyMaxPer1d,
    ),
  };
}
