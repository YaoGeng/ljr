import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { BenefitsModule } from '../benefits/points.module';
import { seedCompensationGrantRef } from '../benefits/points-fixture';
import { PaymentModule } from '../payment/payment.module';
import { seedPaymentOrderRaw, seedRefundRaw, seedSplitLedgerRaw } from '../payment/order-fixture';
import { seedCompSnapshotRaw, seedPriceHistoryRaw } from '../pricing/price-change.fixture';
import { PricingChangeModule } from '../pricing/price-change.module';
import {
  countJobLogsByResult,
  listJobsByType,
  seedPendingJobRaw,
  seedSlotLockRaw,
} from '../schedule/job-fixture';
import { SchedulerModule } from '../schedule/scheduler.module';
import { SchedulerService } from '../schedule/scheduler.service';
import { SlotLockModule } from '../schedule/slot-lock.module';
import { enrollmentOrderKey } from '../trade/enrollment.types';
import { EnrollmentPatrolService } from '../trade/enrollment.patrol';
import { TradeModule } from '../trade/trade.module';
import {
  backdateGroupBuyStatusSince,
  backdateSessionStatusSince,
  seedGroupBuyRaw,
  seedPaidEnrollmentRaw,
  seedSessionRaw,
} from '../trade/trade-fixture';
import { MockPatrolAlertSink } from './patrol.alerts';
import { PatrolModule } from './patrol.module';
import { PatrolService } from './patrol.service';

/**
 * H4 资损巡检 DB spec（M1-W4 Task 1，TDD 先行）：五类不变量故障注入各 ≥1 + 清零断言（最小
 * 正常夹具）+ 幂等 dedup + 单类失败隔离 + RISK_PATROL 执行器接线。
 *
 * 断言面纪律（check-schema-refs owner 口径，w3-smoke 同款）：直查断言=ops 本域（patrol 两表）
 * + platform 白名单；trade/payment/pricing/benefits/schedule 故障注入与清零夹具全走 owner 侧
 * fixture 函数（跨域夹具归 owner 侧先例），本 spec 不内联他域表名。
 *
 * 窗口时序：故障数据回拨超默认窗（①20min>10min、②④⑤30h>24h、③5min>60s）——验证默认阈值
 * 抄架构 §7.2 口径；清零夹具全为「当下时刻」正常形态。
 */

const MIN = 60_000;
const HOUR = 3_600_000;
/** 故障注入回拨：20min（>①10min 窗） */
const AGO_20MIN = 20 * MIN;
/** 故障注入回拨：30h（>②④⑤24h 窗） */
const AGO_30H = 30 * HOUR;

let pool: Pool;
let app: INestApplication;
let patrol: PatrolService;
let scheduler: SchedulerService;
let sink: MockPatrolAlertSink;

interface FindingRow {
  readonly id: string;
  readonly kind: string;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly severity: string;
  readonly detail: Record<string, unknown>;
  readonly resolved_at: Date | null;
}

async function listFindings(): Promise<FindingRow[]> {
  const res = await pool.query<FindingRow>(
    `SELECT id, kind, ref_type, ref_id, severity, detail, resolved_at
       FROM ops.patrol_findings ORDER BY id`,
  );
  return res.rows;
}

async function listRuns(): Promise<
  { id: string; status: string; finding_count: number; checked_counts: Record<string, unknown> }[]
> {
  const res = await pool.query<{
    id: string;
    status: string;
    finding_count: number;
    checked_counts: Record<string, unknown>;
  }>(`SELECT id, status, finding_count, checked_counts FROM ops.patrol_runs ORDER BY id`);
  return res.rows;
}

/** 单类失败隔离用毒桩（无参构造 + 检测面抛错；overrideProvider 注入） */
class FailingEnrollmentPatrol {
  async findRefundDueCandidates(): Promise<never[]> {
    throw new Error('boom: patrol fault-injection');
  }
}

async function buildPatrolApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      InfrastructureModule,
      SchedulerModule,
      SlotLockModule,
      BenefitsModule,
      PaymentModule,
      TradeModule,
      PricingChangeModule,
      PatrolModule,
    ],
  }).compile();
  const appRef = moduleRef.createNestApplication();
  await appRef.init();
  return appRef;
}

beforeAll(async () => {
  pool = await ensureTestDatabase();
  app = await buildPatrolApp();
  patrol = app.get(PatrolService);
  scheduler = app.get(SchedulerService);
  sink = app.get(MockPatrolAlertSink);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  sink.alerts.length = 0;
});

