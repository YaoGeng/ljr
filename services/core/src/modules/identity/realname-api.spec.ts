import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { IdentityTokenService } from './identity.token.service';
import { REALNAME_CONFIG, type RealnameConfig } from './realname.config';
import { MockRealnameProvider, REALNAME_PROVIDER } from './realname.provider';
import { RealnameConsentModule } from './realname-consent.module';

/**
 * A2 REST 契约（§5）：POST /realname、GET /realname/status、GET /admin/realname/decrypt。
 * 认证态路由挂 IdentityAuthGuard（user_id 取 JWT claims，不收 user_id 入参）；
 * R-05：实名信息不对外展示——出参仅 status/verified_at，解密面是唯一明文出口（双人复核）。
 */

/** 形态与校验位均合法的测试证件号；与任何真人无关 */
const VALID_ID_NO = '11010519491231002X';

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('A2 REST 契约（实名面，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let token: string;
  let userId: number;

  /** 直插一条完整双签审批（R-W2-5 合成口径） */
  async function seedApproval(userId: number): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO identity.decrypt_approvals (user_id, reason, approved_by, reviewed_by)
       VALUES ($1, 'spec: 纠纷处理演练', 9001, 9002) RETURNING id`,
      [userId],
    );
    return Number(res.rows[0]!.id);
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [RealnameConsentModule] })
      .overrideProvider(REALNAME_PROVIDER)
      .useValue(new MockRealnameProvider())
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(REALNAME_CONFIG)
      .useValue({ retainIdentityText: true } satisfies RealnameConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    // 测试身份数据直插 users（A1 建号链路已由 identity.spec 覆盖，此处只取 claims 最小壳）
    const res = await pool.query<{ id: string }>(
      `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
       VALUES ($1, $2, 'ACTIVE', true) RETURNING id`,
      [Buffer.from('fixture'), randomBytes(32).toString('hex')],
    );
    const inserted = Number(res.rows[0]!.id);
    userId = inserted;
    // 用 A1 token 服务签发（IdentityAuthModule 经 RealnameConsentModule 可达），claims 形态与真实签发一致
    const tokens = app.get(IdentityTokenService);
    token = await tokens.signAccessToken({ userId: inserted, role: 'user', roles: ['user'] });
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  it('POST /realname：无 token → 401；有效 → {status:"VERIFIED"}；已 VERIFIED 再提交幂等返回现值', async () => {
    const anon = await request(app.getHttpServer()).post('/realname').send({
      name: '张三',
      id_no: VALID_ID_NO,
    });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const ok = await request(app.getHttpServer())
      .post('/realname')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '张三', id_no: VALID_ID_NO });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ status: 'VERIFIED' });

    const again = await request(app.getHttpServer())
      .post('/realname')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '李四', id_no: '110105194912310021' }); // 幂等短路：不再核验也非法件内容
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ status: 'VERIFIED' });
  });

  it('POST /realname：形态非法 → 400 E_INVALID_ID（§5 INVALID_ID，错误体 {code,message}）', async () => {
    const bad = await request(app.getHttpServer())
      .post('/realname')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '', id_no: VALID_ID_NO });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(ErrorCode.InvalidId);

    const badId = await request(app.getHttpServer())
      .post('/realname')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '张三', id_no: '1234' });
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe(ErrorCode.InvalidId);
  });

  it('GET /realname/status：无 token → 401；未实名 NONE；实名后 {status, verified_at}（R-05 无实名本体出参）', async () => {
    const anon = await request(app.getHttpServer()).get('/realname/status');
    expect(anon.status).toBe(401);

    const before = await request(app.getHttpServer())
      .get('/realname/status')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ status: 'NONE' });

    await request(app.getHttpServer())
      .post('/realname')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '张三', id_no: VALID_ID_NO });

    const after = await request(app.getHttpServer())
      .get('/realname/status')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('VERIFIED');
    expect(typeof after.body.verified_at).toBe('string');
    expect(JSON.stringify(after.body)).not.toContain('张三'); // R-05：出参无实名本体
    expect(JSON.stringify(after.body)).not.toContain(VALID_ID_NO);
  });

  it('GET /admin/realname/decrypt：缺/未双签审批 → 403 E_NOT_APPROVED（§10-4）；双签完整 → {name, id_no}', async () => {
    await request(app.getHttpServer())
      .post('/realname')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '张三', id_no: VALID_ID_NO });

    // 无审批 → 403
    const none = await request(app.getHttpServer())
      .get('/admin/realname/decrypt')
      .query({ user_id: userId, reason: '纠纷处理', approval_id: 987654 });
    expect(none.status).toBe(403);
    expect(none.body.code).toBe(ErrorCode.NotApproved);

    // 未双签（reviewed_by NULL，H9 渐进签发中间态）→ 403
    const pending = await pool.query<{ id: string }>(
      `INSERT INTO identity.decrypt_approvals (user_id, reason, approved_by, reviewed_by)
       VALUES ($1, 'spec', 9001, NULL) RETURNING id`,
      [userId],
    );
    const notSigned = await request(app.getHttpServer())
      .get('/admin/realname/decrypt')
      .query({
        user_id: userId,
        reason: '纠纷处理',
        approval_id: Number(pending.rows[0]!.id),
      });
    expect(notSigned.status).toBe(403);
    expect(notSigned.body.code).toBe(ErrorCode.NotApproved);

    // 双签完整 → 200 明文返回（唯一合规出口）
    const approvalId = await seedApproval(userId);
    const ok = await request(app.getHttpServer())
      .get('/admin/realname/decrypt')
      .query({ user_id: userId, reason: '纠纷处理-2026-001', approval_id: approvalId });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ name: '张三', id_no: VALID_ID_NO });
  });

  it('GET /admin/realname/decrypt：缺参 → 400 E_INVALID_ARGUMENT（user_id/approval_id/reason 防呆）', async () => {
    const missing = await request(app.getHttpServer())
      .get('/admin/realname/decrypt')
      .query({ reason: '纠纷处理', approval_id: 1 });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(ErrorCode.InvalidArgument);

    const badReason = await request(app.getHttpServer())
      .get('/admin/realname/decrypt')
      .query({ user_id: 1, reason: '', approval_id: 1 });
    expect(badReason.status).toBe(400);
    expect(badReason.body.code).toBe(ErrorCode.InvalidArgument);
  });
});
