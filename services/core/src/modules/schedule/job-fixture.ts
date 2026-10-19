/**
 * 跨域集成测试夹具：到期 job 与锁 TTL 回拨（owner=schedule 侧唯一合法直写点，lawyer-fixture
 * 同款纪律）。仅供其他域的集成 spec 复用（生产代码禁 import）——I2/B2 机制自身的覆盖在
 * scheduler.spec/slot-lock.spec（其回拨夹具内联于 owner spec）；此处只造「trade 域 spec 确定性
 * 触发 ENROLL_DEADLINE/C2B_CONFIRM_TIMEOUT/SLOT_TTL 到期」所需的行级回拨（免真实等待）。
 *
 * check-schema-refs：本文件 owner=schedule，直写 schedule 表合法；引用方（其他域 spec）只
 * import 本函数、不内联 schedule 表名，红线不破。
 */
import type { Pool } from 'pg';

/** 把某 ref 的 PENDING 到期 job 回拨到过去（确定性触发；jobType=ENROLL_DEADLINE|C2B_CONFIRM_TIMEOUT|SLOT_TTL） */
export async function backdateJobDue(
  pool: Pool,
  jobType: string,
  refType: string,
  refId: number,
): Promise<void> {
  await pool.query(
    `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1 second'
      WHERE job_type = $1 AND ref_type = $2 AND ref_id = $3 AND status = 'PENDING'`,
    [jobType, refType, refId],
  );
}

/** 把某把占用锁的 TTL 时刻回拨到过去（配 backdateJobDue('SLOT_TTL','slot_lock',lockId) 成对使用——
 *  releaseExpiredTtl 双条件 status=PENDING_PAYMENT AND ttl_at<=now()，单拨 job 不释放） */
export async function backdateLockTtl(pool: Pool, lockId: number): Promise<void> {
  await pool.query(
    `UPDATE schedule.slot_locks SET ttl_at = now() - interval '1 second' WHERE id = $1`,
    [lockId],
  );
}

/** 某业务 ref 的活跃锁行 id（回拨 ttl 的定位锚；无活跃锁=null） */
export async function getActiveLockId(
  pool: Pool,
  refType: string,
  refId: number,
): Promise<number | null> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM schedule.slot_locks
      WHERE ref_type = $1 AND ref_id = $2
        AND status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED')
      ORDER BY id DESC LIMIT 1`,
    [refType, refId],
  );
  const id = res.rows[0]?.id;
  return id === undefined ? null : Number(id);
}

/** ref_type 维度活跃锁行计数（「重放不重复加锁」类断言用） */
export async function countActiveLocks(pool: Pool, refType: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM schedule.slot_locks
      WHERE ref_type = $1 AND status IN ('PENDING_PAYMENT', 'LOCKED', 'OCCUPIED')`,
    [refType],
  );
  return res.rows[0]!.n;
}

// ---- M2-W2 T5 扩展：C5 改期 spec 的 job 断言锚（RESCHEDULE_CONFIRM_TIMEOUT 状态/作废、
//      REMIND×4 场次锚集合不变性——「提醒重投零操作」的断言面；owner 直写纪律同上） ----

/** 某 ref 的最新 job 行状态（无行=undefined——jobType 含 RESCHEDULE_CONFIRM_TIMEOUT|REMIND_* 等） */
export async function jobStatusRaw(
  pool: Pool,
  jobType: string,
  refType: string,
  refId: number,
): Promise<string | undefined> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM schedule.schedule_jobs
      WHERE job_type = $1 AND ref_type = $2 AND ref_id = $3
      ORDER BY id DESC LIMIT 1`,
    [jobType, refType, refId],
  );
  return res.rows[0]?.status;
}

/** 某场次锚 REMIND 系列 job 的 "job_type:status" 快照（集合逐字比对=零作废零预写断言锚） */
export async function remindJobSnapshotRaw(pool: Pool, sessionId: number): Promise<string[]> {
  const res = await pool.query<{ job_type: string; status: string }>(
    `SELECT job_type, status FROM schedule.schedule_jobs
      WHERE job_type LIKE 'REMIND%' AND ref_type = 'session' AND ref_id = $1
      ORDER BY job_type`,
    [sessionId],
  );
  return res.rows.map((r) => `${r.job_type}:${r.status}`);
}

// ---- F3=R8/T8 消费域断言扩展（M1-W3 T8；同头注纪律：owner=schedule 唯一合法直读点） ----

/** job 行列表（按类型；在册/重注册/终态断言用——读写经 I2 API，本夹具只读） */
export async function listJobsByType(
  pool: Pool,
  jobType: string,
): Promise<readonly { id: number; ref_id: number | null; status: string; due_at: Date }[]> {
  const res = await pool.query<{
    id: string;
    ref_id: string | null;
    status: string;
    due_at: Date;
  }>(
    `SELECT id, ref_id, status, due_at FROM schedule.schedule_jobs
      WHERE job_type = $1 ORDER BY id`,
    [jobType],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    ref_id: r.ref_id === null ? null : Number(r.ref_id),
    status: r.status,
    due_at: r.due_at,
  }));
}

/** job 执行日志按结果计数（「重试补齐 DONE」类断言用；owner=schedule 唯一合法直读点） */
export async function countJobLogsByResult(
  pool: Pool,
  jobType: string,
  result: string,
): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM schedule.schedule_job_log
      WHERE job_type = $1 AND result = $2`,
    [jobType, result],
  );
  return res.rows[0]!.n;
}