// ---------------------------------------------------------------------------
// ① PAID_NOT_REFUNDED：已支付但场次终态且未发起退款 >10min（锚=终态迁移时刻）
// ---------------------------------------------------------------------------

describe('巡检① PAID_NOT_REFUNDED（故障注入×3 + 窗口锚）', () => {
  it('已支付+场次终态超窗+无退款单 → CRITICAL 入账 + sink 告警 + run 行 DONE', async () => {
    const sessionId = await seedSessionRaw(pool, 301, 'FAILED', 1);
    await backdateSessionStatusSince(pool, sessionId, AGO_20MIN);
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 401,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    // 支付单存在（幂等键 enroll/e{id}/pay）但无任何退款单 → 未发起退款
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(1),
      bizId: 1,
      status: 'PAID',
    });

    const summary = await patrol.runOnce();

    expect(summary.status).toBe('DONE');
    expect(summary.findingCount).toBe(1);
    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'PAID_NOT_REFUNDED',
      ref_type: 'enrollment',
      ref_id: '1',
      severity: 'CRITICAL',
      resolved_at: null,
    });
    expect(findings[0]!.detail).toMatchObject({ reason: 'NO_REFUND_INITIATED' });
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ kind: 'PAID_NOT_REFUNDED', refId: 1 });
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'DONE', finding_count: 1 });
  });

  it('在途退款（PROCESSING）不算未发起；终局 FAILED 退款=资损未消除仍检出', async () => {
    // 在途：PROCESSING → 不入账
    const s1 = await seedSessionRaw(pool, 302, 'FAILED', 2);
    await backdateSessionStatusSince(pool, s1, AGO_20MIN);
    await seedPaidEnrollmentRaw(pool, 'session', s1, {
      userId: 402,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const order1 = await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(1),
      bizId: 1,
      status: 'PAID',
    });
    await seedRefundRaw(pool, {
      orderId: order1,
      userId: 402,
      status: 'PROCESSING',
      idempotencyKey: 'refund/po-1/in-flight',
    });

    // 终局失败：全部 FAILED → 检出（reason=REFUND_ALL_FAILED）
    const s2 = await seedSessionRaw(pool, 303, 'FAILED', 3);
    await backdateSessionStatusSince(pool, s2, AGO_20MIN);
    await seedPaidEnrollmentRaw(pool, 'session', s2, {
      userId: 403,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    const order2 = await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(2),
      bizId: 2,
      status: 'PAID',
    });
    await seedRefundRaw(pool, {
      orderId: order2,
      userId: 403,
      status: 'FAILED',
      idempotencyKey: 'refund/po-2/exhausted',
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ref_id: '2', severity: 'CRITICAL' });
    expect(findings[0]!.detail).toMatchObject({ reason: 'REFUND_ALL_FAILED' });
  });

  it('窗口锚=终态迁移时刻：终态 <10min 不检出；拼团 EXPIRED 支线同检出', async () => {
    // 终态迁移 5min 前（<10min 窗）→ 不检出
    const s1 = await seedSessionRaw(pool, 304, 'FAILED', 4);
    await backdateSessionStatusSince(pool, s1, 5 * MIN);
    await seedPaidEnrollmentRaw(pool, 'session', s1, {
      userId: 404,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(1),
      bizId: 1,
      status: 'PAID',
    });

    // 拼团 EXPIRED 超窗 → 检出
    const g = await seedGroupBuyRaw(pool, 305, 'EXPIRED');
    await backdateGroupBuyStatusSince(pool, g, AGO_20MIN);
    await seedPaidEnrollmentRaw(pool, 'groupbuy', g, {
      userId: 405,
      cash: '80.00',
      points: 0,
      unitPrice: '80.00',
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'PAID_NOT_REFUNDED',
      ref_type: 'enrollment',
      ref_id: '2',
    });
  });
});

// ---------------------------------------------------------------------------
// ② STALE_LOCK：活跃锁 >24h / 锁与实体状态不一致
// ---------------------------------------------------------------------------

