import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  GROUP_BUY_EXPIRED_TOPIC,
  GROUP_BUY_PUBLISHED_TOPIC,
  GROUP_BUY_REACHED_TOPIC,
  LAWYER_REJECTED_TOPIC,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { CreditRestrictionCache } from '../credit/credit.cache';
import { CreditService } from '../credit/credit.service';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { seedLawyerProfile } from '../identity/lawyer-fixture';
import {
  backdateJobDue,
  backdateLockTtl,
  countActiveLocks,
  getActiveLockId,
} from '../schedule/job-fixture';
import { RuleCenterService } from '../ops/rule-center.service';
import { PricingConfigService } from '../pricing/pricing.service';
import { PaymentGatewayService } from '../payment/payment.gateway.service';
import { countPaymentOrders } from '../payment/order-fixture';
import { SLOT_ABUSE_DETECTED_TOPIC } from '../schedule/slot-lock.events';
import { SlotLockService } from '../schedule/slot-lock.service';
import { TerminalStateRegistry } from '../schedule/slot-lock.terminal-registry';
import { SchedulerService } from '../schedule/scheduler.service';
import { GroupBuyTerminalProvider } from './group-buy.terminal-provider';
import { GroupBuyService } from './group-buy.service';
import { TradeModule } from './trade.module';

/**
 * C2 领域层（需 PG）：发布事务（B2 PENDING_PAYMENT 发布锁+F1 发起人支付单+INSERT 同事务）、
 * 幂等键=user+slot_start（F1 R-02 口径）、R-01 接受范围（⚠W3-5 UNSET/OUT_OF_RANGE 矩阵）、
 * R-02 分摊 HALF_UP 固化+律师改价不影响、R-04 子范围不可变、R-05 达 sub_min 守卫（合成驱动）+
 * REACHED_LOCKED、M-1 超时自动拒（C2B_CONFIRM_TIMEOUT 执行器→LawyerRejected(via_timeout=true)）、
 * 截止流标（EXPIRED+GroupBuyExpired）、未支付 TTL 释放后他人可发布（§10③）、cancel（R-W3-L）、
 * recreate（§10④）、W1 前置②拒绝零业务行、groupbuy 终态 provider。
 */

const HOUR = 3_600_000;

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** credit.rules 种子（最小生效版本）：user_slot_abuse 行为映射 BAN_JOIN 限制令（G1 拦截测试锚） */
const RULES_SEED_BAN_JOIN: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    user_absent: { delta: -50, restriction: { kind: 'BAN_JOIN', days: 7 }, violation: true },
  },
};

