import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode, LAWYER_SUSPENDED_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { PgPoolService } from '../../infrastructure/sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity/identity.config';
import { IdentityTokenService } from '../identity/identity.token.service';
import { grantUserRoles, seedUserShell } from '../identity/lawyer-fixture';
import { LawyerQualificationService } from '../identity/lawyer.service';
import { LawyerAdminModule } from './lawyer-admin.module';

/**
 * H1 律师与资质管理 REST 契约（§5 + W2 终审 G-A 前置门关闭承载面，需 PG）：
 *   GET  /admin/lawyers?status=&page=          入驻审核工作台（SLA 3 工作日剩余=R-01）
 *   POST /admin/lawyers/{id}/audit             转调 A3a 审核面（R-W3-B：action=A3a 实现词汇）；
 *                                              同事务落 ops.audit_logs（§8 全审计）；auditor_id
 *                                              回填（G-A R-W2-G 绑定项，终结恒 NULL）
 *   POST /admin/lawyers/{id}/suspend|resume    停用/恢复（LawyerSuspended 出箱=A3a 既有）
 *   GET  /admin/lawyers/{id}/profile           档案聚合（A3a+A3b+G1+C1 全经服务面，禁跨 schema join）
 * R-02 集成断言：approve→isAuditPassed 翻转（A3a 事件→C3 可见性闸口的本侧闭环证据）。
 * R-03 转调验证：reject 带 reason → 律师重提回 SUBMITTED（A3a 既有行为经 H1 面可达）。
 * 鉴权三态（G-A）：未认证 401 / 未持 admin 旗标 403 E_ROLE_FORBIDDEN / admin 200。
 *
 * owner 纪律：本 spec 直查面=ops 域审计表（owner 表）+ platform.outbox（白名单）；
 * 账号夹具经 identity 域 fixture 函数（lawyer-fixture：跨域只 import、不内联他域表名）；
 * 档案断言走 A3a 服务导出面（profileViewById/isAuditPassed）——禁直查。
 */

