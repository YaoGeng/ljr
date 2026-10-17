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
import { LawyerQualificationModule } from './lawyer-qualification.module';
import { LawyerQualificationService } from './lawyer.service';

/**
 * A3a REST 契约（§5 律师侧）：POST /lawyer/qualification、GET /lawyer/audit-status（本人视角，
 * user_id 取 JWT claims——提交者尚未持有 lawyer 角色，R-03 角色守卫不适用，A2 同口径）。
 * W3 T10：POST /admin/lawyers/{id}/audit 的 HTTP 面随 H1 落位迁 ops（ops/lawyer-admin.http.spec，
 * G-A 前置门接线+同事务审计+auditor_id 断言在彼处承载）——本文件原 admin 面用例随迁移退役。
 * 路由参数 {id}=lawyer_profiles.id（审核工作台操作对象=资质档案）。
 */

/** 虚构执业证号（仅测试域；与任何真实执业证无关） */
const LICENSE = 'LICENSE-SPEC-0100';
const VALID_BODY = {
  license_no: LICENSE,
  firm_name: '北京测试律师事务所',
  files: [
    { kind: 'LICENSE_PHOTO', ref: 'spec/oss/license-rest.jpg' },
    { kind: 'FIRM_AUTHORIZATION', ref: 'spec/oss/auth-rest.pdf' },
  ],
};

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('A3a REST 契约（律师提交面 + admin 审核面，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let token: string;
  let userId: number;

  async function profileIdOf(userId: number): Promise<number> {
    const res = await pool.query<{ id: string }>(
      'SELECT id FROM identity.lawyer_profiles WHERE user_id = $1',
      [userId],
    );
    return Number(res.rows[0]!.id);
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [LawyerQualificationModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
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
    // 测试身份直插 users（A1 建号链路已由 identity.spec 覆盖），claims 形态与真实签发一致
    const res = await pool.query<{ id: string }>(
      `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
       VALUES ($1, $2, 'ACTIVE', true) RETURNING id`,
      [Buffer.from('fixture'), randomBytes(32).toString('hex')],
    );
    userId = Number(res.rows[0]!.id);
    token = await app
      .get(IdentityTokenService)
      .signAccessToken({ userId, role: 'user', roles: ['user'] });
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  it('POST /lawyer/qualification：无 token → 401；有效 → {status:"SUBMITTED"}；形态防呆 → 400 E_INVALID_ARGUMENT', async () => {
    const anon = await request(app.getHttpServer()).post('/lawyer/qualification').send(VALID_BODY);
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const ok = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ status: 'SUBMITTED' });
    expect(JSON.stringify(ok.body)).not.toContain(LICENSE); // 出参无 PII

    const noLicense = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, license_no: '' });
    expect(noLicense.status).toBe(400);
    expect(noLicense.body.code).toBe(ErrorCode.InvalidArgument);

    const noFiles = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send({ license_no: 'LICENSE-SPEC-0101', files: [] });
    expect(noFiles.status).toBe(400);
    expect(noFiles.body.code).toBe(ErrorCode.InvalidArgument);

    const badFile = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send({ license_no: 'LICENSE-SPEC-0101', files: [{ kind: '', ref: 'x' }] });
    expect(badFile.status).toBe(400);
    expect(badFile.body.code).toBe(ErrorCode.InvalidArgument);
  });

  it('POST /lawyer/qualification：重复提交（SUBMITTED/IN_REVIEW）→ 409 E_ALREADY_SUBMITTED（§5 幂等键=user）', async () => {
    const first = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(first.status).toBe(201);

    const again = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe(ErrorCode.AlreadySubmitted);

    const service = app.get(LawyerQualificationService);
    await service.audit(await profileIdOf(userId), { action: 'claim' });
    const inReview = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(inReview.status).toBe(409);
    expect(inReview.body.code).toBe(ErrorCode.AlreadySubmitted);
  });

  it('GET /lawyer/audit-status：无 token → 401；DRAFT → SUBMITTED → REJECTED 带 reason（本人视角，无 PII 出参）', async () => {
    const anon = await request(app.getHttpServer()).get('/lawyer/audit-status');
    expect(anon.status).toBe(401);

    const draft = await request(app.getHttpServer())
      .get('/lawyer/audit-status')
      .set('Authorization', `Bearer ${token}`);
    expect(draft.status).toBe(200);
    expect(draft.body).toEqual({ status: 'DRAFT' });

    await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);

    const submitted = await request(app.getHttpServer())
      .get('/lawyer/audit-status')
      .set('Authorization', `Bearer ${token}`);
    expect(submitted.status).toBe(200);
    expect(submitted.body).toEqual({ status: 'SUBMITTED' });
    expect(JSON.stringify(submitted.body)).not.toContain(LICENSE);

    const service = app.get(LawyerQualificationService);
    await service.audit(await profileIdOf(userId), { action: 'claim' });
    await service.audit(await profileIdOf(userId), {
      action: 'reject',
      rejectReason: '执业证照片模糊',
    });
    const rejected = await request(app.getHttpServer())
      .get('/lawyer/audit-status')
      .set('Authorization', `Bearer ${token}`);
    expect(rejected.status).toBe(200);
    expect(rejected.body).toEqual({ status: 'REJECTED', reason: '执业证照片模糊' });
  });
});
