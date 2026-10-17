import { describe, expect, it } from 'vitest';
import { SCHEDULE_JOB_CATALOG, SCHEDULE_JOB_TYPES, isScheduleJobType } from './scheduler.catalog';
import {
  MockPhoneAlertSink,
  SchedulerAlertService,
  isBacklogExpired,
  isRoomOpenDelayed,
} from './scheduler-alerts';
import {
  SCHEDULER_DEFAULT_CONFIG,
  defaultBackoffMs,
  schedulerConfigFromEnv,
} from './scheduler.config';

/**
 * I2 纯单元（无需 PG）：job 全集注册表、告警判定、配置默认值。
 * job 全集=I2 §2 枚举 + §4 对照表 FIRM_REVERIFY + 控制者裁决 R2 增 RULE_EFFECTIVE（头注见 scheduler.catalog.ts）。
 */
describe('I2 job 全集注册表（§2/§4 + 控制者裁决 R2 + M1-W4 RISK_PATROL）', () => {
  it('全集 23 种且无重复：§2 枚举 20 种 + FIRM_REVERIFY（§4 对照表）+ RULE_EFFECTIVE（裁决 R2）+ RISK_PATROL（M1-W4 T1 H4 资损巡检）', () => {
    expect(SCHEDULE_JOB_TYPES).toHaveLength(23);
    expect(new Set(SCHEDULE_JOB_TYPES).size).toBe(23);
    expect([...SCHEDULE_JOB_TYPES]).toEqual([
      'REMIND_24H',
      'REMIND_1H',
      'REMIND_10MIN',
      'REMIND_1MIN',
      'ENROLL_DEADLINE',
      'ROOM_OPEN',
      'GRACE_END',
      'ABSENT_15M',
      'NO_SHOW_CLOSE',
      'C2B_CONFIRM_TIMEOUT',
      'RESCHEDULE_CONFIRM_TIMEOUT',
      'OOO_ACCEPT_TIMEOUT',
      'OOO_SETTLE_DEFAULT',
      'DIFF_PAY_TIMEOUT',
      'COMPENSATION_DISPATCH',
      'SETTLE_HOLD_RELEASE',
      'SLOT_REAPER',
      'SLOT_TTL',
      'POINTS_EXPIRE',
      'RETENTION_PURGE',
      'FIRM_REVERIFY',
      'RULE_EFFECTIVE',
      'RISK_PATROL',
    ]);
  });

  it('每一条目都有生产方/执行器/回查锚点（§4 对照表齐全，供程序化一致性检查）', () => {
    for (const jobType of SCHEDULE_JOB_TYPES) {
      const def = SCHEDULE_JOB_CATALOG[jobType];
      expect(def.producer, `${jobType}.producer`).not.toBe('');
      expect(def.executor, `${jobType}.executor`).not.toBe('');
      expect(def.recheckAnchor, `${jobType}.recheckAnchor`).not.toBe('');
    }
  });

  it('RULE_EFFECTIVE（裁决 R2）：生产方/执行器=H7，回查锚点=rule_definitions.publish_status', () => {
    expect(SCHEDULE_JOB_CATALOG.RULE_EFFECTIVE).toMatchObject({
      producer: expect.stringContaining('H7'),
      executor: expect.stringContaining('H7'),
      recheckAnchor: expect.stringContaining('rule_definitions.publish_status'),
    });
  });

  it('RISK_PATROL（M1-W4 T1）：生产方/执行器=H4 资损巡检，回查锚点=patrol_runs', () => {
    expect(SCHEDULE_JOB_CATALOG.RISK_PATROL).toMatchObject({
      producer: expect.stringContaining('H4'),
      executor: expect.stringContaining('H4'),
      recheckAnchor: expect.stringContaining('patrol_runs'),
    });
  });

  it('ROOM_OPEN 是唯一高优先级 job（独立扫描通道 ≤5s，§4/§8）', () => {
    const highs = SCHEDULE_JOB_TYPES.filter((t) => SCHEDULE_JOB_CATALOG[t].highPriority);
    expect(highs).toEqual(['ROOM_OPEN']);
  });

  it('RESTRICTION_EXPIRE 排除在外（I2 §2 排除声明：G1 惰性失效不建 job）', () => {
    expect(isScheduleJobType('RESTRICTION_EXPIRE')).toBe(false);
  });

  it('isScheduleJobType：全集内 true，全集外 false', () => {
    expect(isScheduleJobType('ROOM_OPEN')).toBe(true);
    expect(isScheduleJobType('NOT_A_JOB')).toBe(false);
  });
});

