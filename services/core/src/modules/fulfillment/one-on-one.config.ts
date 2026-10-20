/**
 * D6 1对1 配置件（W3-2 决策位：D9「接单超时 N 与实结自动确认均=30min 配置化占位」落位——
 * env 键注入不改代码换值；attendance.config 读取先例：进程 env > 代码默认，非法/非正值回落
 * 默认，容错不抛——配置错误不阻断履约链）。
 *
 * 三个时窗 + 一个环境闸：
 *   acceptTimeoutMinutes——接单锅 N（默认 30）：paid_at+N 未接单→LAWYER_TIMEOUT 自动全退；
 *   settleDefaultMinutes——实结默认确认窗（默认 30，D9）：finished_at+30min 双方未确认→
 *     executor 以系统计量值确认（OOO_SETTLE_DEFAULT）；
 *   diffPayMinutes——补差支付窗（默认 15）：DIFF_PENDING 15min 未付→按已服务比例结算
 *     （settle=prepaid）+OneOnOneDiffUnpaid 出箱（DIFF_PAY_TIMEOUT）；
 *   durationCallbackEnabled——duration 计量端点环境闸（I-5b 修复环：dev 面 mock 注入口，
 *     默认仅 dev 开放——staging/prod 404；真链=rtc-im 服务回调换装 M3-W1 届时补通道验签）。
 */
import type { InjectionToken } from '@nestjs/common';

export interface OneOnOneConfig {
  /** 接单超时 N 分钟（W3-2，默认 30）⚠决策位：D9 待产品拍板，env 可覆盖 */
  readonly acceptTimeoutMinutes: number;
  /** 实结默认确认窗分钟（W3-2，默认 30）⚠决策位：D9 待产品拍板，env 可覆盖 */
  readonly settleDefaultMinutes: number;
  /** 补差支付窗分钟（默认 15，R-02「15min 未付按已服务比例结算」） */
  readonly diffPayMinutes: number;
  /** duration 计量端点环境闸（I-5b：默认=LJR_ENV 为 dev/缺省；显式 env 键可覆盖） */
  readonly durationCallbackEnabled: boolean;
}

/**
 * DI 令牌（ATTENDANCE_CONFIG/TICKET_CONFIG 同款 Symbol 口径）：纯 interface 无运行时
 * token——module useFactory 装配，service @Inject(ONE_ON_ONE_CONFIG) 注入，缺装配即启动期
 * fail-fast；测试 overrideProvider 注入缩短窗（时间注入用例）。
 */
export const ONE_ON_ONE_CONFIG: InjectionToken<OneOnOneConfig> = Symbol('ONE_ON_ONE_CONFIG');

export const ONE_ON_ONE_DEFAULT_CONFIG: OneOnOneConfig = {
  acceptTimeoutMinutes: 30,
  settleDefaultMinutes: 30,
  diffPayMinutes: 15,
  durationCallbackEnabled: true, // dev 缺省口径（oneOnOneConfigFromEnv 按 LJR_ENV 收紧）
};

function minutesFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** duration 闸解析：显式 LJR_FULFILLMENT_OOO_DURATION_CALLBACK（true|false）> LJR_ENV 缺省 */
function durationGateFromEnv(env: NodeJS.ProcessEnv): boolean {
  const explicit = env['LJR_FULFILLMENT_OOO_DURATION_CALLBACK'];
  if (explicit === 'true' || explicit === '1') return true;
  if (explicit === 'false' || explicit === '0') return false;
  const envName = env['LJR_ENV'] ?? 'dev';
  return envName === 'dev'; // I-5b：非 dev（staging/prod）默认关闭
}

export function oneOnOneConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OneOnOneConfig {
  return {
    acceptTimeoutMinutes: minutesFromEnv(
      env,
      'LJR_FULFILLMENT_OOO_ACCEPT_TIMEOUT_MIN',
      ONE_ON_ONE_DEFAULT_CONFIG.acceptTimeoutMinutes,
    ),
    settleDefaultMinutes: minutesFromEnv(
      env,
      'LJR_FULFILLMENT_OOO_SETTLE_DEFAULT_MIN',
      ONE_ON_ONE_DEFAULT_CONFIG.settleDefaultMinutes,
    ),
    diffPayMinutes: minutesFromEnv(
      env,
      'LJR_FULFILLMENT_OOO_DIFF_PAY_MIN',
      ONE_ON_ONE_DEFAULT_CONFIG.diffPayMinutes,
    ),
    durationCallbackEnabled: durationGateFromEnv(env),
  };
}