describe('巡检② STALE_LOCK（故障注入×3 + 未来段位不误报）', () => {
  it('段位开始超 24h 仍活跃 → WARN 入账（SLOT_PAST），WARN 级不触发 sink', async () => {
    const sessionId = await seedSessionRaw(pool, 311, 'CONFIRMED', 10);
    const lockId = await seedSlotLockRaw(pool, {
      lawyerId: 311,
      refType: 'session',
      refId: sessionId,
      status: 'LOCKED',
      slotStartAgoMs: AGO_30H,
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'STALE_LOCK',
      ref_type: 'slot_lock',
      ref_id: String(lockId),
      severity: 'WARN',
    });
    expect(findings[0]!.detail.reasons).toContain('SLOT_PAST');
    expect(sink.alerts).toHaveLength(0); // WARN=台账留痕，不进 CRITICAL 告警通道
  });

  it('实体终态超 24h 锁仍活跃（reaper 失效形态）→ ENTITY_TERMINAL 检出；未来段位锁不误报', async () => {
    const sessionId = await seedSessionRaw(pool, 312, 'FAILED', 11);
    await backdateSessionStatusSince(pool, sessionId, AGO_30H);
    const staleLockId = await seedSlotLockRaw(pool, {
      lawyerId: 312,
      refType: 'session',
      refId: sessionId,
      status: 'LOCKED',
      slotStartAgoMs: AGO_30H,
    });
    // 未来段位合法 LOCKED 锁（C1 创建即锁形态）→ 不检出（若锚 created_at 即假阳——防线注记）
    await seedSlotLockRaw(pool, {
      lawyerId: 313,
      refType: 'session',
      refId: sessionId + 1,
      status: 'LOCKED',
      slotStartAgoMs: -7 * 24 * HOUR, // 段位在 7 天后
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ref_id).toBe(String(staleLockId));
    expect(findings[0]!.detail.reasons).toContain('ENTITY_TERMINAL');
  });

  it('PENDING_PAYMENT TTL 残留超窗 → TTL_PAST 检出', async () => {
    const sessionId = await seedSessionRaw(pool, 314, 'CONFIRMED', 12);
    await seedSlotLockRaw(pool, {
      lawyerId: 314,
      refType: 'session',
      refId: sessionId,
      status: 'PENDING_PAYMENT',
      slotStartAgoMs: AGO_30H,
      ttlAtAgoMs: AGO_30H,
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail.reasons).toContain('TTL_PAST');
  });
});

// ---------------------------------------------------------------------------
// ③ SCHED_BACKLOG：schedule_jobs 积压/逾期 >60s（消费 I2 backlog()，只看 PENDING 逾期）
// ---------------------------------------------------------------------------

describe('巡检③ SCHED_BACKLOG（故障注入 + NO_EXECUTOR 已知噪音区分）', () => {
  it('PENDING job 逾期 5min → WARN 聚合入账（ref_id=0 哨兵，detail 带积压计数）', async () => {
    await seedPendingJobRaw(pool, {
      jobType: 'REMIND_24H',
      refType: 'session',
      refId: 999,
      dueAtAgoMs: 5 * MIN,
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'SCHED_BACKLOG',
      ref_type: 'schedule_jobs',
      ref_id: '0',
      severity: 'WARN',
    });
    expect(findings[0]!.detail.overdue_jobs).toBe(1);
    expect(sink.alerts).toHaveLength(0);
  });

  it('NO_EXECUTOR→FAILED 已知噪音形态（REMIND_*，04 §8 #33）不算积压不误报', async () => {
    // 真路径构造：无执行器类型到期 → I2 tick 判 FAILED（NO_EXECUTOR）——巡检不应将其计入积压
    await seedPendingJobRaw(pool, {
      jobType: 'REMIND_1H',
      refType: 'session',
      refId: 998,
      dueAtAgoMs: 5 * MIN,
    });
    const tick = await scheduler.tick('normal');
    expect(tick.failed).toBe(1);
    expect(await countJobLogsByResult(pool, 'REMIND_1H', 'NO_EXECUTOR')).toBe(1);

    await patrol.runOnce();

    expect(await listFindings()).toHaveLength(0); // PENDING 逾期 0 条（该行已 FAILED）
  });
});

// ---------------------------------------------------------------------------
// ④ SPLIT_UNCONFIRMED：分账指令发出但渠道未确认（mock 通道语义注记见 payment.patrol 头注）
// ---------------------------------------------------------------------------

describe('巡检④ SPLIT_UNCONFIRMED（故障注入 + CONFIRMED 清零）', () => {
  it('ISSUED 指令超 24h 未确认 → CRITICAL 入账 + sink 告警', async () => {
    const ledgerId = await seedSplitLedgerRaw(pool, {
      direction: 'SPLIT',
      status: 'ISSUED',
      createdAtAgoMs: AGO_30H,
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'SPLIT_UNCONFIRMED',
      ref_type: 'split_ledger',
      ref_id: String(ledgerId),
      severity: 'CRITICAL',
    });
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ kind: 'SPLIT_UNCONFIRMED' });
  });

  it('CONFIRMED 指令（mock 同步确认形态）不检出', async () => {
    await seedSplitLedgerRaw(pool, {
      direction: 'SPLIT',
      status: 'CONFIRMED',
      createdAtAgoMs: AGO_30H,
    });

    await patrol.runOnce();

    expect(await listFindings()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ⑤ COMPENSATION_UNPAID：补偿应发未发 >24h（M2-W2 T6 #39 收口：对照 V44 comp_snapshots——
// granted=false 快照行=真未发；granted=true=已发；快照零行=无补偿对象零假阳——原「零已支付
// 合法行检出 CRITICAL」假阳形态回归收口，04 §8 #39）
// ---------------------------------------------------------------------------

describe('巡检⑤ COMPENSATION_UNPAID（#39 快照对照：真未发 + 已发清零 + 零快照零假阳回归）', () => {
  it('EFFECTED DOWN 在团超 24h 存在 granted=false 快照行 → CRITICAL 入账 + sink 告警', async () => {
    const historyId = await seedPriceHistoryRaw(pool, {
      lawyerId: 321,
      createdAtAgoMs: AGO_30H,
    });
    await seedCompSnapshotRaw(pool, {
      priceChangeId: historyId,
      userId: 421,
      points: 1500,
      granted: false,
    });

    await patrol.runOnce();

    const findings = await listFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'COMPENSATION_UNPAID',
      ref_type: 'pricing_history',
      ref_id: String(historyId),
      severity: 'CRITICAL',
    });
    expect(sink.alerts).toHaveLength(1);
  });

  it('granted=true 快照（已发）→ 不检出；**快照零行（零已支付合法行）→ 不检出（原假阳回归）**；UP 方向非候选', async () => {
    const paidId = await seedPriceHistoryRaw(pool, {
      lawyerId: 322,
      createdAtAgoMs: AGO_30H,
    });
    await seedCompSnapshotRaw(pool, {
      priceChangeId: paidId,
      userId: 422,
      points: 1500,
      granted: true,
    });
    // 原假阳形态：EFFECTED DOWN 在团超窗但零快照行（生效时点无已支付补偿对象——V44 前的
    // 「pricing_histories 推算应发」形态必检出 CRITICAL，#39 收口后零检出）
    await seedPriceHistoryRaw(pool, { lawyerId: 324, createdAtAgoMs: AGO_30H });
    await seedPriceHistoryRaw(pool, { lawyerId: 323, direction: 'UP', createdAtAgoMs: AGO_30H });

    await patrol.runOnce();

    expect(await listFindings()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 清零断言：最小正常夹具（五类检测面全覆盖的正常形态）→ 零 findings。防「巡检永远零发现」
// 空转形态由上方五组故障注入红用例证伪（先红后绿）；本组证正常链路不误报。
// ---------------------------------------------------------------------------

describe('清零断言（最小正常夹具）', () => {
  it('正常链路数据 runOnce → 零 findings + 五类计数齐全无 err', async () => {
    // ①：FULL 场次（服务未终止，退款不应发起）+ PAID 报名 + PAID 支付单
    const sessionId = await seedSessionRaw(pool, 331, 'FULL', 20, {
      userId: 431,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });
    await seedPaymentOrderRaw(pool, {
      idempotencyKey: enrollmentOrderKey(1),
      bizId: 1,
      status: 'PAID',
    });
    // ②：未来段位合法 LOCKED 锁（C1 创建即锁形态）
    await seedSlotLockRaw(pool, {
      lawyerId: 331,
      refType: 'session',
      refId: sessionId,
      status: 'LOCKED',
      slotStartAgoMs: -2 * HOUR,
    });
    // ③：无逾期 PENDING job（TRUNCATE 后零行）
    // ④：CONFIRMED 指令（mock 同步确认；超窗龄——确认态不受窗影响，证状态谓词）
    await seedSplitLedgerRaw(pool, {
      direction: 'SPLIT',
      status: 'CONFIRMED',
      createdAtAgoMs: AGO_30H,
    });
    // ⑤：EFFECTED DOWN 在团超窗龄——granted=false 快照行 + 已发授予流水（候选入集→F4 流水
    // 核对通过→零违例的全路径，#39 收口后 belt-and-braces 双闸）
    const historyId = await seedPriceHistoryRaw(pool, {
      lawyerId: 331,
      createdAtAgoMs: AGO_30H,
    });
    await seedCompSnapshotRaw(pool, {
      priceChangeId: historyId,
      userId: 431,
      points: 1500,
      granted: false,
    });
    await seedCompensationGrantRef(pool, 431, `price_change:${historyId}`);

    const summary = await patrol.runOnce();

    expect(summary.status).toBe('DONE');
    expect(summary.findingCount).toBe(0);
    expect(await listFindings()).toHaveLength(0);
    expect(sink.alerts).toHaveLength(0);
    expect(Object.keys(summary.checkedCounts).sort()).toEqual([
      'COMPENSATION_UNPAID',
      'PAID_NOT_REFUNDED',
      'SCHED_BACKLOG',
      'SPLIT_UNCONFIRMED',
      'STALE_LOCK',
    ]);
    for (const stat of Object.values(summary.checkedCounts)) {
      expect(stat.err).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 幂等与韧性
// ---------------------------------------------------------------------------

describe('幂等 dedup 与单类失败隔离', () => {
  it('同违例二轮巡检 findings 不重复（dedup 锚=kind+ref 未处置），告警不重发', async () => {
    const sessionId = await seedSessionRaw(pool, 341, 'FAILED', 30);
    await backdateSessionStatusSince(pool, sessionId, AGO_20MIN);
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      userId: 441,
      cash: '100.00',
      points: 0,
      unitPrice: '100.00',
    });

    const first = await patrol.runOnce();
    const second = await patrol.runOnce();

    expect(first.findingCount).toBe(1);
    expect(second.findingCount).toBe(0); // 重复检出 dedup 短路（inserted=0）
    const findings = await listFindings();
    expect(findings).toHaveLength(1); // 台账不重复
    expect(second.checkedCounts.PAID_NOT_REFUNDED!.findings).toBe(1); // 检出仍在（findings=判定数）
    expect(sink.alerts).toHaveLength(1); // 新入账才告警
    const runs = await listRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.finding_count)).toEqual([1, 0]);
  });

  it('单类检测失败不拖垮整轮：err 记入 checked_counts，其余类照常检出', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        InfrastructureModule,
        SchedulerModule,
        SlotLockModule,
        BenefitsModule,
        PaymentModule,
        TradeModule,
        PricingChangeModule,
        PatrolModule,
      ],
    })
      .overrideProvider(EnrollmentPatrolService)
      .useClass(FailingEnrollmentPatrol)
      .compile();
    const app2 = moduleRef.createNestApplication();
    await app2.init();
    try {
      const patrol2 = app2.get(PatrolService);
      // ④类违例照常可检出
      await seedSplitLedgerRaw(pool, {
        direction: 'DEDUCT',
        status: 'ISSUED',
        createdAtAgoMs: AGO_30H,
      });

      const summary = await patrol2.runOnce();

      expect(summary.status).toBe('DONE'); // 单类失败不 FAILED 整轮
      expect(summary.checkedCounts.PAID_NOT_REFUNDED!.err).toContain('boom');
      expect(summary.checkedCounts.SPLIT_UNCONFIRMED!.inserted).toBe(1);
      expect(summary.findingCount).toBe(1);
    } finally {
      await app2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// RISK_PATROL 执行器接线（I2 真注册——非 NO_EXECUTOR 已知噪音形态）
// ---------------------------------------------------------------------------

describe('RISK_PATROL job 接线（catalog+registry+自投）', () => {
  it('ensureScheduled 引导注册→tick 真执行→run 行落库+下一周期自投+二次引导幂等', async () => {
    // now 回拨 2min → 注册的 dueAt=now-60s（已到期，tick 可直接拾取）
    const first = await patrol.ensureScheduled({ now: new Date(Date.now() - 2 * MIN) });
    expect(first.registered).toBe(true);

    const again = await patrol.ensureScheduled();
    expect(again.registered).toBe(false); // 在册 PENDING 去重（防多节点/重启翻倍）
    expect(again.jobId).toBe(first.jobId);

    const tick = await scheduler.tick('normal');
    expect(tick.done).toBe(1); // RISK_PATROL 执行器真注册（NO_EXECUTOR 形态会是 failed=1）
    expect(tick.failed).toBe(0);

    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('DONE');

    // 执行器 DONE 前自投下一周期（excludeJobId 排除当前轮自见——经 owner 侧只读夹具核验）
    const jobs = await listJobsByType(pool, 'RISK_PATROL');
    expect(jobs.filter((j) => j.status === 'PENDING')).toHaveLength(1);
    const pending = jobs.find((j) => j.status === 'PENDING')!;
    expect(pending.id).toBeGreaterThan(first.jobId);
  });
});