describe('I2 告警判定（R-03 / FAILED 处置 / 监控指标）', () => {
  it('R-03 开房延迟 >30s 判定（阈值边界：恰 30s 不告警，>30s 告警）', () => {
    const due = new Date('2026-10-14T20:00:00.000Z');
    expect(isRoomOpenDelayed(due, new Date(due.getTime() + 30_000))).toBe(false);
    expect(isRoomOpenDelayed(due, new Date(due.getTime() + 30_001))).toBe(true);
  });

  it('积压 >60s 判定（H4 联动，阈值边界同款）', () => {
    const due = new Date('2026-10-14T20:00:00.000Z');
    expect(isBacklogExpired(due, new Date(due.getTime() + 60_000))).toBe(false);
    expect(isBacklogExpired(due, new Date(due.getTime() + 60_001))).toBe(true);
  });

  it('同类型 FAILED 5min 去重：同类型第二笔被抑制，不同类型放行', async () => {
    const sink = new MockPhoneAlertSink();
    const alerts = new SchedulerAlertService(sink);
    expect(await alerts.alertJobFailed('POINTS_EXPIRE', 1, 'boom-1')).toBe(true);
    expect(await alerts.alertJobFailed('POINTS_EXPIRE', 2, 'boom-2')).toBe(false); // 5min 内去重
    expect(await alerts.alertJobFailed('SETTLE_HOLD_RELEASE', 3, 'boom-3')).toBe(true);
    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[0]).toMatchObject({ kind: 'JOB_FAILED', jobType: 'POINTS_EXPIRE' });
    expect(sink.alerts[1]).toMatchObject({ kind: 'JOB_FAILED', jobType: 'SETTLE_HOLD_RELEASE' });
  });

  it('开房延迟告警：未超阈值不告警，超阈值告警一次', async () => {
    const sink = new MockPhoneAlertSink();
    const alerts = new SchedulerAlertService(sink);
    const due = new Date(Date.now() - 10_000);
    expect(await alerts.alertRoomOpenDelay(7, due, new Date())).toBe(false);
    expect(sink.alerts).toHaveLength(0);
    expect(await alerts.alertRoomOpenDelay(8, new Date(Date.now() - 45_000), new Date())).toBe(
      true,
    );
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({
      kind: 'ROOM_OPEN_DELAY',
      jobType: 'ROOM_OPEN',
      jobId: 8,
    });
  });
});

describe('I2 配置默认值（§8 节拍 + §4 处置参数）', () => {
  it('默认值：ROOM_OPEN ≤5s、常规 10-15s、退避重试 3 次、>30s/60s 阈值、5min 去重', () => {
    expect(SCHEDULER_DEFAULT_CONFIG.priorityIntervalMs).toBeLessThanOrEqual(5_000);
    expect(SCHEDULER_DEFAULT_CONFIG.normalIntervalMs).toBeGreaterThanOrEqual(10_000);
    expect(SCHEDULER_DEFAULT_CONFIG.normalIntervalMs).toBeLessThanOrEqual(15_000);
    expect(SCHEDULER_DEFAULT_CONFIG.maxRetries).toBe(3);
    expect(SCHEDULER_DEFAULT_CONFIG.roomOpenDelayAlertMs).toBe(30_000);
    expect(SCHEDULER_DEFAULT_CONFIG.backlogAlertMs).toBe(60_000);
    expect(SCHEDULER_DEFAULT_CONFIG.failedAlertDedupMs).toBe(300_000);
  });

  it('退避曲线：指数翻倍、封顶（第 n 次重试 = base·2^(n-1)）', () => {
    const backoff = defaultBackoffMs(SCHEDULER_DEFAULT_CONFIG);
    expect(backoff(1)).toBe(10_000);
    expect(backoff(2)).toBe(20_000);
    expect(backoff(3)).toBe(40_000);
    expect(backoff(100)).toBe(SCHEDULER_DEFAULT_CONFIG.backoffCapMs);
  });

  it('env 覆盖生效（非法值回落默认）', () => {
    const cfg = schedulerConfigFromEnv({
      LJR_SCHEDULER_NORMAL_INTERVAL_MS: '11000',
      LJR_SCHEDULER_PRIORITY_INTERVAL_MS: '3000',
      LJR_SCHEDULER_MAX_RETRIES: '5',
    } as NodeJS.ProcessEnv);
    expect(cfg.normalIntervalMs).toBe(11_000);
    expect(cfg.priorityIntervalMs).toBe(3_000);
    expect(cfg.maxRetries).toBe(5);
    const fallback = schedulerConfigFromEnv({
      LJR_SCHEDULER_MAX_RETRIES: 'not-a-number',
    } as NodeJS.ProcessEnv);
    expect(fallback.maxRetries).toBe(SCHEDULER_DEFAULT_CONFIG.maxRetries);
  });
});
