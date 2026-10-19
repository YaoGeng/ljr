/**
 * H3 工单 SLA 配置（§2：对账差异 24h 硬 / 其余 48h 软——任务简报「配置化」口径；
 * rule-center.config 读取先例：进程 env > 代码默认，非法/非负值回落默认，容错不抛）。
 *
 * SLA 锚=建单 created_at（DB 钟）：建单语句内 now() 同快照推导 sla_due（消除双钟漂移，
 * settlement enterSettlement 的 M-1 DB 钟口径同款）。
 */
import type { InjectionToken } from '@nestjs/common';
import type { TicketCategory } from '@ljr/shared';

export interface TicketConfig {
  /** 对账差异 SLA 毫秒（R-03：架构 §4.4 硬性 24h）⚠决策位：文档口径默认，env 测试用 */
  readonly reconciliationSlaMs: number;
  /** 其余类别 SLA 毫秒（软性 48h）⚠决策位：同上 */
  readonly defaultSlaMs: number;
}

/**
 * DI 令牌（RULE_CENTER_CONFIG 同款 Symbol 口径）：纯 interface 无运行时 token——module
 * useFactory 装配，service @Inject(TICKET_CONFIG) 注入，缺装配即启动期 fail-fast。
 */
export const TICKET_CONFIG: InjectionToken<TicketConfig> = Symbol('TICKET_CONFIG');

export const TICKET_DEFAULT_CONFIG: TicketConfig = {
  reconciliationSlaMs: 24 * 3_600_000,
  defaultSlaMs: 48 * 3_600_000,
};

function msFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

export function ticketConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TicketConfig {
  return {
    reconciliationSlaMs: msFromEnv(env, 'LJR_TICKET_RECONCILIATION_SLA_MS', 24 * 3_600_000),
    defaultSlaMs: msFromEnv(env, 'LJR_TICKET_DEFAULT_SLA_MS', 48 * 3_600_000),
  };
}

/** 按 category 取 SLA 毫秒（reconciliation=24h 硬；其余七类=48h 软，§2 逐字口径） */
export function slaMsForCategory(config: TicketConfig, category: TicketCategory): number {
  return category === 'reconciliation' ? config.reconciliationSlaMs : config.defaultSlaMs;
}
