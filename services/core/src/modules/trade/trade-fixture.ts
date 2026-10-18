/**
 * trade 域测试夹具（跨模块 spec 专用，M1-W3 T9 C6 起）：场次/拼团/报名行的直插与清场。
 *
 * 定位（check-schema-refs 目录→schema 约定）：C6（pricing 域）e2e 需要 trade 侧在团/补偿对象
 * 夹具——SQL 落本文件（owner=trade，同域合法），spec 只 import 函数，不直写 trade.* 表
 * （架构 §3.2「跨模块取数走接口」的测试面口径；运行时取数仍走导出服务）。仅供 *.spec.ts
 * 使用，生产代码禁 import。
 *
 * M1-W4 T1 扩展：终态迁移时刻回拨（H4 巡检①类窗口锚=status_since 的故障注入用）。
 */
import type { Pool } from 'pg';
import { centsToMoney, moneyToCents } from './session.types';

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

/** 直插一 PAID 报名行（F-7：paid_amount=全额口径注入=cash 分+points（1 积分=1 分）两位小数化，
 *  与 C3 报名链「paid=cash+points 折元」一致，D17 分母整化的数据源）；M2-W1 T1 起返回报名 id
 *  （D1 close 聚合需配对 F1 支付单幂等键 enroll/e{id}/pay——跨域 spec 组装锚） */
export async function seedPaidEnrollmentRaw(
  pool: Pool,
  refType: 'session' | 'groupbuy',
  refId: number,
  o: SeedPaidEnrollmentOptions & { readonly userId: number },
): Promise<number> {
  const paidFull = centsToMoney(moneyToCents(o.cash) + o.points);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO trade.enrollments
       (ref_type, ref_id, user_id, price_snapshot, unit_price, paid_amount, cash_amount,
        points_amount, price_version_id, pay_status, credit_used)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, $7, 1, 'PAID', 0)
     RETURNING id`,
    [refType, refId, o.userId, o.unitPrice, paidFull, o.cash, o.points],
  );
  return Number(res.rows[0]!.id);
}

// ---- M2-W1 T1 扩展：D1 房间生命周期 spec 的场次注入（slot_start 显式任意时刻——misfire/
// 宽限锚/延迟告警的过去量注入；seedSessionRaw 的 slotSeq 天数偏移只造未来场次） ----

/** 直插一场次行（slot_start/状态/沟通形式显式给定——过去时刻用于 ROOM_OPEN misfire 与宽限锚
 *  用例；唯一性由调用方错开时刻保证）；返回场次 id */
export async function seedSessionAtRaw(
  pool: Pool,
  lawyerId: number,
  status: string,
  slotStart: Date,
  roomMode: string = 'text',
): Promise<number> {
  const s = await pool.query<{ id: string }>(
    `INSERT INTO trade.sessions
       (lawyer_id, mode, slot_start, price_mode, unit_price, session_total, capacity, joined,
        enroll_deadline, room_mode, status)
     VALUES ($1, 'B2C', $2, 'per_head', '100.00', '100.00', 5, 0,
             $2::timestamptz - interval '24 hours', $3, $4)
     RETURNING id`,
    [lawyerId, slotStart, roomMode, status],
  );
  return Number(s.rows[0]!.id);
}

// ---- M2-W1 T4 扩展：D2（notify 域）spec 的场次状态读数（跨域 spec 只 import，不内联表名） ----

/** 场次状态直读（D2 幂等回查/流标断言锚；行不存在=undefined——修环 M1 兑现可选返回） */
export async function sessionStatusRaw(pool: Pool, sessionId: number): Promise<string | undefined> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM trade.sessions WHERE id = $1`,
    [sessionId],
  );
  return res.rows[0]?.status;
}

// ---- M1-W4 T1 扩展：H4 资损巡检①类故障注入（终态迁移时刻回拨，窗口锚=status_since） ----

/** 回拨场次终态迁移时刻（status_since=now()-ago；巡检①类窗口判定锚） */
export async function backdateSessionStatusSince(
  pool: Pool,
  sessionId: number,
  agoMs: number,
): Promise<void> {
  await pool.query(
    `UPDATE trade.sessions SET status_since = now() - ($2::bigint * interval '1 millisecond')
      WHERE id = $1`,
    [sessionId, agoMs],
  );
}

/** 回拨拼团终态迁移时刻（status_since=now()-ago；巡检①类窗口判定锚） */
export async function backdateGroupBuyStatusSince(
  pool: Pool,
  groupBuyId: number,
  agoMs: number,
): Promise<void> {
  await pool.query(
    `UPDATE trade.group_buys SET status_since = now() - ($2::bigint * interval '1 millisecond')
      WHERE id = $1`,
    [groupBuyId, agoMs],
  );
}
