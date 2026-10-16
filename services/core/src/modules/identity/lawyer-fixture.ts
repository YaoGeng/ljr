/**
 * 跨域集成测试夹具：identity.lawyer_profiles 直插（本 schema owner 侧唯一合法直写点，沿
 * w1-smoke「落被查表的 owner 侧」纪律）。仅供其他域的集成 spec 复用（生产代码禁 import）——
 * A3a 审核写路径自身的覆盖在 lawyer-qualification.spec；此处只造「R-01 isAuditPassed 查询面
 * 所需的档案行」（审核动作面 profileId 由 H1 admin 链路获取，跨域 spec 无导出读取面，故直插）。
 *
 * check-schema-refs：本文件 owner=identity，直写 identity 表合法；引用方（其他域 spec）只
 * import 本函数、不内联 identity 表名，红线不破。
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** 直插一条档案行（audit_status=PASSED 供列表可见；SUBMITTED 供隐藏侧对照），返回档案 id */
export async function seedLawyerProfile(
  pool: Pool,
  userId: number,
  auditStatus: 'PASSED' | 'SUBMITTED',
  tag: string,
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO identity.lawyer_profiles
       (user_id, license_no_enc, license_no_blind_idx, firm_name,
        material_version, material_fingerprint, audit_status, submitted_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, now())
     RETURNING id`,
    [
      userId,
      Buffer.from(`fixture-enc-${tag}`), // 密文列：夹具只求形态合法，不参与解密断言
      createHash('sha256').update(`blind:${tag}`).digest('hex'), // char(64) 盲索引形态
      `夹具律所-${tag}`,
      createHash('sha256').update(`fp:${tag}`).digest('hex'), // char(64) 指纹形态
      auditStatus,
    ],
  );
  return Number(res.rows[0]!.id);
}
