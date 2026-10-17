import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  POINTS_EXPIRED_TOPIC,
  POINTS_GRANTED_TOPIC,
  POINTS_REDEEMED_TOPIC,
  type PointsExpiredPayload,
  type PointsGrantedPayload,
  type PointsRedeemedPayload,
} from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { BENEFITS_CONFIG } from './benefits.config';
import { PointsService } from './points.service';

/**
 * F4 ①切片积分服务 e2e（需 PG）：授予/冻结/核销/解冻/退款还原/过期双路径 + R-01（50% 上限
 * 含零头边界、负余额禁令）+ R-02（180 天时钟/惰性过期）+ R-06（退款还原时钟重置）+
 * §5 幂等键=order（FREEZE/SETTLE/UNFREEZE 重放/异载荷冲突）+ §8 行锁防并发超用（10 并发）+
 * 「流水不可变+余额行锁」纪律（无独立状态列不涉 STL，报告口径）。
 *
 * 过期语义（简报最小裁决，实现与迁移 V21 头注同口径）：
 *   - 惰性路径=读时把「已过期未扣减」剔除可用余额（纯计算不落行）；
 *   - job 路径=按用户聚合扣 min(未处理过期, balance)——frozen 冻结中不过期，回 balance 后
 *     按原 expires_at 即扫（已过期无宽限）；
 *   - 未处理过期额 = max(0, 已过期授予额 − 已消耗额)，消耗 FIFO 口径（TTL 恒定下 expires_at
 *     随流水序单调，聚合公式精确，points.service 头注推导）。
 *
 * 时间旅行口径：全过期比对走 DB 时钟（credit 窗口判定同款先例）；「冻结中过期」用例以
 * now()+3s 授予夹具 + 3.4s 睡眠钉时序（15s 超时内，余量 2.9s+）。
 */