const LICENSE = 'LICENSE-H1-SPEC-0001';

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('H1 律师与资质管理（工作台/审核/停用/档案，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let poolSvc: PgPoolService;
  let adminToken: string;
  let userToken: string;
  let qualification: LawyerQualificationService;
  let adminUserId: number;
  let lawyerUserId: number;

  /** 提交一份资质（A3a 服务面夹具）→ 返回 lawyer_profiles.id */
  async function submitProfile(userId: number, license = LICENSE): Promise<number> {
    await qualification.submitQualification(userId, {
      licenseNo: license,
      firmName: '北京H1测试律师事务所',
      files: [{ kind: 'LICENSE_PHOTO', ref: 'spec/oss/h1-license.jpg' }],
    });
    const view = await qualification.auditStatus(userId);
    expect(view.status).toBe('SUBMITTED');
    // {id}=lawyer_profiles.id：经档案导出面定位（owner 纪律：不直查 identity 表）
    const list = await qualification.listSubmissions({ statuses: ['SUBMITTED'] });
    const mine = list.items.find((i) => i.lawyer_user_id === userId);
    if (!mine) throw new Error('夹具提交未进队列');
    return mine.id;
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [LawyerAdminModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const tokens = app.get(IdentityTokenService);
    poolSvc = app.get(PgPoolService);
    qualification = app.get(LawyerQualificationService);

    // 夹具账号：admin=DB 级预置（identity 域 fixture 直插 users+角色行，跨域只 import 不内联
    // 表名），claims 与真实签发一致（⚠W3-8：admin=权限旗标，激活角色仍 user）
    adminUserId = await seedUserShell(pool, 'h1-admin');
    await grantUserRoles(pool, adminUserId, ['user', 'admin']);
    adminToken = await tokens.signAccessToken({
      userId: adminUserId,
      role: 'user',
      roles: ['user', 'admin'],
    });
    lawyerUserId = await seedUserShell(pool, 'h1-lawyer');
    await grantUserRoles(pool, lawyerUserId, ['user']);
    userToken = await tokens.signAccessToken({
      userId: lawyerUserId,
      role: 'user',
      roles: ['user'],
    });
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

  it('GET /admin/lawyers：401 未认证/403 未持 admin；admin：审核队列（提交时间 ASC）+SLA 数据位（R-01）+status 过滤+分页', async () => {
    const anon = await request(app.getHttpServer()).get('/admin/lawyers');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const forbidden = await request(app.getHttpServer())
      .get('/admin/lawyers')
      .set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe(ErrorCode.RoleForbidden);

    // 三个提交（提交时间随插入序单调）+ 第一个领取（仍在队列：IN_REVIEW）
    // 独立账号：identity 域 fixture 直插最小壳（A1 链路已由 identity.spec 覆盖）；
    // 显式 id=lawyerUserId+n 错开——truncate 后 sequence 重置，自动 id 会与 beforeAll
    // 预置的 admin/lawyer 撞号（同批提交队列条目须三个不同 user）
    const u2 = await seedUserShell(pool, 'h1-extra-2', lawyerUserId + 1);
    const u3 = await seedUserShell(pool, 'h1-extra-3', lawyerUserId + 2);
    const p1 = await submitProfile(lawyerUserId);
    await submitProfile(u2, 'LICENSE-H1-SPEC-0002');
    await submitProfile(u3, 'LICENSE-H1-SPEC-0003');
    await poolSvc.withTransaction((uow) =>
      qualification.auditWithExecutor(uow, p1, { action: 'claim' }, adminUserId),
    );

    const list = await request(app.getHttpServer())
      .get('/admin/lawyers')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    expect(list.body.page).toBe(1);
    const items = list.body.items as Record<string, unknown>[];
    expect(items.map((i) => i.lawyer_user_id)).toEqual([lawyerUserId, u2, u3]); // 提交时间 ASC
    // 第一个已领取（IN_REVIEW 仍在默认队列），其余 SUBMITTED——队列词汇含两态
    expect(items[0]!.audit_status).toBe('IN_REVIEW');
    expect(items[1]!.audit_status).toBe('SUBMITTED');
    expect(items[2]!.audit_status).toBe('SUBMITTED');
    for (const item of items) {
      expect(typeof item.submitted_at).toBe('string');
      expect(typeof item.sla_due_at).toBe('string');
      expect(typeof item.sla_remaining_ms).toBe('number');
      expect(item.sla_remaining_ms).toBeGreaterThan(0); // 刚提交：3 工作日内未超时
      expect(item.sla_overdue).toBe(false);
    }

    // status 过滤：PASSED 空；分页 page=2&pageSize 缺省 20 → 空 items 但 total 不变
    const passed = await request(app.getHttpServer())
      .get('/admin/lawyers?status=PASSED')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(passed.body).toMatchObject({ total: 0, items: [] });
    const page2 = await request(app.getHttpServer())
      .get('/admin/lawyers?page=2')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(page2.body.items).toEqual([]);
    expect(page2.body.total).toBe(3);

    // 非法 status → 400
    const bad = await request(app.getHttpServer())
      .get('/admin/lawyers?status=NOPE')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(ErrorCode.InvalidArgument);
  });

  it('POST /admin/lawyers/{id}/audit（G-A R-W2-G 关闭）：401/403 三态；admin claim→approve→auditor_id 落值+ops.audit_logs 同事务留痕；重复 approve 409 STATE 透传；R-02 isAuditPassed 翻转', async () => {
    const profileId = await submitProfile(lawyerUserId);

    const anon = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .send({ action: 'claim' });
    expect(anon.status).toBe(401);
    const plain = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ action: 'claim' });
    expect(plain.status).toBe(403);
    expect(plain.body.code).toBe(ErrorCode.RoleForbidden);

    const claim = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'claim' });
    expect(claim.status).toBe(201);
    expect(claim.body).toEqual({ status: 'IN_REVIEW' });

    // 形态防呆（原 A3a 面用例随路由迁入）：404 未知档案；坏 action/坏 id → 400
    const missing = await request(app.getHttpServer())
      .post('/admin/lawyers/999999/audit')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'claim' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ErrorCode.NotFound);
    const badAction = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'destroy' });
    expect(badAction.status).toBe(400);
    expect(badAction.body.code).toBe(ErrorCode.InvalidArgument);
    const badId = await request(app.getHttpServer())
      .post('/admin/lawyers/abc/audit')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'claim' });
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe(ErrorCode.InvalidArgument);

    const approve = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });
    expect(approve.status).toBe(201);
    expect(approve.body).toEqual({ status: 'PASSED' });

    // R-W2-G 绑定断言：auditor_id=admin claims userId（终结恒 NULL；经 A3a 服务导出面读取）
    const view = await qualification.profileViewById(profileId);
    expect(view).toMatchObject({ audit_status: 'PASSED', auditor_id: adminUserId });

    // §8 全审计：ops.audit_logs 同事务留痕（owner 表直查），action=lawyer_audit.*，actor=admin
    const logs = await pool.query<{
      actor_user_id: string;
      action: string;
      target_type: string;
      target_id: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT actor_user_id::text, action, target_type, target_id::text, detail
         FROM ops.audit_logs WHERE target_type = 'lawyer_profile' ORDER BY id`,
    );
    expect(logs.rows.map((r) => `${r.action}:${r.actor_user_id}`)).toEqual([
      `lawyer_audit.claim:${adminUserId}`,
      `lawyer_audit.approve:${adminUserId}`,
    ]);
    expect(logs.rows[1]?.detail).toMatchObject({ result_status: 'PASSED' });

    // 幂等键=id+action 的冲突面：已 PASSED 再 approve → 409 STATE 透传（A3a 守卫语义）
    const replay = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe(ErrorCode.StateIllegalTransition);

    // R-02 集成断言：approve→isAuditPassed 翻转（C3 列表可见性闸口事实源）
    expect(await qualification.isAuditPassed(lawyerUserId)).toBe(true);
  });

  it('POST /admin/lawyers/{id}/suspend|resume（G-A）：403 未持 admin；suspend 缺 reason 400；admin 停用→恢复全链+audit_logs 可查+LawyerSuspended 出箱', async () => {
    const profileId = await submitProfile(lawyerUserId);
    await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'claim' });
    await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'approve' });

    const forbidden = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/suspend`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ reason: '投诉核查' });
    expect(forbidden.status).toBe(403);

    const noReason = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe(ErrorCode.InvalidArgument);

    const suspend = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: '投诉核查' });
    expect(suspend.status).toBe(201);
    expect(suspend.body).toEqual({ status: 'SUSPENDED' });
    expect(await qualification.isAuditPassed(lawyerUserId)).toBe(false); // SUSPENDED 翻 false

    const resume = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/resume`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resume.status).toBe(201);
    expect(resume.body).toEqual({ status: 'PASSED' });
    expect(await qualification.isAuditPassed(lawyerUserId)).toBe(true);

    // 审计可查（suspend/resume 均 audit_logs 落行）
    const actions = await pool.query<{ action: string }>(
      `SELECT action FROM ops.audit_logs WHERE target_type = 'lawyer_profile' AND target_id = $1 ORDER BY id`,
      [profileId],
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      'lawyer_audit.claim',
      'lawyer_audit.approve',
      'lawyer_audit.suspend',
      'lawyer_audit.resume',
    ]);

    // LawyerSuspended 事件已由 A3a 出箱（转调不出箱两次）
    const suspended = await pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1',
      [LAWYER_SUSPENDED_TOPIC],
    );
    expect(suspended.rows).toHaveLength(1);
    expect(suspended.rows[0]!.payload).toMatchObject({
      lawyer_user_id: lawyerUserId,
      reason: '投诉核查',
    });
  });

  it('POST /admin/lawyers/{id}/audit reject（R-03 转调）：必填 reason 400；带 reason 拒绝→audit_logs 留痕→律师重提回 SUBMITTED（A3a 既有经 H1 面可达）', async () => {
    const profileId = await submitProfile(lawyerUserId);

    const noReason = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'reject' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe(ErrorCode.InvalidArgument);

    // 状态机前置：reject 须先领取（SUBMITTED→IN_REVIEW→REJECTED）；越级拒 → 409 透传
    const skip = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'reject', reject_reason: '越级拒绝' });
    expect(skip.status).toBe(409);
    expect(skip.body.code).toBe(ErrorCode.StateIllegalTransition);

    await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'claim' });

    const reject = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'reject', reject_reason: '执业证照片模糊' });
    expect(reject.status).toBe(201);
    expect(reject.body).toEqual({ status: 'REJECTED' });

    // R-03：驳回可重提（新材料版本）——A3a 既有行为，H1 转调不破坏
    await qualification.submitQualification(lawyerUserId, {
      licenseNo: LICENSE,
      firmName: '北京H1测试律师事务所',
      files: [{ kind: 'LICENSE_PHOTO', ref: 'spec/oss/h1-license-v2.jpg' }],
    });
    const queue = await qualification.listSubmissions({});
    expect(queue.items[0]).toMatchObject({
      lawyer_user_id: lawyerUserId,
      audit_status: 'SUBMITTED',
    });
    const detail = await pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM ops.audit_logs WHERE target_id = $1 AND action = 'lawyer_audit.reject'`,
      [profileId],
    );
    expect(detail.rows[0]?.detail).toMatchObject({
      result_status: 'REJECTED',
      reject_reason: '执业证照片模糊',
    });
  });

  it('GET /admin/lawyers/{id}/profile：403 未持 admin；404 未知档案；admin 聚合 A3a+A3b+G1+C1（全经服务面；场次统计窗口缺省=近 30 天 ⚠§11）', async () => {
    const anon = await request(app.getHttpServer()).get('/admin/lawyers/1/profile');
    expect(anon.status).toBe(401);
    const forbidden = await request(app.getHttpServer())
      .get('/admin/lawyers/1/profile')
      .set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);

    const missing = await request(app.getHttpServer())
      .get('/admin/lawyers/999999/profile')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ErrorCode.NotFound);

    const profileId = await submitProfile(lawyerUserId);
    const ok = await request(app.getHttpServer())
      .get(`/admin/lawyers/${profileId}/profile`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.qualification).toMatchObject({
      id: profileId,
      lawyer_user_id: lawyerUserId,
      audit_status: 'SUBMITTED',
      firm_name: '北京H1测试律师事务所',
    });
    expect(JSON.stringify(ok.body)).not.toContain(LICENSE); // PII 红线：聚合出参无明文证号
    expect(ok.body.merchants).toEqual([]); // A3b 未进件（firm_id=null）=空数组不抛
    expect(ok.body.credit).toMatchObject({ score: 100 }); // G1 快照（初始 100 回显口径）
    expect(ok.body.session_stats).toMatchObject({
      enroll_rate: null,
      group_rate: null,
      attendance_rate: null,
      ooo_rate: null,
    }); // C1 四率（无场次=桩口径一致）
    expect(typeof ok.body.session_stats_window.from).toBe('string');
    expect(typeof ok.body.session_stats_window.to).toBe('string');
  });
});
