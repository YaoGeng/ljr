/**
 * H4 资损巡检配置（⚠W4-5 决策位：五类阈值全配置化，默认值抄架构 §7.2；运营调参=H7 规则化
 * 时一并收口）。读取口径与 scheduler.config 相同：进程 env > 代码默认；键前缀 LJR_PATROL_*，
 * 非法/非正值回落默认（配置容错，不抛）。
 *
 * 窗口判定时钟锚=DB 钟（A3b R-03 双钟教训）：检测 SQL 谓词一律以 now()（DB）计算窗口，
 * 终态判定 provider 的 since 比较= DB 存值 × DB 取时（B2 reaper 同款口径，见各检测件头注）。
 */
import type { InjectionToken } from '@nestjs/common';

export interface PatrolConfig {
  /** 巡检周期毫秒（架构 §7.2「分钟级」→ 默认 60s；RISK_PATROL job 自投间隔）⚠决策位 */
  readonly intervalMs: number;
  /** ①已支付未退款窗口毫秒（架构 §7.2：>10min；锚=实体终态迁移时刻 status_since） */
  readonly paidNotRefundedMs: number;
  /** ②活跃锁超龄窗口毫秒（架构 §7.2：>24h；slot 过去时刻/TTL 残留/实体终态残留三谓词共用） */
  readonly staleLockMs: number;
  /** ③调度积压阈值毫秒（架构 §7.2：>60s；对齐 I2 SchedulerConfig.backlogAlertMs——判定面
   * 事实源=SchedulerService.backlog()，本键作 patrol 侧对齐位：violation 需 backlog 非空且
   * 最老逾期 ≥ 本键，两键相等时与 backlog() 原语义逐字一致） */
  readonly backlogMs: number;
  /** ④分账指令未确认窗口毫秒（⚠架构 §7.2 未定窗→定 24h 并注记；mock 通道同步确认无窗，
   * M2 真通道换装复核——许可桩清单 W4 增量） */
  readonly splitUnconfirmedMs: number;
  /** ⑤补偿应发未发窗口毫秒（架构 §7.2：>24h；锚=改价生效时刻 created_at） */
  readonly compensationUnpaidMs: number;
}

/** DI 令牌（SLOT_LOCK_CONFIG 同款 Symbol 口径）：纯 interface 经 Symbol 装配，缺 provider 即 fail-fast */
export const PATROL_CONFIG: InjectionToken<PatrolConfig> = Symbol('PATROL_CONFIG');

export const PATROL_DEFAULT_CONFIG: PatrolConfig = {
  intervalMs: 60_000,
  paidNotRefundedMs: 600_000,
  staleLockMs: 86_400_000,
  backlogMs: 60_000,
  splitUnconfirmedMs: 86_400_000,
  compensationUnpaidMs: 86_400_000,
};

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function patrolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PatrolConfig {
  return {
    intervalMs: intFromEnv(env, 'LJR_PATROL_INTERVAL_MS', PATROL_DEFAULT_CONFIG.intervalMs),
    paidNotRefundedMs: intFromEnv(
      env,
      'LJR_PATROL_PAID_NOT_REFUNDED_MS',
      PATROL_DEFAULT_CONFIG.paidNotRefundedMs,
    ),
    staleLockMs: intFromEnv(env, 'LJR_PATROL_STALE_LOCK_MS', PATROL_DEFAULT_CONFIG.staleLockMs),
    backlogMs: intFromEnv(env, 'LJR_PATROL_BACKLOG_MS', PATROL_DEFAULT_CONFIG.backlogMs),
    splitUnconfirmedMs: intFromEnv(
      env,
      'LJR_PATROL_SPLIT_UNCONFIRMED_MS',
      PATROL_DEFAULT_CONFIG.splitUnconfirmedMs,
    ),
    compensationUnpaidMs: intFromEnv(
      env,
      'LJR_PATROL_COMPENSATION_UNPAID_MS',
      PATROL_DEFAULT_CONFIG.compensationUnpaidMs,
    ),
  };
}