const USER = 601;
const USER_B = 602;
const DAY = 86_400_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('F4 ①切片积分服务（授予/冻结核销解冻/退款还原/过期双路径/并发超用，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let points: PointsService;
  let fixtureSeq = 0;

  const accountOf = async (userId: number): Promise<{ balance: number; frozen: number } | null> => {
    const res = await pool.query<{ balance: number; frozen: number }>(
      'SELECT balance, frozen FROM benefits.points_accounts WHERE user_id = $1',
      [userId],
    );
    return res.rows[0] ?? null;
  };

  const txnsOf = async (userId: number) => {
    const res = await pool.query<{
      kind: string;
      delta: number;
      source_ref: string | null;
      expires_at: Date | null;
    }>(
      `SELECT kind, delta, source_ref, expires_at FROM benefits.points_txns
        WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    return res.rows;
  };

  const outboxOf = async (topic: string) => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id',
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  /** 夹具：直插授予行（本 schema 测试夹具，expires 用 SQL 表达式锚定 DB 时钟）+ 同步账户列 */
  const rawGrant = async (userId: number, delta: number, expiresSql: string): Promise<void> => {
    fixtureSeq += 1;
    await pool.query(
      `INSERT INTO benefits.points_txns (user_id, delta, kind, source_ref, expires_at)
       VALUES ($1, $2, 'COMPENSATION', $3, now() + ${expiresSql})`,
      [userId, delta, `fixture:${fixtureSeq}`],
    );
    await pool.query(
      `INSERT INTO benefits.points_accounts (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = benefits.points_accounts.balance + $2`,
      [userId, delta],
    );
  };

  const sweep = async (userId: number): Promise<{ swept: number } | null> =>
    app.get(PgPoolService).withTransaction((uow: SqlExecutor) => points.expireUser(uow, userId));

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [],
      providers: [
        PgPoolService,
        OutboxService,
        { provide: BENEFITS_CONFIG, useValue: { pointsTtlDays: 180 } },
        PointsService,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    points = app.get(PointsService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------- 授予（正向入账 + PointsGranted + 幂等键=ref） ----------

  it('grant：入账 + 授予行 expires_at≈now+180d（R-02 时钟）+ PointsGranted 出箱（载荷含 user/delta/kind/ref/balance_after）', async () => {
    const r = await points.grant({
      user_id: USER,
      points: 500,
      kind: 'COMPENSATION',
      ref: 'price_change:21',
    });
    expect(r.deduplicated).toBe(false);
    expect(r.balance).toBe(500);
    expect(r.frozen).toBe(0);
    expect(await accountOf(USER)).toEqual({ balance: 500, frozen: 0 });

    const rows = await txnsOf(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'COMPENSATION',
      delta: 500,
      source_ref: 'price_change:21',
    });
    const ttlMs = rows[0]!.expires_at!.getTime() - Date.now();
    expect(Math.abs(ttlMs - 180 * DAY)).toBeLessThan(10_000);

    const granted = await outboxOf(POINTS_GRANTED_TOPIC);
    expect(granted).toEqual([
      {
        user_id: USER,
        delta: 500,
        kind: 'COMPENSATION',
        ref: 'price_change:21',
        balance_after: 500,
      } satisfies PointsGrantedPayload,
    ]);
  });

  it('grant 幂等重放：同 kind+ref 两投 → 短路（单行/单事件/余额不变）；不同 ref 正常累计；ABSENCE_SHARE kind 通行', async () => {
    const first = await points.grant({
      user_id: USER,
      points: 300,
      kind: 'COMPENSATION',
      ref: 'r:1',
    });
    expect(first.deduplicated).toBe(false);
    const replay = await points.grant({
      user_id: USER,
      points: 300,
      kind: 'COMPENSATION',
      ref: 'r:1',
    });
    expect(replay.deduplicated).toBe(true);
    expect(replay.balance).toBe(300); // 分数不变
    expect((await txnsOf(USER)).filter((t) => t.source_ref === 'r:1')).toHaveLength(1);
    expect(await outboxOf(POINTS_GRANTED_TOPIC)).toHaveLength(1);

    await points.grant({ user_id: USER, points: 100, kind: 'COMPENSATION', ref: 'r:2' });
    expect((await accountOf(USER))!.balance).toBe(400);

    const share = await points.grant({
      user_id: USER_B,
      points: 70,
      kind: 'ABSENCE_SHARE',
      ref: 'attendance:5',
    });
    expect(share.balance).toBe(70);

    // 同键异载荷（同 ref 不同 delta）→ Conflict 显性化（T1 DUP 语义同源，错误码取通用冲突）
    await expect(
      points.grant({ user_id: USER, points: 999, kind: 'COMPENSATION', ref: 'r:1' }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict });
    expect(await outboxOf(POINTS_GRANTED_TOPIC)).toHaveLength(3); // r:1 / r:2 / attendance:5
  });

  it('grant 入参防御：非授予 kind / points<=0 / ref 空·超长 / user_id 非法 → InvalidArgument', async () => {
    const bad = [
      () =>
        points.grant({ user_id: USER, points: 1, kind: 'REDEEM' as 'COMPENSATION', ref: 'x:1' }),
      () => points.grant({ user_id: USER, points: 0, kind: 'COMPENSATION', ref: 'x:2' }),
      () => points.grant({ user_id: USER, points: -5, kind: 'COMPENSATION', ref: 'x:3' }),
      () => points.grant({ user_id: USER, points: 1, kind: 'COMPENSATION', ref: '' }),
      () => points.grant({ user_id: USER, points: 1, kind: 'COMPENSATION', ref: 'x'.repeat(65) }),
      () => points.grant({ user_id: 0, points: 1, kind: 'COMPENSATION', ref: 'x:4' }),
    ];
    for (const fn of bad) {
      await expect(fn()).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    }
    expect(await txnsOf(USER)).toHaveLength(0);
  });

  // ---------- 冻结（R-01 50% 上限 + 可用余额预检 + 幂等键=order） ----------

  it('freeze：balance→frozen 移动 + FREEZE 留痕行（delta=-points, ref=order:{id}）+ 无事件', async () => {
    await points.grant({ user_id: USER, points: 500, kind: 'COMPENSATION', ref: 'r:1' });
    const r = await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    expect(r.deduplicated).toBe(false);
    expect(r.balance).toBe(200);
    expect(r.frozen).toBe(300);
    expect(await accountOf(USER)).toEqual({ balance: 200, frozen: 300 });

    const rows = await txnsOf(USER);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'FREEZE',
      delta: -300,
      source_ref: 'order:9',
      expires_at: null,
    });
    expect(await outboxOf(POINTS_GRANTED_TOPIC)).toHaveLength(1); // 冻结不出事件
    expect(await outboxOf(POINTS_REDEEMED_TOPIC)).toHaveLength(0);
  });

  it('R-01 单次抵扣 ≤ 订单应付 50%（校验在 FREEZE 入参）：恰 50% 通行、floor 边界、超限拒绝；零头边界应付 1 分 → 任何抵扣拒绝', async () => {
    await points.grant({ user_id: USER, points: 10000, kind: 'COMPENSATION', ref: 'r:1' });
    // 应付 2.00 元=200 分：抵 100 分恰 50% 通行
    await points.freeze({
      user_id: USER,
      payment_order_id: 1,
      points_to_use: 100,
      order_payable_cents: 200,
    });
    // 应付 2.01 元=201 分：floor(201/2)=100 → 100 通行、101 拒绝（floor 边界）
    await points.freeze({
      user_id: USER,
      payment_order_id: 2,
      points_to_use: 100,
      order_payable_cents: 201,
    });
    await expect(
      points.freeze({
        user_id: USER,
        payment_order_id: 3,
        points_to_use: 101,
        order_payable_cents: 201,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    // 零头边界：应付 0.01 元=1 分 → 50% 向下取整=0 → 任何 ≥1 分抵扣拒绝
    await expect(
      points.freeze({
        user_id: USER,
        payment_order_id: 4,
        points_to_use: 1,
        order_payable_cents: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    // 入参防御：points_to_use <=0 / 应付负数
    await expect(
      points.freeze({
        user_id: USER,
        payment_order_id: 5,
        points_to_use: 0,
        order_payable_cents: 100,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(
      points.freeze({
        user_id: USER,
        payment_order_id: 6,
        points_to_use: 1,
        order_payable_cents: -1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
  });

  it('余额不足 → 409 E_INSUFFICIENT（InsufficientFunds + httpStatus 覆写 409，F4 §5 契约）；无账户行同口径', async () => {
    await points.grant({ user_id: USER, points: 100, kind: 'COMPENSATION', ref: 'r:1' });
    await expect(
      points.freeze({
        user_id: USER,
        payment_order_id: 9,
        points_to_use: 300,
        order_payable_cents: 100000,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InsufficientFunds, httpStatus: 409 });
    // 无账户行：可用 0
    await expect(
      points.freeze({
        user_id: USER_B,
        payment_order_id: 9,
        points_to_use: 1,
        order_payable_cents: 100,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InsufficientFunds, httpStatus: 409 });
  });

  it('惰性过期路径：已过期授予不计入可用余额（冻结被 409 拒、mine 余额剔除），且不落 EXPIRE 行（纯计算）', async () => {
    await rawGrant(USER, 500, "interval '-1 day'"); // 已过期 1 天
    await expect(
      points.freeze({
        user_id: USER,
        payment_order_id: 9,
        points_to_use: 300,
        order_payable_cents: 100000,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InsufficientFunds });

    const mine = await points.getMine(USER);
    expect(mine.balance).toBe(0); // 可用=500−min(500,500)=0
    expect(mine.frozen).toBe(0);
    expect((await txnsOf(USER)).filter((t) => t.kind === 'EXPIRE')).toHaveLength(0); // 惰性不落行
  });

  it('freeze 幂等重放：同 order 同额 → 短路（单留痕行/账户不动）；同 order 异额 → Conflict', async () => {
    await points.grant({ user_id: USER, points: 500, kind: 'COMPENSATION', ref: 'r:1' });
    const first = await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    const replay = await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    expect(first.deduplicated).toBe(false);
    expect(replay.deduplicated).toBe(true);
    expect(replay.balance).toBe(200);
    expect(replay.frozen).toBe(300);
    expect((await txnsOf(USER)).filter((t) => t.kind === 'FREEZE')).toHaveLength(1);

    await expect(
      points.freeze({
        user_id: USER,
        payment_order_id: 9,
        points_to_use: 100,
        order_payable_cents: 100000,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Conflict }); // 同键异载荷
  });

  // ---------- 核销 / 解冻（§5 SETTLE/UNFREEZE_POINTS：幂等键=order，互斥结局） ----------

  it('settle：frozen 扣减 + REDEEM 行（delta=-points）+ PointsRedeemed 出箱；balance 不动', async () => {
    await points.grant({ user_id: USER, points: 500, kind: 'COMPENSATION', ref: 'r:1' });
    await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    const r = await points.settle({ user_id: USER, payment_order_id: 9 });
    expect(r.deduplicated).toBe(false);
    expect(r.balance).toBe(200);
    expect(r.frozen).toBe(0);

    const rows = await txnsOf(USER);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ kind: 'REDEEM', delta: -300, source_ref: 'order:9' });
    expect(await outboxOf(POINTS_REDEEMED_TOPIC)).toEqual([
      {
        user_id: USER,
        delta: -300,
        kind: 'REDEEM',
        order_id: 9,
        ref: 'order:9',
        balance_after: 200,
      } satisfies PointsRedeemedPayload,
    ]);
  });

  it('settle 幂等/冲突矩阵：重放短路（单行/单事件）；未冻结 404；解冻后核销 409', async () => {
    await points.grant({ user_id: USER, points: 500, kind: 'COMPENSATION', ref: 'r:1' });
    await expect(points.settle({ user_id: USER, payment_order_id: 9 })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });

    await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    await points.settle({ user_id: USER, payment_order_id: 9 });
    const replay = await points.settle({ user_id: USER, payment_order_id: 9 });
    expect(replay.deduplicated).toBe(true);
    expect(replay.frozen).toBe(0);
    expect((await txnsOf(USER)).filter((t) => t.kind === 'REDEEM')).toHaveLength(1);
    expect(await outboxOf(POINTS_REDEEMED_TOPIC)).toHaveLength(1);

    // 同 order 走解冻结局：冲突（结局互斥，先到先定）
    await expect(points.unfreeze({ user_id: USER, payment_order_id: 9 })).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
  });

  it('unfreeze：frozen→balance 原额回摆 + UNFREEZE 留痕行（delta=+points）；重放短路；核销后解冻 409；未冻结 404', async () => {
    await points.grant({ user_id: USER, points: 500, kind: 'COMPENSATION', ref: 'r:1' });
    await expect(points.unfreeze({ user_id: USER, payment_order_id: 9 })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });

    await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    const r = await points.unfreeze({ user_id: USER, payment_order_id: 9 });
    expect(r.deduplicated).toBe(false);
    expect(r.balance).toBe(500);
    expect(r.frozen).toBe(0);

    const rows = await txnsOf(USER);
    expect(rows[2]).toMatchObject({ kind: 'UNFREEZE', delta: 300, source_ref: 'order:9' });
    const replay = await points.unfreeze({ user_id: USER, payment_order_id: 9 });
    expect(replay.deduplicated).toBe(true);
    expect((await txnsOf(USER)).filter((t) => t.kind === 'UNFREEZE')).toHaveLength(1);

    await expect(points.settle({ user_id: USER, payment_order_id: 9 })).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
  });

  it('§10 冻结-核销-解冻闭环：失败支付解冻回摆后账户与闭环前全等（含流水形状）', async () => {
    await points.grant({ user_id: USER, points: 500, kind: 'COMPENSATION', ref: 'r:1' });
    const before = await accountOf(USER);
    await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 300,
      order_payable_cents: 100000,
    });
    await points.unfreeze({ user_id: USER, payment_order_id: 9 });
    const after = await accountOf(USER);
    expect(after).toEqual(before);
  });

  // ---------- R-06 退款还原（过期时钟重置） ----------

  it('refundRestore：+delta 新鲜时钟（≈now+TTL）+ PointsGranted(kind=REFUND_RESTORE) 出箱；重放短路', async () => {
    const r = await points.refundRestore({ user_id: USER, points: 300, ref: 'refund:order-9:1' });
    expect(r.deduplicated).toBe(false);
    expect(r.balance).toBe(300);

    const rows = await txnsOf(USER);
    expect(rows[0]).toMatchObject({
      kind: 'REFUND_RESTORE',
      delta: 300,
      source_ref: 'refund:order-9:1',
    });
    const ttlMs = rows[0]!.expires_at!.getTime() - Date.now();
    expect(Math.abs(ttlMs - 180 * DAY)).toBeLessThan(10_000); // R-06 时钟重置=restore 时刻+TTL

    const granted = await outboxOf(POINTS_GRANTED_TOPIC);
    expect(granted).toEqual([
      {
        user_id: USER,
        delta: 300,
        kind: 'REFUND_RESTORE',
        ref: 'refund:order-9:1',
        balance_after: 300,
      } satisfies PointsGrantedPayload,
    ]);

    const replay = await points.refundRestore({
      user_id: USER,
      points: 300,
      ref: 'refund:order-9:1',
    });
    expect(replay.deduplicated).toBe(true);
    expect(await txnsOf(USER)).toHaveLength(1);
    expect(await outboxOf(POINTS_GRANTED_TOPIC)).toHaveLength(1);
  });

  it('R-06 时钟重置语义：原授予过期但已被核销 → 还原行不受原时钟连坐（过期扫不扣还原余额）', async () => {
    // 原授予 100 分 3 秒后过期（夹具直插）；冻结→核销（消耗 100）
    await rawGrant(USER, 100, "interval '3 seconds'");
    await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 100,
      order_payable_cents: 200,
    });
    await points.settle({ user_id: USER, payment_order_id: 9 });
    // 退款还原 100 分：新鲜时钟 180d
    await points.refundRestore({ user_id: USER, points: 100, ref: 'refund:order-9:1' });

    await sleep(3400); // 原授予时钟已过
    const swept = await sweep(USER);
    // 已过期授予=100 但已消耗=100 → 未处理过期=0；还原行未过期 → 0 扣减
    expect(swept).toEqual({ swept: 0 });
    expect((await accountOf(USER))!.balance).toBe(100);
    expect((await txnsOf(USER)).filter((t) => t.kind === 'EXPIRE')).toHaveLength(0);
  });

  // ---------- 过期 job 路径（POINTS_EXPIRE 执行器内核） ----------

  it('expireUser：按用户聚合扣 min(未处理过期, balance)，EXPIRE 行 + PointsExpired 出箱；再扫幂等 0 扣', async () => {
    await rawGrant(USER, 100, "interval '-2 day'");
    await rawGrant(USER, 50, "interval '30 days'");
    const swept = await sweep(USER);
    expect(swept).toEqual({ swept: 100 });

    expect(await accountOf(USER)).toEqual({ balance: 50, frozen: 0 });
    const expireRows = (await txnsOf(USER)).filter((t) => t.kind === 'EXPIRE');
    expect(expireRows).toHaveLength(1);
    expect(expireRows[0]).toMatchObject({ delta: -100, source_ref: null, expires_at: null });
    expect(await outboxOf(POINTS_EXPIRED_TOPIC)).toEqual([
      {
        user_id: USER,
        delta: -100,
        kind: 'EXPIRE',
        ref: null,
        balance_after: 50,
      } satisfies PointsExpiredPayload,
    ]);

    const again = await sweep(USER);
    expect(again).toEqual({ swept: 0 }); // 幂等：未处理额已清
    expect(await outboxOf(POINTS_EXPIRED_TOPIC)).toHaveLength(1);
  });

  it('frozen 冻结中不过期（最小裁决）：过期额被 balance 上限截断、frozen 完好；解冻回摆后按原 expires_at 即扫', async () => {
    await rawGrant(USER, 100, "interval '3 seconds'"); // 3 秒后过期
    const frozen = await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 100,
      order_payable_cents: 200,
    });
    expect(frozen.balance).toBe(0);

    await sleep(3400); // 授予行过期
    expect(await sweep(USER)).toEqual({ swept: 0 }); // balance=0 → 扣减截断，frozen 完好
    expect((await accountOf(USER))!.frozen).toBe(100);
    expect((await txnsOf(USER)).filter((t) => t.kind === 'EXPIRE')).toHaveLength(0);

    await points.unfreeze({ user_id: USER, payment_order_id: 9 }); // 回 balance（原时钟）
    expect(await sweep(USER)).toEqual({ swept: 100 }); // 原 expires_at 已过 → 即扫
    expect(await accountOf(USER)).toEqual({ balance: 0, frozen: 0 });
    expect((await txnsOf(USER)).filter((t) => t.kind === 'EXPIRE')).toHaveLength(1);
  });

  it('expireAll：多用户批量扫（逐用户 EXPIRE 行+事件）；无账户行/无过期额用户跳过', async () => {
    await rawGrant(USER, 100, "interval '-2 day'");
    await rawGrant(USER_B, 70, "interval '-1 day'");
    await points.grant({ user_id: USER + 100, points: 30, kind: 'COMPENSATION', ref: 'fresh:r1' }); // 未过期不扫
    await points.grant({ user_id: USER + 101, points: 30, kind: 'COMPENSATION', ref: 'fresh:r2' });
    await rawGrant(USER + 101, 40, "interval '-3 day'"); // 有过期额

    const r = await app
      .get(PgPoolService)
      .withTransaction((uow: SqlExecutor) => points.expireAll(uow));
    expect(r).toEqual({ users_swept: 3, points_expired: 210 });
    expect(await outboxOf(POINTS_EXPIRED_TOPIC)).toHaveLength(3);
    expect(await accountOf(USER)).toEqual({ balance: 0, frozen: 0 });
    expect(await accountOf(USER_B)).toEqual({ balance: 0, frozen: 0 });
  });

  // ---------- GET /points/mine 数据面（REST 契约在 http spec；此处服务面） ----------

  it('getMine：{balance(可用,惰性剔除过期), frozen, expiring_soon[7d 窗口]}；无账户行全零', async () => {
    const empty = await points.getMine(USER);
    expect(empty).toEqual({ balance: 0, frozen: 0, expiring_soon: [] });

    await rawGrant(USER, 100, "interval '2 days'"); // 7d 窗口内 → expiring_soon
    await rawGrant(USER, 50, "interval '30 days'"); // 窗口外
    await rawGrant(USER, 20, "interval '-1 day'"); // 已过期 → 剔余额不进 expiring_soon
    await points.freeze({
      user_id: USER,
      payment_order_id: 9,
      points_to_use: 30,
      order_payable_cents: 100000,
    });

    const mine = await points.getMine(USER);
    expect(mine.frozen).toBe(30);
    // 物理 balance=170−冻结 30=140；未处理过期=20 → 可用=120
    expect(mine.balance).toBe(120);
    expect(mine.expiring_soon).toHaveLength(1);
    expect(mine.expiring_soon[0]).toMatchObject({ points: 100 });
    expect(
      Math.abs(new Date(mine.expiring_soon[0]!.expires_at).getTime() - (Date.now() + 2 * DAY)),
    ).toBeLessThan(10_000);
  });

  // ---------- §8 并发超用（10 并发同账户下单冻结，真并发多连接） ----------

  it('§8 10 并发同账户冻结不超用：恰可负担笔数成功、其余 409，balance>=0 且 成功笔数×冻结额 ≤ 初始余额', async () => {
    await points.grant({ user_id: USER, points: 1000, kind: 'COMPENSATION', ref: 'r:1' });
    const freezeOnce = (orderId: number) =>
      points.freeze({
        user_id: USER,
        payment_order_id: orderId,
        points_to_use: 300,
        order_payable_cents: 1_000_000,
      });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => freezeOnce(i + 1)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejectedReasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as { code?: string });
    expect(fulfilled).toHaveLength(3); // 1000/300 → 恰 3 笔
    expect(rejectedReasons).toHaveLength(7);
    for (const reason of rejectedReasons) {
      expect(reason.code).toBe(ErrorCode.InsufficientFunds);
    }
    expect(await accountOf(USER)).toEqual({ balance: 100, frozen: 900 });
    expect(3 * 300).toBeLessThanOrEqual(1000);
  });

  // ---------- 流水不可变（DB 触发器；「流水不可变+余额行锁」纪律的 DB 兜底层） ----------

  it('points_txns 不可变：UPDATE/DELETE → 触发器 P0001（R-03 纪律同源；无独立状态列不涉 STL）', async () => {
    await points.grant({ user_id: USER, points: 100, kind: 'COMPENSATION', ref: 'r:1' });
    await expect(
      pool.query('UPDATE benefits.points_txns SET delta = 0 WHERE user_id = $1', [USER]),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('DELETE FROM benefits.points_txns WHERE user_id = $1', [USER]),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  // ---------- in-tx 变体（M1-W3 T7 C3 同事务编排地基：调用方事务参与，任一失败全回滚含冻结） ----------

  it('freezeInTx/settleInTx/unfreezeInTx：外层事务回滚 → 冻结零残留（self-tx freeze 做不到的同事务原子性）', async () => {
    await rawGrant(USER, 1_000, "interval '180 days'");
    const poolSvc = app.get(PgPoolService);

    // 外层事务内冻结后回滚：FREEZE 留痕/账户列移动必须一并消失
    await expect(
      poolSvc.withTransaction(async (uow) => {
        await points.freezeInTx(uow, {
          user_id: USER,
          payment_order_id: 9001,
          points_to_use: 300,
          order_payable_cents: 1_000,
        });
        throw new Error('force-rollback');
      }),
    ).rejects.toThrow('force-rollback');
    expect(await accountOf(USER)).toEqual({ balance: 1_000, frozen: 0 });
    expect((await txnsOf(USER)).filter((t) => t.kind === 'FREEZE')).toHaveLength(0);

    // 正路径：同事务内 冻结→核销 编排（C3 回调守卫事务形态），提交后状态与流水自洽
    await poolSvc.withTransaction(async (uow) => {
      await points.freezeInTx(uow, {
        user_id: USER,
        payment_order_id: 9001,
        points_to_use: 300,
        order_payable_cents: 1_000,
      });
      await points.settleInTx(uow, { user_id: USER, payment_order_id: 9001 });
    });
    expect(await accountOf(USER)).toEqual({ balance: 700, frozen: 0 }); // 1000-300 冻结再核销

    // 解冻变体（C3 自动退款分支形态）：冻结后同事务解冻 → 原额回摆
    await poolSvc.withTransaction(async (uow) => {
      await points.freezeInTx(uow, {
        user_id: USER,
        payment_order_id: 9002,
        points_to_use: 200,
        order_payable_cents: 1_000,
      });
      await points.unfreezeInTx(uow, { user_id: USER, payment_order_id: 9002 });
    });
    expect(await accountOf(USER)).toEqual({ balance: 700, frozen: 0 });
    const kinds = (await txnsOf(USER)).map((t) => `${t.kind}:${t.source_ref}`);
    expect(kinds).toContain('FREEZE:order:9001');
    expect(kinds).toContain('REDEEM:order:9001');
    expect(kinds).toContain('FREEZE:order:9002');
    expect(kinds).toContain('UNFREEZE:order:9002');
  });

  it('freezeInTx 同一外层事务内重放短路 + R-01 50% 上限同样生效（与 self-tx freeze 同口径）', async () => {
    await rawGrant(USER, 1_000, "interval '180 days'");
    const poolSvc = app.get(PgPoolService);
    await poolSvc.withTransaction(async (uow) => {
      const first = await points.freezeInTx(uow, {
        user_id: USER,
        payment_order_id: 9101,
        points_to_use: 500, // 恰 50%（1000 分应付上限 500）
        order_payable_cents: 1_000,
      });
      expect(first.deduplicated).toBe(false);
      const replay = await points.freezeInTx(uow, {
        user_id: USER,
        payment_order_id: 9101,
        points_to_use: 500,
        order_payable_cents: 1_000,
      });
      expect(replay.deduplicated).toBe(true); // 同 order 幂等短路（同事务内同样生效）
      await expect(
        points.freezeInTx(uow, {
          user_id: USER,
          payment_order_id: 9102,
          points_to_use: 501, // >50% → 拒绝
          order_payable_cents: 1_000,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    });
    expect(await accountOf(USER)).toEqual({ balance: 500, frozen: 500 });
  });
});
