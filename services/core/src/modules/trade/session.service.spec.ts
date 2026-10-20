import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  SESSION_CREATED_TOPIC,
  SESSION_FAILED_TOPIC,
  SESSION_FULL_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { CreditRestrictionCache } from '../credit/credit.cache';
import { CreditService } from '../credit/credit.service';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { seedLawyerProfile } from '../identity/lawyer-fixture';
import { LawyerQualificationService } from '../identity/lawyer.service';
import { seedPaidEnrollmentRaw, seedSessionAtRaw } from './trade-fixture';
import { RuleCenterService } from '../ops/rule-center.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { SLOT_ABUSE_DETECTED_TOPIC } from '../schedule/slot-lock.events';
import { SlotLockService } from '../schedule/slot-lock.service';
import { TerminalStateRegistry } from '../schedule/slot-lock.terminal-registry';
import type { CreateSessionInput } from './session.types';
import { SchedulerService } from '../schedule/scheduler.service';
import { SessionTerminalProvider } from './session.terminal-provider';
import { SessionService } from './session.service';
import { TradeModule } from './trade.module';

/**
 * C1 领域层（需 PG）：开团事务（B2 加锁+INSERT 同事务）、幂等键=lawyer+slot_start（F1 R-02
 * 口径）、R-01 本次价格仅进快照（B3 行不改）、R-04 session_total 双模式基数、R-05 停接 403、
 * W1 前置②拒绝不持久（SLOT_TAKEN/SLOT_ABUSE_LIMIT 零残留）、W1 前置⑤ isTerminalBatch 注册、
 * 真并发同段仅一胜、ENROLL_DEADLINE 执行器（流标+SessionFailed 出箱+锁同事务释放+R-02 回查）、
 * markFull 消费位（C3=T7 预留）。
 */

const HOUR = 3_600_000;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** credit.rules 种子（最小生效版本）：lawyer_price_abuse 行为映射 BAN_PUBLISH 限制令（R-05 测试锚） */
const RULES_SEED_BAN_PUBLISH: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    lawyer_price_abuse: { delta: -20, restriction: { kind: 'BAN_PUBLISH', days: 7 } },
  },
};

