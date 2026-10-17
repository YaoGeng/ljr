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
