/**
 * H7 规则中心配置（⚠决策位：取文档口径默认值，env 可覆盖；拍板项随批次集中汇报）。
 *
 * 读取口径与 slot-lock.config.ts 相同：进程 env > 代码默认；键前缀 LJR_RULE_*，
 * 非法/非负值回落默认（配置容错，不抛）。
 */
import type { InjectionToken } from '@nestjs/common';

export interface RuleCenterConfig {
  /**
   * 公示期满时长毫秒（§2/§4/R-01：≥7 日）⚠决策位——电商法 §34 底线为法律约束非业务可调参数，
   * env 仅测试/演练用途；生产保持默认 7d。
   */
  readonly publicationMs: number;
  /**
   * RULE_EFFECTIVE job 的注册缓冲毫秒：dueAt = effective_at + 本值 ⚠决策位。recheck 以 DB 时钟
   * 判 effective_at 窗口而 due_at 由应用时钟写入——两钟微漂移会让 job 恰在窗口前一刻到期并被
   * recheck 判过期 CANCELLED（生效 job 丢失且无重试）。缓冲让 job 恒晚于窗口到期（生效最多晚
   * 本值；快照按 effective_at 判定，行为时刻语义不变，保守方向安全）。
   */
  readonly effectiveJobDelayMs: number;
  /**
   * 现行版进程内缓存 TTL 安全网毫秒（§8「缓存现行版+版本号失效」：写路径逐 key 失效为精确通道，
   * TTL 只兜跨进程/跨节点写读的失效盲区——单机 dev 精确，多节点最迟 TTL 后一致）⚠决策位；
   * 0=禁用 TTL 纯失效。Redis 实现位=M2+（Ruling-3 本批次不引入，缓存口留适配 port）。
   */
  readonly currentCacheTtlMs: number;
  /** 房间须知 rule_key（§2：room_notice；D5 进房拉取的缺省键） */
  readonly noticeRuleKey: string;
}

/**
 * DI 令牌（CONFIG_PROVIDER/SLOT_LOCK_CONFIG 同款 Symbol 口径）：RuleCenterConfig 是纯 interface，
 * 运行时无类型 token 可寻址——经此 Symbol 装配（module providers: { provide, useFactory:
 * () => ruleCenterConfigFromEnv(process.env) }），service @Inject(RULE_CENTER_CONFIG) 注入；
 * 缺装配即启动期 fail-fast，不静默回落。
 */
export const RULE_CENTER_CONFIG: InjectionToken<RuleCenterConfig> = Symbol('RULE_CENTER_CONFIG');

/** 默认值=H7 §2/§4/§8 文档口径（公示 7 日）+ ⚠决策位（缓冲 60s / 缓存 TTL 60s / 键 room_notice） */
export const RULE_CENTER_DEFAULT_CONFIG: RuleCenterConfig = {
  publicationMs: 7 * 86_400_000,
  effectiveJobDelayMs: 60_000,
  currentCacheTtlMs: 60_000,
  noticeRuleKey: 'room_notice',
};

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

export function ruleCenterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuleCenterConfig {
  const noticeKey = env['LJR_RULE_NOTICE_KEY'];
  return {
    publicationMs: intFromEnv(
      env,
      'LJR_RULE_PUBLICATION_MS',
      RULE_CENTER_DEFAULT_CONFIG.publicationMs,
    ),
    effectiveJobDelayMs: intFromEnv(
      env,
      'LJR_RULE_EFFECTIVE_JOB_DELAY_MS',
      RULE_CENTER_DEFAULT_CONFIG.effectiveJobDelayMs,
    ),
    currentCacheTtlMs: intFromEnv(
      env,
      'LJR_RULE_CURRENT_CACHE_TTL_MS',
      RULE_CENTER_DEFAULT_CONFIG.currentCacheTtlMs,
    ),
    noticeRuleKey:
      typeof noticeKey === 'string' && noticeKey.length > 0
        ? noticeKey
        : RULE_CENTER_DEFAULT_CONFIG.noticeRuleKey,
  };
}