describe('C1 领域层（开团事务/幂等/R-01/R-04/R-05/截止流标/终态 provider，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let sessions: SessionService;
  let pricing: PricingConfigService;
  let credit: CreditService;
  let rules: RuleCenterService;
  let locks: SlotLockService;
  let scheduler: SchedulerService;
  let terminals: TerminalStateRegistry;
  let creditCache: CreditRestrictionCache;

  const hourAfter = (h: number): Date => new Date(Date.now() + h * HOUR);

  /** B3 默认价种子（one_on_one_prices 为 B3 契约必填矩阵，值不影响本模块断言） */
  const seedPricing = (
    lawyerId: number,
    fields: { per_head?: string; session_total?: string } = {},
  ): Promise<unknown> =>
    pricing.putPricing(lawyerId, {
      base_version: 0,
      per_head: fields.per_head ?? null,
      session_total: fields.session_total ?? null,
      group_size: 6,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });

  const createInput = (over: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
    lawyer_id: 9101,
    slot_start: hourAfter(25),
    price_mode: 'per_head',
    capacity: 6,
    room_mode: 'text',
    ...over,
  });

  const countOutbox = async (topic: string): Promise<number> => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [topic],
    );
    return res.rows[0]!.n;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TradeModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // onModuleInit：ENROLL_DEADLINE 执行器 + session 终态 provider 注册
    sessions = app.get(SessionService);
    pricing = app.get(PricingConfigService);
    credit = app.get(CreditService);
    rules = app.get(RuleCenterService);
    locks = app.get(SlotLockService);
    scheduler = app.get(SchedulerService);
    terminals = app.get(TerminalStateRegistry);
    creditCache = app.get(CreditRestrictionCache);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    // 进程内缓存不随 TRUNCATE 失效：清 G1 限制令缓存（R-05 用例发行后跨用例残留）
    creditCache.invalidateOwner({ ownerType: 'lawyer', ownerId: 9101 });
    creditCache.invalidateOwner({ ownerType: 'lawyer', ownerId: 9102 });
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('开团事务：B2 加锁+INSERT 同事务落 CREATED 行，SessionCreated 出箱，六类 job 预写（REMIND×4 锚 slot_start、ENROLL_DEADLINE 锚 deadline、ROOM_OPEN 只预写）', async () => {
    await seedPricing(9101, { per_head: '50.00' });
    const slotStart = hourAfter(25);
    const view = await sessions.create(createInput({ slot_start: slotStart }));

    expect(view.mode).toBe('B2C');
    expect(view.status).toBe('CREATED');
    expect(view.joined).toBe(0);
    expect(view.unit_price).toBe('50.00'); // R-01：缺省取 B3 默认，快照进行
    expect(view.session_total).toBe('300.00'); // R-04：per_head=单价×capacity
    const expectedDeadline = new Date(slotStart.getTime() - 24 * HOUR);
    expect(
      Math.abs(new Date(view.enroll_deadline).getTime() - expectedDeadline.getTime()),
    ).toBeLessThan(1_500);

    const row = await pool.query<{ unit_price: string; session_total: string; status: string }>(
      `SELECT unit_price::text AS unit_price, session_total::text AS session_total, status
         FROM trade.sessions WHERE id = $1`,
      [view.id],
    );
    expect(row.rows[0]).toMatchObject({
      unit_price: '50.00',
      session_total: '300.00',
      status: 'CREATED',
    });

    const created = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [SESSION_CREATED_TOPIC],
    );
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]!.payload).toMatchObject({
      id: view.id,
      lawyer_id: 9101,
      enroll_deadline: view.enroll_deadline,
    });

    // 六类 job 预写（I2 目录在册；ROOM_OPEN executor=D1=M2 只预写不装配）
    const jobs = await scheduler.listJobs({ limit: 50 });
    const byType = (t: string) => jobs.filter((j) => j.jobType === t && j.refId === view.id);
    expect(byType('ENROLL_DEADLINE')).toHaveLength(1);
    expect(byType('ROOM_OPEN')).toHaveLength(1);
    for (const t of ['REMIND_24H', 'REMIND_1H', 'REMIND_10MIN', 'REMIND_1MIN']) {
      expect(byType(t)).toHaveLength(1);
    }
    const deadlineJob = byType('ENROLL_DEADLINE')[0]!;
    expect(Math.abs(deadlineJob.dueAt.getTime() - expectedDeadline.getTime())).toBeLessThan(1_500);
    const roomOpenJob = byType('ROOM_OPEN')[0]!;
    expect(Math.abs(roomOpenJob.dueAt.getTime() - slotStart.getTime())).toBeLessThan(1_500);
    expect(byType('REMIND_24H')[0]!.dueAt.getTime()).toBeLessThan(slotStart.getTime());
    expect(jobs.every((j) => j.status === 'PENDING')).toBe(true);
  });

  it('R-01：本次价格仅进快照不改 B3 默认（自定义 unit_price 开团后 B3 行原值原版本）', async () => {
    await seedPricing(9101, { per_head: '50.00' });
    const before = await pricing.getCurrentPricing(9101);
    const view = await sessions.create(createInput({ unit_price: '66.00', capacity: 5 }));
    expect(view.unit_price).toBe('66.00');
    expect(view.session_total).toBe('330.00'); // R-04：66.00×5
    const after = await pricing.getCurrentPricing(9101);
    expect(after).toEqual(before); // B3 行未被改（版本/字段全等）
  });

  it('R-04 session_total 模式：入参=开团总价落 session_total，unit_price=总价÷capacity 半分向上分摊', async () => {
    const total = await sessions.create(
      createInput({
        lawyer_id: 9101,
        price_mode: 'session_total',
        unit_price: '100.01',
        capacity: 2,
      }),
    );
    expect(total.session_total).toBe('100.01');
    expect(total.unit_price).toBe('50.01'); // 10001 分 ÷2 = 5000.5 → 半分向上 5001

    // 不同律师（B2 R-03 计数：同一发起人进行中锁 ≤1，同律师第二场进行中会被 429——见 W1 前置②）
    const half = await sessions.create(
      createInput({
        lawyer_id: 9105,
        price_mode: 'session_total',
        unit_price: '1.00',
        capacity: 8,
        slot_start: hourAfter(30),
      }),
    );
    expect(half.session_total).toBe('1.00');
    expect(half.unit_price).toBe('0.13'); // 100 分 ÷8 = 12.5 → 半分向上 13
  });

  it('unit_price 缺省：per_head/session_total 双模式取 B3 默认；B3 无默认价 → 400 不落行', async () => {
    await seedPricing(9101, { session_total: '200.00' });
    const view = await sessions.create(createInput({ price_mode: 'session_total', capacity: 4 }));
    expect(view.session_total).toBe('200.00');
    expect(view.unit_price).toBe('50.00'); // 20000÷4

    await expect(
      sessions.create(createInput({ lawyer_id: 9199, slot_start: hourAfter(30) })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.sessions WHERE lawyer_id = 9199`,
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('幂等键=lawyer+slot_start：同载荷（含缺省同解）重放返回原单；异载荷 409 E_SESSION_DUP_KEY；他律师同段互不影响', async () => {
    await seedPricing(9101, { per_head: '50.00' });
    const slotStart = hourAfter(25);
    const first = await sessions.create(createInput({ slot_start: slotStart }));
    const replay = await sessions.create(
      createInput({ slot_start: slotStart, unit_price: '50.00' }), // 显式值=缺省解 → 同载荷口径
    );
    expect(replay.id).toBe(first.id);
    expect(await countOutbox(SESSION_CREATED_TOPIC)).toBe(1); // 重放不重复出事件

    await expect(
      sessions.create(createInput({ slot_start: slotStart, capacity: 8 })),
    ).rejects.toMatchObject({ code: ErrorCode.SessionDuplicateKey });

    const other = await sessions.create(
      createInput({ lawyer_id: 9102, slot_start: slotStart, unit_price: '55.00' }),
    );
    expect(other.id).not.toBe(first.id); // 占用锁按 (lawyer, slot) 唯一：不同律师同段各自成团
  });

  it('R-05 停接：活跃 BAN_PUBLISH 限制令 → 403 E_RESTRICTED 且零业务行', async () => {
    const pg = app.get(PgPoolService);
    await pg.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: RULES_SEED_BAN_PUBLISH,
        effectiveAt: new Date(Date.now() - 10 * HOUR),
      }),
    );
    await credit.emit({
      owner_type: 'lawyer',
      owner_id: 9101,
      action: 'lawyer_price_abuse',
      ref_type: 'price_change',
      ref_id: 1,
    });
    await expect(sessions.create(createInput())).rejects.toMatchObject({
      code: ErrorCode.Restricted,
      httpStatus: 403,
    });
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trade.sessions`);
    expect(n.rows[0]!.n).toBe(0);
    expect(await countOutbox(SESSION_CREATED_TOPIC)).toBe(0);
  });

  it('W1 前置②：SLOT_TAKEN → 409 且 sessions 零残留（23505 毒化整事务回滚）；SLOT_ABUSE_LIMIT → 429 零残留且 SlotAbuseDetected 经独立连接可见', async () => {
    // SLOT_TAKEN 造径：他 ref（groupbuy）先行占用同段活跃锁，C1 开团撞 B2 唯一防线
    const slotStart = hourAfter(25);
    const pg = app.get(PgPoolService);
    await pg.withTransaction(async (uow) => {
      const locked = await locks.lockSlot(uow, {
        lawyerId: 9101,
        slotStart,
        initiatorUserId: 555, // 不同发起人：不触发滥用计数，直落唯一索引冲突
        refType: 'groupbuy',
        refId: 999,
      });
      expect(locked.ok).toBe(true);
    });
    await expect(
      sessions.create(createInput({ slot_start: slotStart, unit_price: '60.00' })),
    ).rejects.toMatchObject({ code: ErrorCode.SlotTaken, httpStatus: 409 });
    const n1 = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trade.sessions`);
    expect(n1.rows[0]!.n).toBe(0);
    expect(await countOutbox(SESSION_CREATED_TOPIC)).toBe(0);

    // SLOT_ABUSE_LIMIT（R-W3-F 收窄后对 B2C 为防御位）：直调 B2 注入 PENDING_PAYMENT 锁（C2B
    // 形态）触发计数——机制用例归 B2 spec 持有（slot-lock.spec R-W3-F 两用例），此处钉消费方
    // 「收到 ok:false 即中止且零业务行」契约；B2C 频控归属=R-W3-H：不设上限，本分支不可自然触发
    await seedPricing(9202, { per_head: '50.00' });
    const a = await sessions.create(createInput({ lawyer_id: 9202 })); // A=LOCKED（不计数，R-W3-F）
    expect(a.status).toBe('CREATED');
    await pg.withTransaction(async (uow) => {
      const pend = await locks.lockSlot(uow, {
        lawyerId: 9202,
        slotStart: hourAfter(40),
        initiatorUserId: 9202,
        refType: 'groupbuy',
        refId: 998,
        paymentOrderId: 501, // PENDING_PAYMENT（计数集内）
      });
      expect(pend.ok).toBe(true);
    });
    await expect(
      sessions.create(
        createInput({ lawyer_id: 9202, slot_start: hourAfter(50), unit_price: '50.00' }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RateLimited, httpStatus: 429 });
    const n2 = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.sessions WHERE lawyer_id = 9202`,
    );
    expect(n2.rows[0]!.n).toBe(1); // 仅 A 场次，B 零残留
    expect(await countOutbox(SESSION_CREATED_TOPIC)).toBe(1);
    expect(await countOutbox(SLOT_ABUSE_DETECTED_TOPIC)).toBeGreaterThanOrEqual(1); // 独立连接不随回滚丢失
  });

  it('真并发同段仅一胜：并发两笔 create（同律师同段异载荷）恰一成功一拒绝，sessions 恰 1 行', async () => {
    await seedPricing(9103, { per_head: '50.00' });
    const slotStart = hourAfter(25);
    const [r1, r2] = await Promise.allSettled([
      sessions.create(createInput({ lawyer_id: 9103, slot_start: slotStart, capacity: 6 })),
      sessions.create(createInput({ lawyer_id: 9103, slot_start: slotStart, capacity: 4 })),
    ]);
    const outcomes = [r1, r2].map((r) =>
      r.status === 'fulfilled' ? ('WIN' as const) : (r.reason as { code?: string }).code,
    );
    expect(outcomes.filter((o) => o === 'WIN')).toHaveLength(1);
    for (const o of outcomes) {
      if (o !== 'WIN') {
        // 败者（R-W3-F 收窄后）：幂等查先到=E_SESSION_DUP_KEY；唯一索引直撞=E_SLOT_TAKEN
        // ——E_RATE_LIMITED 对 B2C 已不可达（B2C 创建即锁 LOCKED 不计数，滥用计数=C2B 专属）
        expect(['E_SESSION_DUP_KEY', 'E_SLOT_TAKEN']).toContain(o);
      }
    }
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.sessions WHERE lawyer_id = 9103`,
    );
    expect(n.rows[0]!.n).toBe(1);
    expect(await countOutbox(SESSION_CREATED_TOPIC)).toBe(1);
  });

  it('ENROLL_DEADLINE 执行器：截止已过仍 CREATED 且未满 → FAILED（STL 留痕）+SessionFailed 出箱+占用锁同事务释放；R-02 迟到 job 回查 CANCELLED 无操作', async () => {
    await seedPricing(9101, { per_head: '50.00' });
    const view = await sessions.create(
      createInput({ slot_start: hourAfter(25), enroll_deadline: new Date(Date.now() - 1_000) }),
    );
    const tick1 = await scheduler.tick('normal');
    expect(tick1.done).toBe(1);

    const row = await pool.query<{ status: string; status_since: Date }>(
      `SELECT status, status_since FROM trade.sessions WHERE id = $1`,
      [view.id],
    );
    expect(row.rows[0]!.status).toBe('FAILED');

    const stl = await pool.query<{ from_status: string; to_status: string; allowed: boolean }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'session' AND entity_id = $1 ORDER BY id`,
      [view.id],
    );
    expect(stl.rows).toEqual([{ from_status: 'CREATED', to_status: 'FAILED', allowed: true }]);

    const failed = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [SESSION_FAILED_TOPIC],
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]!.payload).toMatchObject({
      id: view.id,
      lawyer_id: 9101,
      reason: 'ENROLL_DEADLINE_PASSED',
    });

    // 锁同事务释放（架构 §4.2）：再发显式释放 → ALREADY_RELEASED 幂等探针
    const release = await (app.get(PgPoolService) as PgPoolService).withTransaction((uow) =>
      locks.releaseSlot(uow, { refType: 'session', refId: view.id, reason: 'probe' }),
    );
    expect(release).toEqual({ ok: false, reason: 'ALREADY_RELEASED' });

    // R-02 回查：同 ref 再注册迟到 job（旧行已 DONE，新行入册）→ recheck 判过期 → CANCELLED 无操作
    const reg = await scheduler.registerJob(pool, {
      jobType: 'ENROLL_DEADLINE',
      refType: 'session',
      refId: view.id,
      dueAt: new Date(Date.now() - 1_000),
    });
    const tick2 = await scheduler.tick('normal');
    expect(tick2.cancelled).toBe(1);
    expect(await countOutbox(SESSION_FAILED_TOPIC)).toBe(1); // 不二次出箱
    const deadlineJobs = (await scheduler.listJobs({ jobType: 'ENROLL_DEADLINE' })).filter(
      (j) => j.refId === view.id,
    );
    expect(deadlineJobs.find((j) => j.id === reg.jobId)?.status).toBe('CANCELLED');
  });

  it('截止边界：已满员（joined=capacity 仍 CREATED）不流标（执行器条件 joined<capacity）', async () => {
    await seedPricing(9104, { per_head: '50.00' });
    const view = await sessions.create(
      createInput({
        lawyer_id: 9104,
        slot_start: hourAfter(25),
        enroll_deadline: new Date(Date.now() - 1_000),
      }),
    );
    // 测试夹具直改 joined 模拟 C3 守卫路径（T7）的落库效果：生产代码零 joined 写点（grep 可验）
    await pool.query(`UPDATE trade.sessions SET joined = capacity WHERE id = $1`, [view.id]);
    await scheduler.tick('normal');
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM trade.sessions WHERE id = $1`,
      [view.id],
    );
    expect(row.rows[0]!.status).toBe('CREATED'); // 满员未推进 FULL（C3 职责）但绝不容流标
    expect(await countOutbox(SESSION_FAILED_TOPIC)).toBe(0);
  });

  it('R-W3-G 临期/过期校验（⚠W3-11）：过期 slot_start 400；临期（缺省截止已过）缺省被拒 E_ENROLL_DEADLINE_INVALID；显式未来 deadline 放行、显式过期 deadline 拒绝', async () => {
    // ① slot_start 已过 → 400（E_INVALID_ARGUMENT）
    await expect(
      sessions.create(createInput({ slot_start: new Date(Date.now() - HOUR) })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    const n0 = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trade.sessions`);
    expect(n0.rows[0]!.n).toBe(0);

    // ② 临期（slot_start=+2h ⇒ 缺省截止=now−22h 已过）且未显式传 deadline → 400 E_ENROLL_DEADLINE_INVALID
    await expect(sessions.create(createInput({ slot_start: hourAfter(2) }))).rejects.toMatchObject({
      code: ErrorCode.EnrollDeadlineInvalid,
      httpStatus: 400,
    });
    // 临期 + 显式 deadline 已过 → 同拒（须 now<deadline）
    await expect(
      sessions.create(
        createInput({
          lawyer_id: 9107,
          slot_start: hourAfter(2),
          enroll_deadline: new Date(Date.now() - 1),
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.EnrollDeadlineInvalid });

    // 显式合法 deadline（now < d < slot_start）→ 放行；远期场次缺省截止仍有效（回归锚）
    await seedPricing(9107, { per_head: '50.00' });
    await seedPricing(9108, { per_head: '50.00' });
    const ok = await sessions.create(
      createInput({
        lawyer_id: 9107,
        slot_start: hourAfter(2),
        enroll_deadline: new Date(Date.now() + HOUR),
      }),
    );
    expect(ok.status).toBe('CREATED');
    const far = await sessions.create(createInput({ lawyer_id: 9108 })); // +25h，缺省截止=+1h>now
    expect(far.status).toBe('CREATED');
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trade.sessions WHERE lawyer_id IN (9107, 9108)`,
    );
    expect(n.rows[0]!.n).toBe(2);
  });

  it('markFull 消费位（C3=T7 预留）：joined≥capacity → CREATED→FULL 守卫推进+SessionFull 出箱；未满 409；重放守卫拒绝', async () => {
    await seedPricing(9101, { per_head: '50.00' });
    const view = await sessions.create(createInput());
    await expect(sessions.markFull(view.id)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });

    await pool.query(`UPDATE trade.sessions SET joined = capacity WHERE id = $1`, [view.id]); // 夹具（同上说明）
    const full = await sessions.markFull(view.id);
    expect(full.status).toBe('FULL');

    const stl = await pool.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM platform.state_transition_log
        WHERE entity_type = 'session' AND entity_id = $1 AND allowed = true`,
      [view.id],
    );
    expect(stl.rows).toEqual([{ from_status: 'CREATED', to_status: 'FULL' }]);

    const events = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [SESSION_FULL_TOPIC],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toMatchObject({
      id: view.id,
      lawyer_id: 9101,
      price_mode: 'per_head',
      unit_price: '50.00',
      session_total: '300.00',
    });

    await expect(sessions.markFull(view.id)).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
    });
  });

  it('W1 前置⑤：session 终态 provider 注册到 B2 注册表，批量形态（isTerminalBatch 非回退）；CREATED=false / FAILED=true(since=status_since) / 缺实体跳过', async () => {
    const provider = terminals.get('session');
    expect(provider).toBeInstanceOf(SessionTerminalProvider);
    expect(typeof provider!.isTerminalBatch).toBe('function'); // 活跃锁上万不走逐行回退

    await seedPricing(9101, { per_head: '50.00' });
    await seedPricing(9106, { per_head: '50.00' });
    const alive = await sessions.create(createInput({ lawyer_id: 9101 }));
    const dead = await sessions.create(
      createInput({
        lawyer_id: 9106, // 不同律师（B2 R-03：同发起人进行中锁 ≤1）
        slot_start: hourAfter(30),
        enroll_deadline: new Date(Date.now() - 1_000),
      }),
    );
    await scheduler.tick('normal');

    const infos = await provider!.isTerminalBatch!([alive.id, dead.id, 987654]);
    expect(infos.get(alive.id)).toEqual({ terminal: false, since: null });
    const deadInfo = infos.get(dead.id);
    expect(deadInfo?.terminal).toBe(true);
    expect(deadInfo?.since).toBeInstanceOf(Date);
    expect(infos.get(987654)).toBeUndefined(); // 缺实体：reaper 视同 null 跳过（宁漏不误杀）

    const single = await provider!.isTerminal!(dead.id);
    expect(single?.terminal).toBe(true);
    const missing = await provider!.isTerminal!(987654);
    expect(missing).toBeNull();

    // 终态集钉住：FINISHED 起不再需要占用锁（锁口径），CREATED/FULL/… 仍占
    await pool.query(
      `UPDATE trade.sessions SET status = 'FINISHED', status_since = now() WHERE id = $1`,
      [alive.id],
    ); // 夹具直写仅造 provider 输入（状态机推进路径 D 域=M2）；生产零裸写
    const finished = await provider!.isTerminalBatch!([alive.id]);
    expect(finished.get(alive.id)?.terminal).toBe(true);
  });

  it('详情/列表服务面：getById 详情+剩余席位（404 缺失）；list 仅 PASSED 律师 + lawyer/from/to 过滤；公开列表仅 CREATED（⚠W3-12，FAILED 不出列详情可查）', async () => {
    await seedLawyerProfile(pool, 9301, 'PASSED', 't4-passed');
    await seedLawyerProfile(pool, 9302, 'SUBMITTED', 't4-submitted');
    await seedLawyerProfile(pool, 9303, 'PASSED', 't4-passed-failed');
    const audit = app.get(LawyerQualificationService);
    expect(await audit.isAuditPassed(9301)).toBe(true);
    expect(await audit.isAuditPassed(9302)).toBe(false);

    const today = new Date();
    const ymd = (d: Date): string => d.toISOString().slice(0, 10);
    const v1 = await sessions.create(
      createInput({ lawyer_id: 9301, unit_price: '50.00', slot_start: hourAfter(25) }),
    );
    await sessions.create(
      createInput({ lawyer_id: 9302, unit_price: '50.00', slot_start: hourAfter(26) }),
    );
    // FAILED 场次（流标路径真实产生）：不出公开列表，详情仍可查（⚠W3-12 R-W3-J）
    const v3 = await sessions.create(
      createInput({
        lawyer_id: 9303,
        unit_price: '50.00',
        slot_start: hourAfter(30),
        enroll_deadline: new Date(Date.now() - 1_000),
      }),
    );
    const pg = app.get(PgPoolService);
    await pg.withTransaction((uow) => sessions.failOnDeadline(uow, v3.id));

    const detail = await sessions.getDetail(v1.id);
    expect(detail.remaining).toBe(6); // capacity - joined
    await expect(sessions.getDetail(987654)).rejects.toMatchObject({ code: ErrorCode.NotFound });

    const listAll = await sessions.list({});
    expect(listAll.map((s) => s.lawyer_id)).toEqual([9301]); // 仅 PASSED（9302 隐藏）且仅 CREATED（9303 FAILED 隐藏）
    const listLawyer = await sessions.list({ lawyer: 9302 });
    expect(listLawyer).toEqual([]); // 过滤命中但审核未过 → 不可见
    const listFailedLawyer = await sessions.list({ lawyer: 9303 });
    expect(listFailedLawyer).toEqual([]); // FAILED 不出公开列表（⚠W3-12）
    const listEmptyDay = await sessions.list({
      from: ymd(new Date(today.getTime() + 40 * 24 * HOUR)),
      to: ymd(new Date(today.getTime() + 41 * 24 * HOUR)),
    });
    expect(listEmptyDay).toEqual([]); // 区间外

    const failedDetail = await sessions.getDetail(v3.id); // 详情不过滤（⚠W3-12）
    expect(failedDetail.status).toBe('FAILED');
    expect(failedDetail.remaining).toBe(6);
  });

  it('双维度物化与过滤（序 11.5 V33）：C1 物化 specialty=labor_arbitration + city=执业城市（导出面，null 兜底北京）；GET /sessions city×specialty 双维真过滤；列表/详情出参增列', async () => {
    // 两律师均 PASSED（列表可见性前提）：9310 未登记城市（→ DEFAULT 北京）、9311 执业上海
    await seedLawyerProfile(pool, 9310, 'PASSED', 't-dims-bj');
    await seedLawyerProfile(pool, 9311, 'PASSED', 't-dims-sh', '上海');
    await seedPricing(9310, { per_head: '50.00' });
    await seedPricing(9311, { per_head: '50.00' });
    const bj = await sessions.create(createInput({ lawyer_id: 9310, slot_start: hourAfter(25) }));
    const sh = await sessions.create(createInput({ lawyer_id: 9311, slot_start: hourAfter(26) }));

    // 物化：specialty=V1 恒 labor_arbitration；city=执业城市（null 兜底北京）
    expect(bj).toMatchObject({ specialty: 'labor_arbitration', city: '北京' });
    expect(sh).toMatchObject({ specialty: 'labor_arbitration', city: '上海' });
    const rows = await pool.query<{ specialty: string; city: string }>(
      `SELECT specialty, city FROM trade.sessions WHERE id IN ($1, $2) ORDER BY id`,
      [bj.id, sh.id],
    );
    expect(rows.rows).toEqual([
      { specialty: 'labor_arbitration', city: '北京' },
      { specialty: 'labor_arbitration', city: '上海' },
    ]);

    // city×specialty 双维真过滤（?city=；specialty 从形态收口转真过滤）
    expect((await sessions.list({ city: '北京' })).map((s) => s.id)).toEqual([bj.id]);
    expect((await sessions.list({ city: '上海' })).map((s) => s.id)).toEqual([sh.id]);
    expect(await sessions.list({ city: '广州' })).toEqual([]); // 空集=过滤真生效
    expect((await sessions.list({ specialty: 'labor_arbitration' })).map((s) => s.id)).toEqual([
      bj.id,
      sh.id,
    ]);
    expect(await sessions.list({ specialty: 'contract_dispute' })).toEqual([]);
    expect(await sessions.list({ city: '上海', specialty: 'contract_dispute' })).toEqual([]);
    // 出参增列（列表项 + 详情）
    const shList = await sessions.list({ city: '上海' });
    expect(shList[0]).toMatchObject({ specialty: 'labor_arbitration', city: '上海' });
    expect(await sessions.getDetail(bj.id)).toMatchObject({
      specialty: 'labor_arbitration',
      city: '北京',
    });
  });

  it('R-W3-K 履约 Session 创建服务方法（C2B 确认生成，M2 C4 接线）：mode=C2B 行落库+SessionCreated 出箱+六类 job 预写，B2 不加锁（发布锁 ref=groupbuy 由 C2 持有）', async () => {
    await seedPricing(9101, { per_head: '50.00' });
    const slotStart = hourAfter(30);
    const view = await sessions.createC2BFulfillment({
      group_buy_id: 501,
      lawyer_id: 9101,
      slot_start: slotStart,
      share_price: '33.33',
      capacity: 6,
      room_mode: 'text',
    });

    expect(view.mode).toBe('C2B'); // §3：C2B 确认后生成履约 Session 复用本表 mode=C2B
    expect(view.status).toBe('CREATED');
    expect(view.capacity).toBe(6);
    expect(view.unit_price).toBe('33.33'); // per_head 语义：每人固定分摊快照
    expect(view.session_total).toBe('199.98'); // R-04：33.33×6（整数分，无浮点）

    const row = await pool.query<{ mode: string; status: string }>(
      `SELECT mode, status FROM trade.sessions WHERE id = $1`,
      [view.id],
    );
    expect(row.rows[0]).toEqual({ mode: 'C2B', status: 'CREATED' });

    // SessionCreated 出箱（同事务）
    const created = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [SESSION_CREATED_TOPIC],
    );
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]!.payload).toMatchObject({ id: view.id, lawyer_id: 9101 });

    // 六类 job 预写（与 B2C 同构；ROOM_OPEN executor=D1=M2 只预写）
    const jobs = await scheduler.listJobs({ limit: 50 });
    const byType = (t: string) => jobs.filter((j) => j.jobType === t && j.refId === view.id);
    for (const t of [
      'ENROLL_DEADLINE',
      'ROOM_OPEN',
      'REMIND_24H',
      'REMIND_1H',
      'REMIND_10MIN',
      'REMIND_1MIN',
    ]) {
      expect(byType(t)).toHaveLength(1);
    }

    // B2 不加锁（发布锁 ref=groupbuy 由 C2 持有；锁迁移语义随 C4=M2 设计，报告注明）——
    // activeStatusOf 探针：本 session 无任何活跃锁行
    const lockStatus = await app
      .get(PgPoolService)
      .withTransaction((uow) => app.get(SlotLockService).activeStatusOf(uow, 'session', view.id));
    expect(lockStatus).toBeNull();
  });

  // ===========================================================================
  // sessionOpenable 复合守卫（M2-W3 T5；W2 终审 N-4：ROOM_OPEN 对幽灵 CREATED 场次收紧）
  // ===========================================================================

  it('sessionOpenable 复合守卫（N-4）：幽灵 CREATED（无 PAID 无在册截止 job）→ false；有 PAID 无 job（临期转化形态）/在册截止 job → true；非 CREATED 非终态不受收紧 → true；终态 → false', async () => {
    // ① 幽灵场次：CREATED 且无 PAID 报名且无在册 ENROLL_DEADLINE job（M-2 注记形态的坏孪生：
    //    截止已过、无流标 job 兜底、零迁移参与者）——不再开房
    const ghost = await seedSessionAtRaw(pool, 9101, 'CREATED', hourAfter(2));
    await expect(sessions.sessionOpenable(pool, ghost)).resolves.toBe(false);

    // ② 有 PAID 无 job（临期转化承接形态：createConvertedB2C 条件预写不注册截止 job，
    //    迁移参与者 PAID 在册——N-4 明文放行路径）
    const paidSess = await seedSessionAtRaw(pool, 9101, 'CREATED', hourAfter(2));
    await seedPaidEnrollmentRaw(pool, 'session', paidSess, {
      userId: 9201,
      cash: '50.00',
      points: 0,
      unitPrice: '50.00',
    });
    await expect(sessions.sessionOpenable(pool, paidSess)).resolves.toBe(true);

    // ③ 有在册截止 job 无 PAID（正常 CREATED 场次形态：创建即同事务预写 ENROLL_DEADLINE；
    //    job 写入经 schedule 导出面 registerJob——禁跨 schema 直写，schema-refs 纪律）
    const jobSess = await seedSessionAtRaw(pool, 9101, 'CREATED', hourAfter(2));
    await scheduler.registerJob(pool, {
      jobType: 'ENROLL_DEADLINE',
      refType: 'session',
      refId: jobSess,
      dueAt: hourAfter(1),
    });
    await expect(sessions.sessionOpenable(pool, jobSess)).resolves.toBe(true);

    // ③-b 截止 job 已终态（被作废）= 不在册：CREATED 无 PAID 回到 false（「在册」=非终态口径）
    await scheduler.cancelJob(pool, {
      jobType: 'ENROLL_DEADLINE',
      refType: 'session',
      refId: jobSess,
    });
    await expect(sessions.sessionOpenable(pool, jobSess)).resolves.toBe(false);

    // ④ 非 CREATED 非终态（成团链 CONFIRMED）：收紧只在 CREATED 态——无 job 无 PAID 仍可开
    const confirmed = await seedSessionAtRaw(pool, 9101, 'CONFIRMED', hourAfter(2));
    await expect(sessions.sessionOpenable(pool, confirmed)).resolves.toBe(true);

    // ⑤ 终态回归半边：FAILED → false（原有口径不动）
    const failedSess = await seedSessionAtRaw(pool, 9101, 'FAILED', hourAfter(2));
    await expect(sessions.sessionOpenable(pool, failedSess)).resolves.toBe(false);

    // ⑥ 不存在 → false（原有口径不动）
    await expect(sessions.sessionOpenable(pool, 999_999_999)).resolves.toBe(false);
  });
});
