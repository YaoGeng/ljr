/**
 * trade 域测试夹具（跨模块 spec 专用，M1-W3 T9 C6 起）：场次/拼团/报名行的直插与清场。
 *
 * 定位（check-schema-refs 目录→schema 约定）：C6（pricing 域）e2e 需要 trade 侧在团/补偿对象
 * 夹具——SQL 落本文件（owner=trade，同域合法），spec 只 import 函数，不直写 trade.* 表
 * （架构 §3.2「跨模块取数走接口」的测试面口径；运行时取数仍走导出服务）。仅供 *.spec.ts
 * 使用，生产代码禁 import。
 */
import type { Pool } from 'pg';

export interface SeedPaidEnrollmentOptions {
  /** 报名人（identity 侧用户 id） */
  readonly userId?: number;
  readonly cash: string;
  readonly points: number;
  readonly unitPrice: string;
}

/** 直插一场次行（唯一 slot_start 由自增序保证），可选挂一个 PAID 报名；返回场次 id */
export async function seedSessionRaw(
  pool: Pool,
  lawyerId: number,
  status: string,
  slotSeq: number,
  enrollment?: SeedPaidEnrollmentOptions,
): Promise<number> {
  const s = await pool.query<{ id: string }>(
    `INSERT INTO trade.sessions
       (lawyer_id, mode, slot_start, price_mode, unit_price, session_total, capacity, joined,
        enroll_deadline, room_mode, status)
     VALUES ($1, 'B2C', now() + ($2 || ' days')::interval, 'per_head', $3, $3, 5, 0,
             now() + interval '10 days', 'text', $4)
     RETURNING id`,
    [lawyerId, String(slotSeq), enrollment?.unitPrice ?? '100.00', status],
  );
  const sessionId = Number(s.rows[0]!.id);
  if (enrollment && enrollment.userId !== undefined) {
    await seedPaidEnrollmentRaw(pool, 'session', sessionId, {
      ...enrollment,
      userId: enrollment.userId,
    });
  }
  return sessionId;
}

/** 直插一拼团任务行（PUBLISHED 等状态；仅作在团判定夹具）；返回拼团 id */
export async function seedGroupBuyRaw(
  pool: Pool,
  lawyerId: number,
  status: string,
): Promise<number> {
  const g = await pool.query<{ id: string }>(
    `INSERT INTO trade.group_buys
       (initiator_id, lawyer_id, specialty, slot_start, sub_min, sub_max, share_price,
        question_tags, deadline, status)
     VALUES (601, $1, 'labor_arbitration', now() + interval '5 days', 2, 5, '80.00',
             '[]'::jsonb, now() + interval '4 days', $2)
     RETURNING id`,
    [lawyerId, status],
  );
  return Number(g.rows[0]!.id);
}

/** 直插一 PAID 报名行（paid_amount=cash+points/100 全额口径，D17 分母整化的数据源） */
export async function seedPaidEnrollmentRaw(
  pool: Pool,
  refType: 'session' | 'groupbuy',
  refId: number,
  o: SeedPaidEnrollmentOptions & { readonly userId: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO trade.enrollments
       (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
        points_amount, price_version_id, pay_status, credit_used)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7, 1, 'PAID', 0)`,
    [refType, refId, o.userId, o.unitPrice, o.cash, o.cash, o.points],
  );
}