describe('C2 领域层（发布事务/幂等/R-01/R-02/R-04/R-05/流标/超时拒/cancel/recreate，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let groupBuys: GroupBuyService;
  let pricing: PricingConfigService;
  let credit: CreditService;
  let rules: RuleCenterService;
  let locks: SlotLockService;
  let scheduler: SchedulerService;
  let payment: PaymentGatewayService;
  let terminals: TerminalStateRegistry;
  let creditCache: CreditRestrictionCache;

  const hourAfter = (h: number): Date => new Date(Date.now() + h * HOUR);

  /** B3 默认价种子（one_on_one_prices 为 B3 契约必填矩阵，值不影响本模块断言） */
  const seedPricing = (
    lawyerId: number,
    fields: {
      session_total?: string | null;
      accept_min?: number | null;
      accept_max?: number | null;
    } = {},
  ): Promise<unknown> =>
    pricing.putPricing(lawyerId, {
      base_version: 0,
      per_head: null,
      session_total: fields.session_total ?? '100.00',
      group_size: null,
      accept_min: fields.accept_min ?? null,
      accept_max: fields.accept_max ?? null,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });

  const createInput = (over: Record<string, unknown> = {}) =>
    ({
      initiator_id: 6101,
      lawyer_id: 9101,
      specialty: 'labor_arbitration',
      slot_start: hourAfter(25),
      sub_min: 3,
      sub_max: 6,
      question_tags: ['劳动仲裁时效'],
      ...over,
    }) as Parameters<GroupBuyService['create']>[0];

  const countOutbox = async (topic: string): Promise<number> => {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [topic],
    );
    return res.rows[0]!.n;
  };

  const countRows = async (sql: string, params: unknown[] = []): Promise<number> => {
    const res = await pool.query<{ n: number }>(sql, params);
    return res.rows[0]!.n;
  };

  /** 到期 job 回拨（owner 侧夹具 job-fixture——确定性触发免真实等待，B2 spec 同款先例） */
  const rewindJob = (jobType: string, refId: number): Promise<void> =>
    backdateJobDue(pool, jobType, 'groupbuy', refId);

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [TradeModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // onModuleInit：C2B_CONFIRM_TIMEOUT 执行器 + groupbuy 终态 provider 注册
    groupBuys = app.get(GroupBuyService);
    pricing = app.get(PricingConfigService);
    credit = app.get(CreditService);
    rules = app.get(RuleCenterService);
    locks = app.get(SlotLockService);
    scheduler = app.get(SchedulerService);
    payment = app.get(PaymentGatewayService);
    terminals = app.get(TerminalStateRegistry);
    creditCache = app.get(CreditRestrictionCache);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    // 进程内缓存不随 TRUNCATE 失效：清 G1 限制令缓存（发行后跨用例残留）
    creditCache.invalidateOwner({ ownerType: 'user', ownerId: 6101 });
    creditCache.invalidateOwner({ ownerType: 'user', ownerId: 6102 });
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('发布事务：INSERT PUBLISHED+share_price 固化+B2 PENDING_PAYMENT 锁绑支付单+F1 支付单（enroll/share_price）+ENROLL job 预写+GroupBuyPublished 出箱，同事务', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const slotStart = hourAfter(25);
    const result = await groupBuys.create(createInput({ slot_start: slotStart }));

    // §5 出参三键：{group_buy, share_price, payment_order}
    expect(Object.keys(result).sort()).toEqual(['group_buy', 'payment_order', 'share_price']);
    expect(result.group_buy.status).toBe('PUBLISHED');
    expect(result.group_buy.sub_min).toBe(3);
    expect(result.share_price).toBe('33.33'); // R-02：100.00÷3=33.333… 亚半 HALF_UP→33.33
    expect(result.group_buy.share_price).toBe('33.33');
    expect(result.group_buy.joined).toBeNull(); // 桩：C3=T7 接线
    expect(result.payment_order.biz_type).toBe('enroll');
    expect(result.payment_order.biz_id).toBe(result.group_buy.id);
    expect(result.payment_order.cash_amount).toBe('33.33');
    expect(result.payment_order.status).toBe('CREATED');

    // B2 PENDING_PAYMENT 发布锁（activeStatusOf 探针）；绑定支付单以 confirmPayment 按
    // payment_order_id 定位成功为证（F1 键→锁行反向可达）
    const pg0 = app.get(PgPoolService);
    expect(
      await pg0.withTransaction((uow) =>
        locks.activeStatusOf(uow, 'groupbuy', result.group_buy.id),
      ),
    ).toBe('PENDING_PAYMENT');
    const bound = await pg0.withTransaction((uow) =>
      locks.confirmPayment(uow, result.payment_order.id),
    );
    expect(bound).toMatchObject({ ok: true, transitioned: true }); // 锁行绑定该支付单

    // ENROLL_DEADLINE job 预写（refType=groupbuy；缺省 deadline=slot_start 前 24h）
    const deadline = new Date(slotStart.getTime() - 24 * HOUR);
    const jobs = (await scheduler.listJobs({ jobType: 'ENROLL_DEADLINE' })).filter(
      (j) => j.refType === 'groupbuy' && j.refId === result.group_buy.id,
    );
    expect(jobs).toHaveLength(1);
    expect(Math.abs(jobs[0]!.dueAt.getTime() - deadline.getTime())).toBeLessThan(1_500);

    // GroupBuyPublished 出箱（§6 载荷逐字）
    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [GROUP_BUY_PUBLISHED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]!.payload).toMatchObject({
      id: result.group_buy.id,
      lawyer_id: 9101,
      sub_min: 3,
      share_price: '33.33',
    });
  });

  it('R-02 分摊固化：发布后律师改价（B3 新版本）→ group_buy.share_price 不变（§10②）', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const result = await groupBuys.create(createInput({ sub_min: 2, sub_max: 6 }));
    expect(result.share_price).toBe('50.00'); // 100.00÷2

    await pricing.putPricing(9101, {
      base_version: 1, // 律师改价：session_total 100→200
      per_head: null,
      session_total: '200.00',
      group_size: null,
      accept_min: 2,
      accept_max: 8,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });
    const row = await pool.query<{ share_price: string }>(
      `SELECT share_price::text AS share_price FROM trade.group_buys WHERE id = $1`,
      [result.group_buy.id],
    );
    expect(row.rows[0]!.share_price).toBe('50.00'); // 快照不受改价影响（R-03）
  });

  it('R-01 越界矩阵（⚠W3-5）：B3 未配置接受范围 → 400 E_ACCEPT_RANGE_UNSET；越界（min-1/max+1/单边）→ 400 E_OUT_OF_RANGE；边界 min/max 放行', async () => {
    // ① B3 两字段 NULL（未配置）→ 400 E_ACCEPT_RANGE_UNSET（律师须先配置）
    await seedPricing(9101, { session_total: '100.00', accept_min: null, accept_max: null });
    await expect(groupBuys.create(createInput())).rejects.toMatchObject({
      code: ErrorCode.AcceptRangeUnset,
      httpStatus: 400,
    });
    expect(await countRows(`SELECT count(*)::int AS n FROM trade.group_buys`)).toBe(0);

    // ② 越界矩阵：B3 接受范围 3..8（律师 9102）；交叉（min>max）在形状层先行 400（非 B3 越界码）
    await seedPricing(9102, { session_total: '100.00', accept_min: 3, accept_max: 8 });
    for (const [lo, hi] of [
      [2, 6], // min-1 越下界
      [6, 9], // max+1 越上界
    ] as const) {
      await expect(
        groupBuys.create(createInput({ lawyer_id: 9102, sub_min: lo, sub_max: hi })),
      ).rejects.toMatchObject({ code: ErrorCode.PriceOutOfRange, httpStatus: 400 });
    }
    await expect(
      groupBuys.create(createInput({ lawyer_id: 9102, sub_min: 8, sub_max: 3 })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument, httpStatus: 400 }); // 形状层
    expect(await countRows(`SELECT count(*)::int AS n FROM trade.group_buys`)).toBe(0);

    // ③ 边界 min/max 恰等放行（子范围 3..8 ⊆ 3..8）
    const edge = await groupBuys.create(createInput({ lawyer_id: 9102, sub_min: 3, sub_max: 8 }));
    expect(edge.group_buy.sub_min).toBe(3);
    expect(edge.group_buy.sub_max).toBe(8);
  });

  it('幂等键=user+slot_start：同载荷重放返回原单（不重复出箱/锁/支付单）；异载荷 409 E_GROUP_BUY_DUP_KEY；他人同段互不影响', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const slotStart = hourAfter(25);
    const first = await groupBuys.create(createInput({ slot_start: slotStart }));

    const replay = await groupBuys.create(createInput({ slot_start: slotStart }));
    expect(replay.group_buy.id).toBe(first.group_buy.id);
    expect(replay.payment_order.id).toBe(first.payment_order.id); // 幂等重放含原支付单
    expect(await countOutbox(GROUP_BUY_PUBLISHED_TOPIC)).toBe(1); // 重放不重复出事件
    expect(await countActiveLocks(pool, 'groupbuy')).toBe(1); // 重放不重复加锁（owner 夹具计数）

    await expect(
      groupBuys.create(createInput({ slot_start: slotStart, sub_min: 4 })),
    ).rejects.toMatchObject({ code: ErrorCode.GroupBuyDuplicateKey, httpStatus: 409 });

    // 他发起人同段互不影响（幂等键=user+slot_start 按发起人分键；B2 唯一防线按 lawyer+slot）
    await seedPricing(9102, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const other = await groupBuys.create(
      createInput({
        initiator_id: 6102,
        lawyer_id: 9102,
        slot_start: slotStart,
        sub_min: 2,
        sub_max: 4,
      }),
    );
    expect(other.group_buy.id).not.toBe(first.group_buy.id);
  });

  it('F2① 幂等重放比较原始入参（评审 F2）：发布后律师改价且清空接受范围 → 原样重发幂等返回原任务（非 409、不重验 B3 现值、share_price 保持原快照）', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const slotStart = hourAfter(25);
    const first = await groupBuys.create(createInput({ slot_start: slotStart }));
    expect(first.group_buy.share_price).toBe('33.33');

    // 律师改价（100→200）且清空接受范围——B3 现值已不满足 R-01（若重放落入解算路径会 400）
    await pricing.putPricing(9101, {
      base_version: 1,
      per_head: null,
      session_total: '200.00',
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });

    const replay = await groupBuys.create(createInput({ slot_start: slotStart }));
    expect(replay.group_buy.id).toBe(first.group_buy.id); // 幂等返回原任务
    expect(replay.group_buy.share_price).toBe('33.33'); // 原快照，非现值解算
    expect(replay.payment_order.id).toBe(first.payment_order.id);
    expect(await countOutbox(GROUP_BUY_PUBLISHED_TOPIC)).toBe(1); // 不重复出事件
  });

  it('F2② recreate 同 source 重放先于 B3/G1 解算（评审 F2）：recreate 后清空接受范围 → 同 source 重放=幂等返回已建任务（非 400）', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const source = await groupBuys.create(createInput({ sub_min: 3, sub_max: 6 }));
    await groupBuys.cancel(source.group_buy.id, 6101); // EXPIRED 源（锁已释放）
    const recreated = await groupBuys.recreate(source.group_buy.id, 6101);

    // B3 现值清空接受范围（若重放落入解算路径会 400 E_ACCEPT_RANGE_UNSET）
    await pricing.putPricing(9101, {
      base_version: 1,
      per_head: null,
      session_total: '200.00',
      group_size: null,
      accept_min: null,
      accept_max: null,
      room_modes: null,
      one_on_one_prices: {
        text: { per_round: '50.00' },
        voice: { per_15min: '100.00' },
        video: { per_15min: '100.00' },
      },
    });

    const replay = await groupBuys.recreate(source.group_buy.id, 6101);
    expect(replay.group_buy_id).toBe(recreated.group_buy_id); // 幂等返回已建任务
    expect(await countOutbox(GROUP_BUY_PUBLISHED_TOPIC)).toBe(2); // 源发布+重发恰好各一
  });

  it('R-W3-G 对齐：过期 slot_start 400；临期（缺省截止已过）缺省被拒 E_ENROLL_DEADLINE_INVALID；显式未来 deadline 放行', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    await expect(
      groupBuys.create(createInput({ slot_start: new Date(Date.now() - HOUR) })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    expect(await countRows(`SELECT count(*)::int AS n FROM trade.group_buys`)).toBe(0);

    // 临期（slot_start=+2h ⇒ 缺省截止=now−22h 已过）且未显式传 deadline → 400
    await expect(groupBuys.create(createInput({ slot_start: hourAfter(2) }))).rejects.toMatchObject(
      { code: ErrorCode.EnrollDeadlineInvalid, httpStatus: 400 },
    );
    // 显式合法 deadline（now < d < slot_start）→ 放行
    const ok = await groupBuys.create(
      createInput({ slot_start: hourAfter(2), deadline: new Date(Date.now() + HOUR) }),
    );
    expect(ok.group_buy.status).toBe('PUBLISHED');
  });

  it('G1：发起人活跃 BAN_JOIN 限制令 → 403 E_RESTRICTED 且零业务行（group_buys/支付单/锁全无）', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const pg = app.get(PgPoolService);
    await pg.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: RULES_SEED_BAN_JOIN,
        effectiveAt: new Date(Date.now() - 10 * HOUR),
      }),
    );
    await credit.emit({
      owner_type: 'user',
      owner_id: 6101,
      action: 'user_absent',
      ref_type: 'attendance',
      ref_id: 1,
    });
    await expect(groupBuys.create(createInput())).rejects.toMatchObject({
      code: ErrorCode.Restricted,
      httpStatus: 403,
    });
    expect(await countRows(`SELECT count(*)::int AS n FROM trade.group_buys`)).toBe(0);
    expect(await countPaymentOrders(pool)).toBe(0); // 支付单零残留（owner 夹具计数）
    expect(await countOutbox(GROUP_BUY_PUBLISHED_TOPIC)).toBe(0);
  });

  it('W1 前置②：SLOT_TAKEN → 409 且零业务行（同事务：group_buys/支付单/锁全无）；SLOT_ABUSE_LIMIT → 429 零残留（R-W3-F：PENDING_PAYMENT ≤1/律师）', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const slotStart = hourAfter(25);
    const pg = app.get(PgPoolService);
    // SLOT_TAKEN 造径：他 ref（session）先行占用同段活跃锁，C2B 发布撞 B2 唯一防线
    await pg.withTransaction(async (uow) => {
      const locked = await locks.lockSlot(uow, {
        lawyerId: 9101,
        slotStart,
        initiatorUserId: 555,
        refType: 'session',
        refId: 999,
      });
      expect(locked.ok).toBe(true);
    });
    await expect(groupBuys.create(createInput({ slot_start: slotStart }))).rejects.toMatchObject({
      code: ErrorCode.SlotTaken,
      httpStatus: 409,
    });
    // 零业务行：group_buys / 支付单 / 锁（他 ref 的锁除外）全无——同事务回滚证据
    expect(await countRows(`SELECT count(*)::int AS n FROM trade.group_buys`)).toBe(0);
    expect(await countPaymentOrders(pool)).toBe(0); // 支付单零残留（owner 夹具计数）
    expect(await countOutbox(GROUP_BUY_PUBLISHED_TOPIC)).toBe(0);

    // SLOT_ABUSE_LIMIT：同发起人已有 PENDING_PAYMENT 锁（R-W3-F 计数集）→ 429，零残留
    await seedPricing(9102, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const kept = await groupBuys.create(
      createInput({ lawyer_id: 9102, slot_start: hourAfter(30), sub_min: 2, sub_max: 4 }),
    );
    expect(kept.group_buy.status).toBe('PUBLISHED'); // A=PENDING_PAYMENT（计数集内）
    await expect(
      groupBuys.create(
        createInput({ lawyer_id: 9102, slot_start: hourAfter(40), sub_min: 2, sub_max: 4 }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RateLimited, httpStatus: 429 });
    expect(
      await countRows(`SELECT count(*)::int AS n FROM trade.group_buys WHERE lawyer_id = 9102`),
    ).toBe(1); // 仅 A，B 零残留
    expect(await countOutbox(SLOT_ABUSE_DETECTED_TOPIC)).toBeGreaterThanOrEqual(1);
  });

  it('R-04 子范围不可变：服务面无 UPDATE 子范围方法（代码层）+ 创建后同键异 sub 被 409 拦截、行值不变', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const slotStart = hourAfter(25); // 幂等键=user+slot_start：两次必须同刻（毫秒级同键）
    const result = await groupBuys.create(
      createInput({ slot_start: slotStart, sub_min: 3, sub_max: 6 }),
    );

    // 代码层：GroupBuyService 原型无任何 update/set 子范围写点（R-04「无 UPDATE 路径」）
    const protoNames = Object.getOwnPropertyNames(Object.getPrototypeOf(groupBuys));
    expect(protoNames.filter((n) => /^(update|set)/i.test(n))).toEqual([]); // 私有 lockRowForUpdate 为读锁语句非写点

    await expect(
      groupBuys.create(createInput({ slot_start: slotStart, sub_min: 4, sub_max: 6 })),
    ).rejects.toMatchObject({ code: ErrorCode.GroupBuyDuplicateKey }); // 同键异载荷=409 而非改写
    const row = await pool.query<{ sub_min: number; sub_max: number }>(
      `SELECT sub_min, sub_max FROM trade.group_buys WHERE id = $1`,
      [result.group_buy.id],
    );
    expect(row.rows[0]).toEqual({ sub_min: 3, sub_max: 6 }); // 行值不变
  });

  it('R-05 达 sub_min 守卫（合成驱动，T7 消费位）：PUBLISHED→REACHED→PENDING_LAWYER 双边 STL+lawyer_confirm_by(+12h) 落列+C2B_CONFIRM_TIMEOUT job 预写+GroupBuyReached 出箱；未达线 409；at-least-once 重放幂等短路；达线后 assertJoinable → 409 E_REACHED_LOCKED', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const result = await groupBuys.create(createInput({ sub_min: 3, sub_max: 6 }));
    const gbId = result.group_buy.id;

    // 未达线 → 409
    await expect(groupBuys.groupBuyReachedGuard(gbId, 2)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });

    // 达线（合成驱动：T7 的报名守卫 SQL 计数后调用）
    const advanced = await groupBuys.groupBuyReachedGuard(gbId, 3);
    expect(advanced).toEqual({ reached: true, group_buy_id: gbId });

    const row = await pool.query<{ status: string; lawyer_confirm_by: Date }>(
      `SELECT status, lawyer_confirm_by FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    expect(row.rows[0]!.status).toBe('PENDING_LAWYER');
    const confirmBy = row.rows[0]!.lawyer_confirm_by;
    expect(confirmBy.getTime()).toBeGreaterThan(Date.now() + 11 * HOUR);
    expect(confirmBy.getTime()).toBeLessThan(Date.now() + 13 * HOUR);

    // 双边 STL 留痕（entity_type='group_buy'）
    const stl = await pool.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM platform.state_transition_log
        WHERE entity_type = 'group_buy' AND entity_id = $1 AND allowed = true ORDER BY id`,
      [gbId],
    );
    expect(stl.rows).toEqual([
      { from_status: 'PUBLISHED', to_status: 'REACHED' },
      { from_status: 'REACHED', to_status: 'PENDING_LAWYER' },
    ]);

    // GroupBuyReached 出箱（§6 逐字 {id}）+ C2B_CONFIRM_TIMEOUT job 预写（锚 lawyer_confirm_by）
    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [GROUP_BUY_REACHED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]!.payload).toEqual({ id: gbId });
    const jobs = (await scheduler.listJobs({ jobType: 'C2B_CONFIRM_TIMEOUT' })).filter(
      (j) => j.refType === 'groupbuy' && j.refId === gbId,
    );
    expect(jobs).toHaveLength(1);
    expect(Math.abs(jobs[0]!.dueAt.getTime() - confirmBy.getTime())).toBeLessThan(1_500);

    // at-least-once 重放（EnrollmentPaid 重投/并发到守卫）：幂等短路不重复推进
    const replayed = await groupBuys.groupBuyReachedGuard(gbId, 3);
    expect(replayed).toEqual({ reached: false, group_buy_id: gbId });
    expect(await countOutbox(GROUP_BUY_REACHED_TOPIC)).toBe(1);

    // 达线后新加入被拒（REACHED_LOCKED——R-05 锁人）
    await expect(groupBuys.assertJoinable(gbId)).rejects.toMatchObject({
      code: ErrorCode.ReachedLocked,
      httpStatus: 409,
    });
  });

  it('C2B_CONFIRM_TIMEOUT 执行器（M-1）：PENDING_LAWYER 到期 → REJECTED+LawyerRejected(via_timeout=true) 出箱+占用锁同事务释放；非 PENDING_LAWYER 迟到 job 回查 CANCELLED 无操作', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const result = await groupBuys.create(createInput({ sub_min: 3, sub_max: 6 }));
    const gbId = result.group_buy.id;
    await groupBuys.groupBuyReachedGuard(gbId, 3);
    await rewindJob('C2B_CONFIRM_TIMEOUT', gbId);

    const tick = await scheduler.tick('normal');
    expect(tick.done).toBe(1);

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    expect(row.rows[0]!.status).toBe('REJECTED');

    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [LAWYER_REJECTED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]!.payload).toMatchObject({
      group_id: gbId,
      lawyer_id: 9101,
      via_timeout: true, // M-1：超时自动拒判别字段
    });

    // 锁同事务释放（架构 §4.2）：再发显式释放 → ALREADY_RELEASED 幂等探针
    const release = await (app.get(PgPoolService) as PgPoolService).withTransaction((uow) =>
      locks.releaseSlot(uow, { refType: 'groupbuy', refId: gbId, reason: 'probe' }),
    );
    expect(release).toEqual({ ok: false, reason: 'ALREADY_RELEASED' });

    // 迟到 job 回查：同 ref 再注册（旧行已 DONE）→ 状态已 REJECTED → CANCELLED 无操作、不二次出箱
    await scheduler.registerJob(pool, {
      jobType: 'C2B_CONFIRM_TIMEOUT',
      refType: 'groupbuy',
      refId: gbId,
      dueAt: new Date(Date.now() - 1_000),
    });
    const tick2 = await scheduler.tick('normal');
    expect(tick2.cancelled).toBe(1);
    expect(await countOutbox(LAWYER_REJECTED_TOPIC)).toBe(1);
  });

  it('ENROLL 截止 job 执行器（groupbuy 分流）：deadline 已过仍 PUBLISHED → EXPIRED+GroupBuyExpired(DEADLINE_PASSED) 出箱+锁同事务释放；已 REACHED 迟到 job → CANCELLED 不误杀', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const result = await groupBuys.create(createInput({ deadline: new Date(Date.now() - 1_000) }));
    const gbId = result.group_buy.id;
    const tick = await scheduler.tick('normal');
    expect(tick.done).toBe(1);

    const row = await pool.query<{ status: string; status_since: Date }>(
      `SELECT status, status_since FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    expect(row.rows[0]!.status).toBe('EXPIRED');

    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [GROUP_BUY_EXPIRED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]!.payload).toMatchObject({
      id: gbId,
      lawyer_id: 9101,
      initiator_id: 6101,
      share_price: '33.33',
      sub_min: 3,
      reason: 'DEADLINE_PASSED',
    });

    const release = await (app.get(PgPoolService) as PgPoolService).withTransaction((uow) =>
      locks.releaseSlot(uow, { refType: 'groupbuy', refId: gbId, reason: 'probe' }),
    );
    expect(release).toEqual({ ok: false, reason: 'ALREADY_RELEASED' });

    // 迟到 job 不误杀：EXPIRED 源再注册 → 回查 CANCELLED 无操作
    await scheduler.registerJob(pool, {
      jobType: 'ENROLL_DEADLINE',
      refType: 'groupbuy',
      refId: gbId,
      dueAt: new Date(Date.now() - 1_000),
    });
    const tick2 = await scheduler.tick('normal');
    expect(tick2.cancelled).toBe(1);
    expect(await countOutbox(GROUP_BUY_EXPIRED_TOPIC)).toBe(1);

    // 已 REACHED（PENDING_LAWYER）的拼团不被截止 job 误杀（回查锚=status=PUBLISHED）
    await seedPricing(9102, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const gb2 = await groupBuys.create(createInput({ lawyer_id: 9102, sub_min: 2, sub_max: 4 }));
    await groupBuys.groupBuyReachedGuard(gb2.group_buy.id, 2);
    await rewindJob('ENROLL_DEADLINE', gb2.group_buy.id);
    const tick3 = await scheduler.tick('normal');
    expect(tick3.cancelled).toBe(1);
    const row2 = await pool.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [gb2.group_buy.id],
    );
    expect(row2.rows[0]!.status).toBe('PENDING_LAWYER'); // 不被流标
  });

  it('§10③ 未支付 10min TTL 释放后他人可发布同段（B2 SLOT_TTL 真路径）', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const slotStart = hourAfter(25);
    const first = await groupBuys.create(createInput({ slot_start: slotStart }));

    // 他人同段撞发布锁 → 409 SLOT_TAKEN
    await expect(
      groupBuys.create(
        createInput({ initiator_id: 6102, slot_start: slotStart, sub_min: 2, sub_max: 4 }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SlotTaken });

    // TTL 真路径：owner 夹具回拨锁 ttl_at + SLOT_TTL job（确定性触发，B2 backdateTtl 同款）→
    // tick 释放；releaseSlot 探针 ALREADY_RELEASED=锁已释放（活跃态消失）
    const lockId = await getActiveLockId(pool, 'groupbuy', first.group_buy.id);
    expect(lockId).not.toBeNull();
    await backdateLockTtl(pool, lockId!);
    await backdateJobDue(pool, 'SLOT_TTL', 'slot_lock', lockId!);
    await scheduler.tick('normal');
    const released = await app
      .get(PgPoolService)
      .withTransaction((uow) =>
        locks.releaseSlot(uow, { refType: 'groupbuy', refId: first.group_buy.id, reason: 'probe' }),
      );
    expect(released).toEqual({ ok: false, reason: 'ALREADY_RELEASED' });

    // 释放后他人可发布同段（原任务仍 PUBLISHED——释放只解段位占用，任务自然存续至截止）
    const again = await groupBuys.create(
      createInput({ initiator_id: 6102, slot_start: slotStart, sub_min: 2, sub_max: 4 }),
    );
    expect(again.group_buy.id).not.toBe(first.group_buy.id);
  });

  it('cancel（R-W3-L）：PUBLISHED+锁 PENDING_PAYMENT → EXPIRED+锁释放+GroupBuyExpired(INITIATOR_CANCELLED)；锁已 LOCKED（有人已支付）→ 409 E_HAS_JOINED；非 PUBLISHED → 409；非发起人 → 404', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const result = await groupBuys.create(createInput({ sub_min: 3, sub_max: 6 }));
    const gbId = result.group_buy.id;

    // 发起人本人未支付（PENDING_PAYMENT 未核销）：取消=锁释放+EXPIRED+来源注记
    const cancelled = await groupBuys.cancel(gbId, 6101);
    expect(cancelled).toEqual({ status: 'EXPIRED' });
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    expect(row.rows[0]!.status).toBe('EXPIRED');
    const stl = await pool.query<{ reason: string }>(
      `SELECT reason FROM platform.state_transition_log
        WHERE entity_type = 'group_buy' AND entity_id = $1 AND allowed = true`,
      [gbId],
    );
    expect(stl.rows[0]!.reason).toBe('initiator_cancelled'); // EXPIRED+cancel 来源注记
    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [GROUP_BUY_EXPIRED_TOPIC],
    );
    expect(evt.rows.filter((r) => r.payload['reason'] === 'INITIATOR_CANCELLED')).toHaveLength(1);
    // 锁同事务释放：releaseSlot 探针 ALREADY_RELEASED=活跃锁已消失（架构 §4.2）
    const release = await app
      .get(PgPoolService)
      .withTransaction((uow) =>
        locks.releaseSlot(uow, { refType: 'groupbuy', refId: gbId, reason: 'probe' }),
      );
    expect(release).toEqual({ ok: false, reason: 'ALREADY_RELEASED' });

    // 已取消再取消 → 409（非 PUBLISHED）
    await expect(groupBuys.cancel(gbId, 6101)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });

    // 他人已支付（R-W3-L）：合成 CONFIRM_PAYMENT 使锁 PENDING_PAYMENT→LOCKED → 409 E_HAS_JOINED
    await seedPricing(9102, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const gb2 = await groupBuys.create(
      createInput({ lawyer_id: 9102, slot_start: hourAfter(30), sub_min: 2, sub_max: 4 }),
    );
    const pg = app.get(PgPoolService);
    await pg.withTransaction((uow) => locks.confirmPayment(uow, gb2.payment_order.id));
    await expect(groupBuys.cancel(gb2.group_buy.id, 6101)).rejects.toMatchObject({
      code: ErrorCode.HasJoined,
      httpStatus: 409,
    });
    const row2 = await pool.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [gb2.group_buy.id],
    );
    expect(row2.rows[0]!.status).toBe('PUBLISHED'); // 取消未生效

    // 非发起人 → 404（不暴露他人物）；不存在 → 404
    await expect(groupBuys.cancel(gb2.group_buy.id, 6102)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await expect(groupBuys.cancel(987654, 6101)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });

  it('F3 cancel（评审 F3）：锁已被 TTL 释放（activeStatusOf=null，无活跃锁行）→ 放行取消=EXPIRED+GroupBuyExpired(INITIATOR_CANCELLED)，锁 ALREADY_RELEASED 良性', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const result = await groupBuys.create(createInput({ sub_min: 2, sub_max: 4 }));
    const gbId = result.group_buy.id;

    // TTL 真路径释放（activeStatusOf 探针证无活跃锁——cancel 判定入参=null）
    const lockId = await getActiveLockId(pool, 'groupbuy', gbId);
    expect(lockId).not.toBeNull();
    await backdateLockTtl(pool, lockId!);
    await backdateJobDue(pool, 'SLOT_TTL', 'slot_lock', lockId!);
    await scheduler.tick('normal');
    const pg = app.get(PgPoolService);
    expect(
      await pg.withTransaction((uow) => locks.activeStatusOf(uow, 'groupbuy', gbId)),
    ).toBeNull();

    // 取消放行：无活跃锁=「无任何已支付加入者」成立 → EXPIRED（releaseSlot ALREADY_RELEASED 良性容错）
    const cancelled = await groupBuys.cancel(gbId, 6101);
    expect(cancelled).toEqual({ status: 'EXPIRED' });
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [gbId],
    );
    expect(row.rows[0]!.status).toBe('EXPIRED');
    const evt = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1`,
      [GROUP_BUY_EXPIRED_TOPIC],
    );
    expect(evt.rows[0]!.payload).toMatchObject({ id: gbId, reason: 'INITIATOR_CANCELLED' });
  });

  it('recreate（§10④）：复制参数新任务+原任务状态不变+source_id 落列；同 source 重放=幂等返回已建任务；PUBLISHED 源重发=B2 R-W3-F 计数 429；他人/缺失源 404', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const source = await groupBuys.create(createInput({ sub_min: 3, sub_max: 6 }));
    await groupBuys.cancel(source.group_buy.id, 6101); // EXPIRED 源（锁已释放）

    const recreated = await groupBuys.recreate(source.group_buy.id, 6101);
    expect(typeof recreated.group_buy_id).toBe('number');
    expect(recreated.group_buy_id).not.toBe(source.group_buy.id);

    const row = await pool.query<{
      status: string;
      source_id: string;
      lawyer_id: string;
      slot_start: Date;
      sub_min: number;
      sub_max: number;
      share_price: string;
    }>(
      `SELECT status, source_id, lawyer_id, slot_start, sub_min, sub_max, share_price::text AS share_price
         FROM trade.group_buys WHERE id = $1`,
      [recreated.group_buy_id],
    );
    expect(row.rows[0]!.status).toBe('PUBLISHED'); // 新任务
    expect(Number(row.rows[0]!.source_id)).toBe(source.group_buy.id); // 幂等键=source_id 落列
    expect(Number(row.rows[0]!.lawyer_id)).toBe(9101);
    expect(new Date(row.rows[0]!.slot_start).getTime()).toBe(
      new Date(source.group_buy.slot_start).getTime(),
    ); // 复制参数
    expect(row.rows[0]!.sub_min).toBe(3);
    expect(row.rows[0]!.sub_max).toBe(6);
    expect(row.rows[0]!.share_price).toBe('33.33'); // 重新解算（B3 现值）

    // 原任务状态不变（仍 EXPIRED）
    const src = await pool.query<{ status: string }>(
      `SELECT status FROM trade.group_buys WHERE id = $1`,
      [source.group_buy.id],
    );
    expect(src.rows[0]!.status).toBe('EXPIRED');

    // 同 source 重放 → 幂等返回已建任务（F1 R-02 口径：同键同载荷重放原单）
    const replay = await groupBuys.recreate(source.group_buy.id, 6101);
    expect(replay.group_buy_id).toBe(recreated.group_buy_id);
    expect(await countOutbox(GROUP_BUY_PUBLISHED_TOPIC)).toBe(2); // 源发布+重发恰好各一

    // PUBLISHED 源（其自身 PENDING_PAYMENT 发布锁活跃）：recreate 被同段重发——B2 R-W3-F
    // 计数（同用户同律师进行中待支付锁 ≤1）先于唯一索引触发 → 429；语义=「不可对进行中任务
    // 重发」（不发明隐式取消），锁释放（截止/取消）后 recreate 才可行
    await seedPricing(9102, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const live = await groupBuys.create(
      createInput({ lawyer_id: 9102, slot_start: hourAfter(30) }),
    );
    await expect(groupBuys.recreate(live.group_buy.id, 6101)).rejects.toMatchObject({
      code: ErrorCode.RateLimited,
      httpStatus: 429,
    });
    expect(
      await countRows(`SELECT count(*)::int AS n FROM trade.group_buys WHERE source_id = $1`, [
        live.group_buy.id,
      ]),
    ).toBe(0);

    // 他人源/缺失源 → 404
    await expect(groupBuys.recreate(live.group_buy.id, 6102)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await expect(groupBuys.recreate(987654, 6101)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });

  it('list：公开列表仅 PUBLISHED+specialty 过滤真实生效+仅 PASSED 律师+joined=null 桩；EXPIRED 不出列', async () => {
    await seedLawyerProfile(pool, 9301, 'PASSED', 't5-passed');
    await seedLawyerProfile(pool, 9302, 'SUBMITTED', 't5-submitted');
    await seedPricing(9301, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    await seedPricing(9302, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    await groupBuys.create(
      createInput({ lawyer_id: 9301, specialty: 'labor_arbitration', sub_min: 2, sub_max: 4 }),
    );
    await groupBuys.create(
      createInput({ lawyer_id: 9302, specialty: 'labor_arbitration', slot_start: hourAfter(26) }),
    );
    // 流标一场（真实路径产生 EXPIRED）——不出公开列表
    await seedPricing(9303, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    await seedLawyerProfile(pool, 9303, 'PASSED', 't5-passed-2');
    const dying = await groupBuys.create(
      createInput({
        lawyer_id: 9303,
        slot_start: hourAfter(30),
        deadline: new Date(Date.now() - 1_000),
      }),
    );
    await app
      .get(PgPoolService)
      .withTransaction((uow) => groupBuys.expireOnDeadline(uow, dying.group_buy.id));

    const list = await groupBuys.list({ specialty: 'labor_arbitration' });
    expect(list).toHaveLength(1); // 仅 9301（9302 审核未过、9303 已 EXPIRED）
    expect(list[0]!.lawyer_id).toBe(9301);
    expect(list[0]!.joined).toBeNull(); // 桩：C3=T7 接线
    expect(list[0]!.share_price).toBe('50.00'); // 分摊额出参

    const empty = await groupBuys.list({ specialty: 'contract_dispute' });
    expect(empty).toEqual([]); // specialty 过滤真实生效
  });

  it('城市维物化与过滤（序 11.5 V33）：C2 发布物化 group_buys.city=目标律师执业城市（导出面，null 兜底北京）；GET /group-buys &city= 过滤（与 specialty 组合）；出参增列', async () => {
    await seedLawyerProfile(pool, 9311, 'PASSED', 't5-dims-sh', '上海');
    await seedLawyerProfile(pool, 9310, 'PASSED', 't5-dims-bj');
    await seedPricing(9311, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    await seedPricing(9310, { session_total: '120.00', accept_min: 2, accept_max: 8 });
    const sh = await groupBuys.create(createInput({ lawyer_id: 9311, slot_start: hourAfter(25) }));
    const bj = await groupBuys.create(createInput({ lawyer_id: 9310, slot_start: hourAfter(26) }));

    // 物化：city=目标律师执业城市（未登记 → 兜底北京）
    expect(sh.group_buy.city).toBe('上海');
    expect(bj.group_buy.city).toBe('北京');
    const rows = await pool.query<{ city: string }>(
      `SELECT city FROM trade.group_buys WHERE id IN ($1, $2) ORDER BY id`,
      [sh.group_buy.id, bj.group_buy.id],
    );
    expect(rows.rows.map((r) => r.city)).toEqual(['上海', '北京']);

    // &city= 过滤（specialty 已有，两维组合 AND）
    expect((await groupBuys.list({ city: '上海' })).map((g) => g.id)).toEqual([sh.group_buy.id]);
    expect((await groupBuys.list({ city: '北京' })).map((g) => g.id)).toEqual([bj.group_buy.id]);
    expect(await groupBuys.list({ city: '广州' })).toEqual([]); // 过滤真生效（空集）
    expect(await groupBuys.list({ specialty: 'labor_arbitration', city: '广州' })).toEqual([]);
    // 出参增列
    expect((await groupBuys.list({ city: '上海' }))[0]).toMatchObject({
      specialty: 'labor_arbitration',
      city: '上海',
    });
  });

  it('W1 前置⑤：groupbuy 终态 provider 注册到 B2 注册表（isTerminalBatch 批量形态）；PUBLISHED=false / EXPIRED=true(since=status_since) / 缺实体跳过', async () => {
    const provider = terminals.get('groupbuy');
    expect(provider).toBeInstanceOf(GroupBuyTerminalProvider);
    expect(typeof provider!.isTerminalBatch).toBe('function');

    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    await seedPricing(9102, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const alive = await groupBuys.create(createInput());
    const dying = await groupBuys.create(
      createInput({
        lawyer_id: 9102,
        slot_start: hourAfter(30),
        deadline: new Date(Date.now() - 1_000),
      }),
    );
    await app
      .get(PgPoolService)
      .withTransaction((uow) => groupBuys.expireOnDeadline(uow, dying.group_buy.id));

    const infos = await provider!.isTerminalBatch!([
      alive.group_buy.id,
      dying.group_buy.id,
      987654,
    ]);
    expect(infos.get(alive.group_buy.id)).toEqual({ terminal: false, since: null });
    const deadInfo = infos.get(dying.group_buy.id);
    expect(deadInfo?.terminal).toBe(true);
    expect(deadInfo?.since).toBeInstanceOf(Date);
    expect(infos.get(987654)).toBeUndefined(); // 缺实体：reaper 视同 null 跳过

    const single = await provider!.isTerminal!(dying.group_buy.id);
    expect(single?.terminal).toBe(true);
  });

  it('R-W3-K 前置：发布事务的支付单经 F1 导出面可查（findOrderByIdempotencyKey 定位 groupbuy/g{id}/pay）', async () => {
    await seedPricing(9101, { session_total: '100.00', accept_min: 2, accept_max: 8 });
    const result = await groupBuys.create(createInput());
    const found = await payment.findOrderByIdempotencyKey(`groupbuy/g${result.group_buy.id}/pay`);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(result.payment_order.id);
    expect(found!.biz_type).toBe('enroll');
    expect(found!.cash_amount).toBe('33.33');
    const missing = await payment.findOrderByIdempotencyKey('groupbuy/g987654/pay');
    expect(missing).toBeNull();
  });
});
