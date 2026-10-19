/**
 * D3 到场判定配置（D3 §11 待澄清点：「容忍窗口最终值（30/45/60s）实现为配置项，默认 60s」
 * 的落位；ticket.config/rule-center.config 读取先例：进程 env > 代码默认，非法/负值回落默认，
 * 容错不抛——配置错误不阻断判定链）。
 *
 * 容忍窗口语义（R-05「判定以宽限结束时点快照为准，30-60s 抖动容忍」）：job1 判定回看
 * [grace_end−tolerance, grace_end] 内有 join 记录即视为在场——断线重连 ≤窗口 不误判
 * （leave 后 rejoin 在飞的事件滞后由窗口吸收）；窗口锚=grace_end 约定时刻（禁 now() 漂移锚）。
 */
import type { InjectionToken } from '@nestjs/common';

export interface AttendanceConfig {
  /**
   * 抖动容忍窗口毫秒（默认 60_000=60s，D3 §11）⚠决策位：30/45/60s 待产品拍板，env 可覆盖
   */
  readonly toleranceMs: number;
}

/**
 * DI 令牌（TICKET_CONFIG/RULE_CENTER_CONFIG 同款 Symbol 口径）：纯 interface 无运行时
 * token——module useFactory 装配，service @Inject(ATTENDANCE_CONFIG) 注入，缺装配即启动期
 * fail-fast；测试 overrideProvider 注入缩短/放宽窗口（R-05 配置项注入用例）。
 */
export const ATTENDANCE_CONFIG: InjectionToken<AttendanceConfig> = Symbol('ATTENDANCE_CONFIG');

export const ATTENDANCE_DEFAULT_CONFIG: AttendanceConfig = {
  toleranceMs: 60_000,
};

function msFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

export function attendanceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AttendanceConfig {
  return {
    toleranceMs: msFromEnv(
      env,
      'LJR_FULFILLMENT_ATTENDANCE_TOLERANCE_MS',
      ATTENDANCE_DEFAULT_CONFIG.toleranceMs,
    ),
  };
}
