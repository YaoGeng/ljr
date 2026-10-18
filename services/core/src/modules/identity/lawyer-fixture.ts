/**
 * 跨域集成测试夹具：identity 域直插（本 schema owner 侧唯一合法直写点，沿
 * w1-smoke「落被查表的 owner 侧」纪律）。仅供其他域的集成 spec 复用（生产代码禁 import）——
 * A3a 审核写路径自身的覆盖在 lawyer-qualification.spec；此处只造「R-01 isAuditPassed 查询面
 * 所需的档案行」（审核动作面 profileId 由 H1 admin 链路获取，跨域 spec 无导出读取面，故直插）
 * 与「admin 面鉴权三态所需的账号壳/角色行」（⚠W3-8：admin=DB 级预置权限旗标，夹具同口径；
 * A1 注册链路自身的覆盖在 identity.spec，此处只造最小壳，生产代码禁 import）。
 *
 * check-schema-refs：本文件 owner=identity，直写 identity 表合法；引用方（其他域 spec）只
 * import 本函数、不内联 identity 表名，红线不破。
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/** 直插一条档案行（audit_status=PASSED 供列表可见；SUBMITTED 供隐藏侧对照），返回档案 id；
 *  city 可选（序 11.5 V33 执业城市维：缺省不写列=落 DB DEFAULT '北京'，携带则显式落值——
 *  供 C1/C2 双维物化用例造「非北京执业城市」律师）；
 *  firmId 可选（M2-W1 T1 加法：firm_id 绑定注入——A3b 进件后形态，D1 RoomClosed 聚合用例锚） */
export async function seedLawyerProfile(
  pool: Pool,
  userId: number,
  auditStatus: 'PASSED' | 'SUBMITTED',
  tag: string,
  city?: string,
  firmId?: number,
): Promise<number> {
  const base = `INSERT INTO identity.lawyer_profiles
       (user_id, license_no_enc, license_no_blind_idx, firm_name,
        material_version, material_fingerprint, audit_status, submitted_at`;
  const params: unknown[] = [
    userId,
    Buffer.from(`fixture-enc-${tag}`), // 密文列：夹具只求形态合法，不参与解密断言
    createHash('sha256').update(`blind:${tag}`).digest('hex'), // char(64) 盲索引形态
    `夹具律所-${tag}`,
    createHash('sha256').update(`fp:${tag}`).digest('hex'), // char(64) 指纹形态
    auditStatus,
  ];
  const tailCols: string[] = [];
  const tailParams: unknown[] = [];
  if (city !== undefined) {
    tailCols.push('city');
    tailParams.push(city);
  }
  if (firmId !== undefined) {
    tailCols.push('firm_id');
    tailParams.push(firmId);
  }
  const sql =
    tailCols.length === 0
      ? `${base}) VALUES ($1, $2, $3, $4, 1, $5, $6, now()) RETURNING id`
      : `${base}, ${tailCols.join(', ')})
         VALUES ($1, $2, $3, $4, 1, $5, $6, now(), ${tailParams.map((_, i) => `$${7 + i}`).join(', ')})
         RETURNING id`;
  const res = await pool.query<{ id: string }>(sql, [...params, ...tailParams]);
  return Number(res.rows[0]!.id);
}

/**
 * 直插最小壳用户行（ACTIVE；夹具只求 FK 形态合法，A1 链路断言归 identity.spec），返回 user id。
 * id 显式给定时直插该 id——供 truncate 后 sequence 重置场景防 id 复用碰撞（同批 beforeAll 预置
 * 账号 id 与用例内新建账号 id 撞号，见 H1 spec 用法：显式取 lawyerUserId+1/+2 错开）。
 */
export async function seedUserShell(pool: Pool, tag: string, id?: number): Promise<number> {
  const blind = createHash('sha256').update(`blind:${tag}`).digest('hex'); // char(64) 盲索引形态
  const res =
    id === undefined
      ? await pool.query<{ id: string }>(
          `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
           VALUES ($1, $2, 'ACTIVE', true) RETURNING id`,
          [Buffer.from(`fixture-${tag}`), blind], // 密文列：夹具只求形态合法，不参与解密断言
        )
      : await pool.query<{ id: string }>(
          `INSERT INTO identity.users (id, phone_enc, phone_blind_idx, status, age_declared)
           VALUES ($1, $2, $3, 'ACTIVE', true) RETURNING id`,
          [id, Buffer.from(`fixture-${tag}`), blind],
        );
  return Number(res.rows[0]!.id);
}

/** 直插用户角色行（PK 幂等；admin=DB 级预置权限旗标 ⚠W3-8，夹具同口径直插） */
export async function grantUserRoles(
  pool: Pool,
  userId: number,
  roles: readonly ('user' | 'lawyer' | 'admin')[],
): Promise<void> {
  if (roles.length === 0) return;
  const tuples = roles.map((_, i) => `($1, $${i + 2})`).join(', ');
  await pool.query(
    `INSERT INTO identity.user_roles (user_id, role) VALUES ${tuples} ON CONFLICT DO NOTHING`,
    [userId, ...roles],
  );
}