// ---- M1-W4 T1 扩展：H4 资损巡检故障注入（活跃锁直插 + PENDING job 直插回拨） ----

/** 直插一把占用锁（活跃三态可指定；slotStartAgoMs/ttlAtAgoMs 回拨段位/TTL 时刻——巡检②类窗口锚） */
export async function seedSlotLockRaw(
  pool: Pool,
  o: {
    readonly lawyerId: number;
    readonly refType: string;
    readonly refId: number;
    readonly status: 'PENDING_PAYMENT' | 'LOCKED' | 'OCCUPIED' | 'RELEASED';
    readonly slotStartAgoMs?: number;
    readonly ttlAtAgoMs?: number;
  },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO schedule.slot_locks
       (lawyer_id, slot_start, status, ref_type, ref_id, initiator_user_id, ttl_at)
     VALUES ($1,
             now() - ($2::bigint * interval '1 millisecond'),
             $3, $4, $5, 601,
             CASE WHEN $6::bigint IS NULL THEN NULL
                  ELSE now() - ($6::bigint * interval '1 millisecond') END)
     RETURNING id`,
    [
      o.lawyerId,
      o.slotStartAgoMs ?? -3_600_000,
      o.status,
      o.refType,
      o.refId,
      o.ttlAtAgoMs ?? null,
    ],
  );
  return Number(res.rows[0]!.id);
}

/** 直插一 PENDING job 并回拨到期时刻（巡检③类积压故障注入；dueAtAgoMs 回拨 due_at） */
export async function seedPendingJobRaw(
  pool: Pool,
  o: {
    readonly jobType: string;
    readonly refType: string;
    readonly refId: number;
    readonly dueAtAgoMs: number;
  },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO schedule.schedule_jobs (job_type, ref_type, ref_id, due_at)
     VALUES ($1, $2, $3, now() - ($4::bigint * interval '1 millisecond'))
     RETURNING id`,
    [o.jobType, o.refType, o.refId, o.dueAtAgoMs],
  );
  return Number(res.rows[0]!.id);
}

// ---- M2-W2 T2 扩展：D3（fulfillment 域）spec 的 job 流控回拨/静默 ----

/** 某房间 ref 的指定类型 PENDING job 批量回拨到期（ABSENT_15M/NO_SHOW_CLOSE 等 due=未来锚的
 *  确定性触发——同 backdateJobDue 的多类型批形态；D3 预写 due=grace_end+15min 天然未来） */
export async function backdateRoomJobsDue(
  pool: Pool,
  jobTypes: readonly string[],
  roomId: number,
): Promise<void> {
  await pool.query(
    `UPDATE schedule.schedule_jobs SET due_at = now() - interval '1 minute'
      WHERE job_type = ANY($1::varchar[]) AND ref_id = $2 AND status = 'PENDING'`,
    [jobTypes, roomId],
  );
}

/** 指定类型 PENDING job 批量终态化（消费域 spec 静音未装配执行器的 job 类型——REMIND 系
 *  executor=notify 域，D3 spec 应用未装载时防 NO_EXECUTOR 噪音；亦用于模拟 job 未达） */
export async function cancelPendingJobsByType(
  pool: Pool,
  jobTypes: readonly string[],
  refId?: number,
): Promise<void> {
  await pool.query(
    `UPDATE schedule.schedule_jobs SET status = 'CANCELLED'
      WHERE job_type = ANY($1::varchar[]) AND status = 'PENDING'
        AND ($2::bigint IS NULL OR ref_id = $2)`,
    [jobTypes, refId ?? null],
  );
}
