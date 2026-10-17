import { describe, expect, it } from 'vitest';
import { PATROL_DEFAULT_CONFIG, patrolConfigFromEnv } from './patrol.config';
import { PATROL_KINDS, PATROL_KIND_SEVERITY } from './patrol.types';

/**
 * H4 资损巡检纯单元（无需 PG）：配置默认值（⚠W4-5：五类阈值抄架构 §7.2）+ env 覆盖 + kind
 * 全集与 severity 映射形状。
 */
describe('H4 巡检配置默认值（架构 §7.2）', () => {
  it('五类窗口默认：10min / 24h / 60s / 24h(⚠) / 24h + 分钟级周期', () => {
    expect(PATROL_DEFAULT_CONFIG.paidNotRefundedMs).toBe(600_000); // §7.2 ① >10min
    expect(PATROL_DEFAULT_CONFIG.staleLockMs).toBe(86_400_000); // §7.2 ② >24h
    expect(PATROL_DEFAULT_CONFIG.backlogMs).toBe(60_000); // §7.2 ③ >60s（对齐 backlogAlertMs）
    expect(PATROL_DEFAULT_CONFIG.splitUnconfirmedMs).toBe(86_400_000); // ④ ⚠架构未定窗→24h
    expect(PATROL_DEFAULT_CONFIG.compensationUnpaidMs).toBe(86_400_000); // §7.2 ⑤ >24h
    expect(PATROL_DEFAULT_CONFIG.intervalMs).toBe(60_000); // §7.2「分钟级」
  });

  it('env 覆盖生效（LJR_PATROL_*；非法值回落默认）', () => {
    const cfg = patrolConfigFromEnv({
      LJR_PATROL_PAID_NOT_REFUNDED_MS: '120000',
      LJR_PATROL_INTERVAL_MS: '30000',
    } as NodeJS.ProcessEnv);
    expect(cfg.paidNotRefundedMs).toBe(120_000);
    expect(cfg.intervalMs).toBe(30_000);
    const fallback = patrolConfigFromEnv({
      LJR_PATROL_STALE_LOCK_MS: 'not-a-number',
    } as NodeJS.ProcessEnv);
    expect(fallback.staleLockMs).toBe(PATROL_DEFAULT_CONFIG.staleLockMs);
  });
});

describe('H4 巡检 kind 全集与 severity 映射', () => {
  it('五类 kind 全集（架构 §7.2 逐字，禁第六类）', () => {
    expect([...PATROL_KINDS]).toEqual([
      'PAID_NOT_REFUNDED',
      'STALE_LOCK',
      'SCHED_BACKLOG',
      'SPLIT_UNCONFIRMED',
      'COMPENSATION_UNPAID',
    ]);
  });

  it('severity 映射齐全：资金面 CRITICAL / 履约与调度面 WARN（⚠裁决位）', () => {
    for (const kind of PATROL_KINDS) {
      expect(['INFO', 'WARN', 'CRITICAL']).toContain(PATROL_KIND_SEVERITY[kind]);
    }
    expect(PATROL_KIND_SEVERITY.PAID_NOT_REFUNDED).toBe('CRITICAL');
    expect(PATROL_KIND_SEVERITY.SPLIT_UNCONFIRMED).toBe('CRITICAL');
    expect(PATROL_KIND_SEVERITY.COMPENSATION_UNPAID).toBe('CRITICAL');
    expect(PATROL_KIND_SEVERITY.STALE_LOCK).toBe('WARN');
    expect(PATROL_KIND_SEVERITY.SCHED_BACKLOG).toBe('WARN');
  });
});
