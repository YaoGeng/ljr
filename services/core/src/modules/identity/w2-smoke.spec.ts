import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CREDIT_EVENT_EMITTED_TOPIC,
  ErrorCode,
  LAWYER_AUDIT_PASSED_TOPIC,
  RESTRICTION_ISSUED_TOPIC,
  USER_REGISTERED_TOPIC,
} from '@ljr/shared';
import type { Pool } from 'pg';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { CreditModule } from '../credit/credit.module';
import { CREDIT_RULES_KEY } from '../credit/credit.types';
import {
  type NotifyChannelAdapter,
  type NotifyChannelMessage,
  NOTIFY_CHANNEL_ADAPTERS,
} from '../notify/notify.channels';
import { RuleCenterService } from '../ops/rule-center.service';
import { SLOT_ABUSE_DETECTED_TOPIC, SLOT_LOCKED_TOPIC } from '../schedule/slot-lock.events';
import { SlotLockModule } from '../schedule/slot-lock.module';
import { SlotLockService } from '../schedule/slot-lock.service';
import { TimeTableModule } from '../schedule/time-table.module';
import { TimeTableService } from '../schedule/time-table.service';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { IdentityCryptoService } from './identity.crypto';
import { IdentityModule } from './identity.module';
import { LawyerQualificationModule } from './lawyer-qualification.module';

/**
 * M1-W2 事件链集成烟测（W2 DoD 收口，W1 w1-smoke 同款形态）：一条真实链贯通六模块三既有机制——
 *   A1 注册登录（I1 VerifyCodeRateLimiter 真计数 → mock SMS 捕获 → verify_codes 哈希落库直查比对
 *   → 双 token）→ A3a 资质提交 → admin 领取→通过（LawyerAuditPassed 同事务出箱）→ 真 relay tick
 *   → A1 消费端授 lawyer role（user_roles 双行）→ /auth/switch-role 重签 claims.role=lawyer；
 *   旧 user token 打律师面端点（PUT /lawyer/schedule）403 E_ROLE_FORBIDDEN（R-03 一次）→
 *   B1 PUT 模板 → materializeSlots 候选 FREE → B2 lockSlot 真加锁（C1 创建即锁 LOCKED）→
 *   候选经 B1 实时 join 转 LOCKED（slot_locks 活跃行证明）→ R-03 滥用：同用户对同律师第二次加锁
 *   → SLOT_ABUSE_LIMIT + SlotAbuseDetected（B2 recordAbuse 独立连接真生产路径）→ 真 relay tick
 *   → G1 消费端入账（H7 种子规则 -5 + 行为内嵌限制令发行）→ /credit/restrictions 查到 BAN_JOIN
 *   → 幂等附验：链上 LawyerAuditPassed + SlotAbuseDetected 重驱动一次 → user_roles 双行/信用
 *   流水/限制令均不重复迁移（relay 幂等键口径，W1 同款断言风格）。
 * 验收口径：单链贯通 + 幂等，不铺组合场景（分支细节归各模块自身 spec）。
 *
 * 放置位置与断言面说明（check-schema-refs owner 纪律，w1-smoke 先例的逆向取舍）：本 spec 是
 * 跨模块缝合（identity+schedule+credit），直查断言面重心在 identity——简报强制直查
 * identity.verify_codes 取码与 identity.user_roles 双行断言、且 admin 审核面 {id}=lawyer_profiles.id
 * 无查询服务面，按「落被查表的 owner 侧」落 identity 目录：直接 DB 断言仅限 owner 表 identity.*
 * 与 platform.* 白名单；schedule 侧断言全走 B1 服务面（materializeSlots 实时 join slot_locks，
 * 候选 LOCKED 即活跃行证明）+ B2 机制 API 出参；credit 侧全走 REST 面；notify 侧限频计数走
 * 429 行为断言。不设 modules/integration 目录（owner=integration 引用任何业务表都触发规则 A）。
 *
 * 账号取舍（简报「第二账号或同号切换均可」）：用第二账号（律师/用户各一）——链上 B2 加锁发起人
 * 与被锁律师分属两账号（用户预订律师时段的业务真实形态），R-03 滥用限制令落在用户侧亦即业务语义。
 *
 * 验证码取得方式说明（简报「从 identity.verify_codes 取码」的落地口径）：verify_codes 只存
 * 哈希（PII 红线，明文不可逆）——测试明文取自 mock SMS 通道捕获（identity-api.spec 同款，
 * 供应商位=M2+），verify_codes 直查行与捕获码经 IdentityCryptoService.codeMatches 复算比对，
 * 证「码确经 DB 事实源落库且未消费」；无 SMS 真到达面由捕获适配器承担。
 *
 * G1 种子取舍（简报步骤 5 说明位）：SlotAbuseDetected 走真 B2 滥用路径（单次抢占即触发
 * PER_LAWYER，无需多次），事件→入账→限制令的「限制令」由 H7 种子内容承载——烟测种子在
 * user_slot_abuse 行内嵌 BAN_JOIN（PRD §8.8 该行为无内嵌限制令；行为内嵌限制令机制的 PRD
 * 真值覆盖见 credit.spec lawyer_price_down_gt10 例）。分值/限制映射生产值=H7 运营配置（R-W2-10），
 * 测试种子经 createLexiconVersion 免公示通道直建 EFFECTIVE（credit.spec 同款，不跨 schema 直写）。
 *
 * noop 承接（w1-smoke 同款纪律，保持 relay 全绿；各带落位 TODO）：
 *   - USER_REGISTERED（A1 生产，消费方=H8 引导/H4 通知位未落位）
 *   - CREDIT_EVENT_EMITTED / RESTRICTION_ISSUED（G1 生产，消费方=C1/C3 入口联动与 H4 未落位）
 */

/** 烟测常量：双账号手机号（虚构，TRUNCATE 清场隔离）；2026-11-02=周一，10:00/11:00 上海 */
const USER_PHONE = '13900004001';
const LAWYER_PHONE = '13900004002';
const MONDAY = '2026-11-02';
const MON_10 = '2026-11-02T02:00:00.000Z';
const MON_11 = '2026-11-02T03:00:00.000Z';
/** B2 锁的 ref 半边（session 业务实体虚构 id；C1 创建即锁语义） */
const SMOKE_SESSION_REF = 7401;
const LICENSE_NO = '110101199001011234';

/** H7 种子（烟测夹具值；取舍见头注「G1 种子取舍」） */
const SMOKE_CREDIT_RULES: Record<string, unknown> = {
  violation: {
    window_days: 30,
    threshold: 2,
    restriction_by_owner: {
      user: { kind: 'BAN_JOIN', days: 7 },
      lawyer: { kind: 'SUSPEND_TAKE_7D', days: 7 },
    },
  },
  actions: {
    user_slot_abuse: { delta: -5, restriction: { kind: 'BAN_JOIN', days: 7 } },
  },
};

/** 捕获式 SMS 适配器：测试经 mock 通道取回验证码明文（供应商位=M2+，identity-api.spec 同款） */
class CapturingSmsAdapter implements NotifyChannelAdapter {
  readonly channel = 'SMS' as const;
  readonly messages: NotifyChannelMessage[] = [];

  async send(message: NotifyChannelMessage): Promise<void> {
    this.messages.push(message);
  }

  lastCode(): string {
    const last = this.messages[this.messages.length - 1];
    const code = last?.params['code'];
    if (typeof code !== 'string') throw new Error('捕获适配器未取得验证码');
    return code;
  }
}

/** 测试密钥：randomBytes 派生——密钥零字面量出测试（R-W2-11，全 W2 spec 同款） */
const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('M1-W2 单链烟测（A1→A3a→授角色→切换→B1/B2→G1 限制令→幂等，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let capture: CapturingSmsAdapter;
  let relay: OutboxRelayService;
  let poolSvc: PgPoolService;
  let crypto: IdentityCryptoService;
  let timeTable: TimeTableService;
  let slotLocks: SlotLockService;
  let rules: RuleCenterService;

  /** 由 access_token 解 claims（测试侧校验签发内容，identity-api.spec 同款） */
  function claimsOf(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  }

  /** A1 全链注册（律师账号用；段 1 用户账号走内联流程以便在 SMS 与 verify 之间做直查断言） */
  async function registerBySms(
    phone: string,
  ): Promise<{ userId: number; token: string; refreshToken: string; roles: string[] }> {
    const sms = await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    expect(sms.status).toBe(201);
    expect(sms.body).toEqual({ ttl: 60 });
    const verify = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: capture.lastCode(), age_declared: true });
    expect(verify.status).toBe(201);
    expect(verify.body.roles).toEqual(['user']); // R-02：新号默认 user 身份
    expect(verify.body.access_token.split('.')).toHaveLength(3);
    expect(typeof verify.body.refresh_token).toBe('string');
    return {
      userId: Number(claimsOf(verify.body.access_token)['sub']),
      token: verify.body.access_token as string,
      refreshToken: verify.body.refresh_token as string,
      roles: verify.body.roles as string[],
    };
  }

  /** 平台.outbox 单事件行（event_id/载荷/状态；platform 白名单直查） */
  const outboxRowOf = async (topic: string) => {
    const res = await pool.query<{
      id: string;
      event_id: string;
      payload: Record<string, unknown>;
      status: string;
    }>(
      `SELECT id::text AS id, event_id::text AS event_id, payload, status
         FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows;
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    capture = new CapturingSmsAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        IdentityModule,
        LawyerQualificationModule,
        TimeTableModule,
        SlotLockModule,
        CreditModule,
      ],
    })
      .overrideProvider(NOTIFY_CHANNEL_ADAPTERS)
      .useValue([capture])
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // 触发 onModuleInit：A1/G1/B1 消费端与 noop 承接注册到 relay（topic 两两不冲突）
    relay = app.get(OutboxRelayService);
    poolSvc = app.get(PgPoolService);
    crypto = app.get(IdentityCryptoService);
    timeTable = app.get(TimeTableService);
    slotLocks = app.get(SlotLockService);
    rules = app.get(RuleCenterService);
    // noop 承接（头注「noop 承接」；w1-smoke 同款——真实消费方落位时移除对应行）
    // TODO(H8/H4): 消费方落位注册 USER_REGISTERED 消费者时，移除本 noop 承接
    relay.registerHandler(USER_REGISTERED_TOPIC, async () => undefined);
    // TODO(C1/C3/H4): 消费方落位注册 CREDIT_EVENT_EMITTED 消费者时，移除本 noop 承接
    relay.registerHandler(CREDIT_EVENT_EMITTED_TOPIC, async () => undefined);
    // TODO(H4): 通知位落位注册 RESTRICTION_ISSUED 消费者时，移除本 noop 承接
    relay.registerHandler(RESTRICTION_ISSUED_TOPIC, async () => undefined);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    capture.messages.length = 0;
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('单链贯通+幂等：注册登录 → 资质审核授 lawyer → 切换角色 → 时间表加锁 → 滥用限制令 → 重驱动恰一次生效', async () => {
    // ---------- 段 1：A1 注册登录（用户账号；I1 真限频 + verify_codes 哈希落库直查） ----------
    const sms1 = await request(app.getHttpServer()).post('/auth/sms').send({ phone: USER_PHONE });
    expect(sms1.status).toBe(201);
    expect(sms1.body).toEqual({ ttl: 60 });

    // 断言① R-01 真计数：同号 60s 内第二条 → 429 E_RATE_LIMITED（I1 VerifyCodeRateLimiter 真计数，
    // 计数台账=I1 验证码发送台账；被拒不烧配额不落行——台账在 notify 域，owner 纪律下走行为断言）
    const limited = await request(app.getHttpServer())
      .post('/auth/sms')
      .send({ phone: USER_PHONE });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe(ErrorCode.RateLimited);

    // 断言② verify_codes 直查：码行在库、未消费，捕获码复算哈希命中（码经 DB 事实源落库，见头注）
    const userBlind = crypto.blindIndex(USER_PHONE);
    const codeRow = await pool.query<{ id: string; code_hash: string; consumed_at: Date | null }>(
      `SELECT id, code_hash, consumed_at FROM identity.verify_codes
        WHERE phone_blind_idx = $1 ORDER BY id DESC LIMIT 1`,
      [userBlind],
    );
    expect(codeRow.rows).toHaveLength(1);
    expect(codeRow.rows[0]?.consumed_at).toBeNull();
    expect(crypto.codeMatches(capture.lastCode(), userBlind, codeRow.rows[0]!.code_hash)).toBe(
      true,
    );

    // POST /auth/verify（R-04 年龄声明）→ 双 token + roles=['user']（§5 契约），claims.role 默认 user
    const userVerify = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone: USER_PHONE, code: capture.lastCode(), age_declared: true });
    expect(userVerify.status).toBe(201);
    expect(userVerify.body.roles).toEqual(['user']);
    expect(userVerify.body.access_token.split('.')).toHaveLength(3);
    expect(typeof userVerify.body.refresh_token).toBe('string');
    const user = {
      userId: Number(claimsOf(userVerify.body.access_token)['sub']),
      token: userVerify.body.access_token as string,
    };
    expect(user.userId).toBeGreaterThan(0);
    expect(claimsOf(user.token)).toMatchObject({ sub: String(user.userId), role: 'user' });

    // 一次性消费：码行已烧（R-03 同码不可双用的事实事源）
    const burned = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM identity.verify_codes WHERE id = $1',
      [codeRow.rows[0]!.id],
    );
    expect(burned.rows[0]?.consumed_at).not.toBeNull();

    // ---------- 段 2：A3a 资质审核闭环（律师=第二账号，见头注账号取舍） ----------
    const lawyer = await registerBySms(LAWYER_PHONE);
    expect(lawyer.userId).not.toBe(user.userId);

    const submit = await request(app.getHttpServer())
      .post('/lawyer/qualification')
      .set('Authorization', `Bearer ${lawyer.token}`)
      .send({
        license_no: LICENSE_NO,
        firm_name: '北京烟测律师事务所',
        files: [{ kind: '执业证照片', ref: 'smoke/license-v1.jpg' }],
      });
    expect(submit.status).toBe(201);
    expect(submit.body).toEqual({ status: 'SUBMITTED' });

    // {id}=lawyer_profiles.id（H1 契约）：无查询服务面，owner 侧直查（放置纪律见文件头注）
    const profile = await pool.query<{ id: string; audit_status: string }>(
      'SELECT id, audit_status FROM identity.lawyer_profiles WHERE user_id = $1',
      [lawyer.userId],
    );
    expect(profile.rows[0]).toMatchObject({ audit_status: 'SUBMITTED' });
    const profileId = Number(profile.rows[0]!.id);

    const claim = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .send({ action: 'claim' });
    expect(claim.status).toBe(201);
    expect(claim.body).toEqual({ status: 'IN_REVIEW' });

    const approve = await request(app.getHttpServer())
      .post(`/admin/lawyers/${profileId}/audit`)
      .send({ action: 'approve' });
    expect(approve.status).toBe(201);
    expect(approve.body).toEqual({ status: 'PASSED' });

    // 断言④ LawyerAuditPassed 同事务出箱（A3b 进件前 firm_id=null，简报裁决）
    const passedRows = await outboxRowOf(LAWYER_AUDIT_PASSED_TOPIC);
    expect(passedRows).toHaveLength(1);
    expect(passedRows[0]?.status).toBe('PENDING');
    expect(passedRows[0]?.payload).toMatchObject({ lawyer_user_id: lawyer.userId, firm_id: null });

    // ---------- 段 3：relay 真投递 → A1 消费端授 lawyer role → 角色切换 + R-03 ----------
    // tick#1：USER_REGISTERED×2（noop 承接）+ LawyerAuditPassed（真消费）各恰一次
    const tick1 = await relay.tick();
    expect(tick1).toMatchObject({ dispatched: 3, retried: 0, dead: 0 });

    // 断言⑤ user_roles 双行（R-02：lawyer 账号 user 身份并存；事件消费幂等授予）
    const roles = await pool.query<{ role: string }>(
      'SELECT role FROM identity.user_roles WHERE user_id = $1 ORDER BY role',
      [lawyer.userId],
    );
    expect(roles.rows.map((r) => r.role)).toEqual(['lawyer', 'user']);

    const switched = await request(app.getHttpServer())
      .post('/auth/switch-role')
      .set('Authorization', `Bearer ${lawyer.token}`)
      .send({ target_role: 'lawyer' });
    expect(switched.status).toBe(201);
    const lawyerClaims = claimsOf(switched.body.access_token);
    expect(lawyerClaims['role']).toBe('lawyer'); // 新 access claims.role=lawyer
    expect(lawyerClaims['roles']).toEqual(expect.arrayContaining(['user', 'lawyer']));
    expect(lawyerClaims['sub']).toBe(String(lawyer.userId)); // 切换不产生新账号
    const lawyerToken = switched.body.access_token as string;

    // 断言⑥ R-03：旧 user token 打律师面端点（PUT /lawyer/schedule 要求 lawyer 角色）→ 403
    const forbidden = await request(app.getHttpServer())
      .put('/lawyer/schedule')
      .set('Authorization', `Bearer ${lawyer.token}`)
      .send({ version: 0, templates: [] });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe(ErrorCode.RoleForbidden);

    // 断言⑦ 状态禁裸写：审核迁移经守卫全留痕（entityId=user_id，lawyer.machine 口径）
    const stl = await pool.query<{ from_status: string | null; to_status: string }>(
      `SELECT from_status, to_status FROM platform.state_transition_log
        WHERE entity_type = 'identity_lawyer_profile' AND entity_id = $1 ORDER BY id`,
      [lawyer.userId],
    );
    expect(stl.rows.map((r) => `${r.from_status}→${r.to_status}`)).toEqual([
      'DRAFT→SUBMITTED',
      'SUBMITTED→IN_REVIEW',
      'IN_REVIEW→PASSED',
    ]);

    // ---------- 段 4：B1 模板 → materializeSlots 候选 → B2 真加锁（C1 创建即锁） ----------
    const put = await request(app.getHttpServer())
      .put('/lawyer/schedule')
      .set('Authorization', `Bearer ${lawyerToken}`)
      .send({ version: 0, templates: [{ weekday: 1, start_time: '10:00', duration_small: 60 }] });
    expect(put.status).toBe(200); // @Put 缺省 200（时间表 REST 面）
    expect(put.body).toMatchObject({
      version: 1,
      templates: [{ weekday: 1, start_time: '10:00:00', duration_small: 60, enabled: true }],
    });
    const templateId = put.body.templates[0]['id'] as number;

    // 断言⑧ B1 物化候选：周一 10:00 上海=02:00Z，未锁=FREE（Asia/Shanghai 语义，B1 §4）
    const before = await timeTable.materializeSlots(lawyer.userId, MONDAY);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ templateId, durationSmall: 60, status: 'FREE', ref: null });
    expect(before[0]!.slotStart.toISOString()).toBe(MON_10);

    // B2 lockSlot 真加锁（§5 机制 API 服务面，uow 形态；发起人=用户账号，见头注账号取舍）
    const lock = await poolSvc.withTransaction((uow) =>
      slotLocks.lockSlot(uow, {
        lawyerId: lawyer.userId,
        slotStart: before[0]!.slotStart,
        initiatorUserId: user.userId,
        refType: 'session',
        refId: SMOKE_SESSION_REF,
      }),
    );
    expect(lock).toMatchObject({ ok: true, status: 'LOCKED' });
    const lockId = lock.ok ? lock.lockId : 0;
    expect(lockId).toBeGreaterThan(0);

    // 断言⑨ slot_locks 活跃行证明：B1 视图实时 join——候选转 LOCKED 且 ref 指回业务实体（R-W2-8 口径）
    const after = await timeTable.materializeSlots(lawyer.userId, MONDAY);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      status: 'LOCKED',
      ref: { refType: 'session', refId: SMOKE_SESSION_REF },
    });

    // SlotLocked 与锁写入同事务出箱（B2 §6）
    const lockedRows = await outboxRowOf(SLOT_LOCKED_TOPIC);
    expect(lockedRows).toHaveLength(1);
    expect(lockedRows[0]?.payload).toMatchObject({
      lock_id: lockId,
      lawyer_id: lawyer.userId,
      slot_start: MON_10,
      ref: { ref_type: 'session', ref_id: SMOKE_SESSION_REF },
      status: 'LOCKED',
    });

    // ---------- 段 5：R-03 滥用 → SlotAbuseDetected（真 B2 路径）→ G1 入账发限制令 ----------
    // 断言⑩ R-03 滥用拒绝：同用户对同律师进行中锁 ≤1 → SLOT_ABUSE_LIMIT（锁行未写入）
    const abuse = await poolSvc.withTransaction((uow) =>
      slotLocks.lockSlot(uow, {
        lawyerId: lawyer.userId,
        slotStart: new Date(MON_11),
        initiatorUserId: user.userId,
        refType: 'session',
        refId: SMOKE_SESSION_REF + 1,
      }),
    );
    expect(abuse).toEqual({ ok: false, reason: 'SLOT_ABUSE_LIMIT' });

    // SlotAbuseDetected 经独立连接落 outbox（B2 recordAbuse 真生产路径，拒绝路径事件不随回滚丢失）
    const abuseRows = await outboxRowOf(SLOT_ABUSE_DETECTED_TOPIC);
    expect(abuseRows).toHaveLength(1);
    expect(abuseRows[0]?.status).toBe('PENDING');
    expect(abuseRows[0]?.payload).toMatchObject({
      user_id: user.userId,
      lawyer_id: lawyer.userId,
      limit: 'PER_LAWYER',
    });
    const abuseRowId = Number(abuseRows[0]!.id);

    // H7 种子（烟测夹具，取舍见头注）：经 createLexiconVersion 免公示通道直建 EFFECTIVE
    await poolSvc.withTransaction((uow) =>
      rules.createLexiconVersion(uow, {
        ruleKey: CREDIT_RULES_KEY,
        version: 1,
        content: SMOKE_CREDIT_RULES,
        effectiveAt: new Date(Date.now() - 10 * 86_400_000),
      }),
    );

    // tick#2：SlotLocked（B1 缓存失效消费）+ SlotAbuseDetected（G1 入账+限制令同事务出箱）；
    // relay 游标口径（id>cursor 逐条拾取）会把 G1 消费中新出箱的 CEE/RI（noop 承接）同轮级联拾取
    // ——4=SlotLocked+SlotAbuseDetected+CreditEventEmitted+RestrictionIssued，链内级联一次清空
    const tick2 = await relay.tick();
    expect(tick2).toMatchObject({ dispatched: 4, retried: 0, dead: 0 });

    // 断言⑪ G1 限制令查询面：/credit/restrictions 查到该用户 BAN_JOIN（行为内嵌发行，reason=行为锚）
    const restrictions = await request(app.getHttpServer())
      .get('/credit/restrictions')
      .query({ owner_type: 'user', owner_id: String(user.userId) });
    expect(restrictions.status).toBe(200);
    expect(restrictions.body).toHaveLength(1);
    expect(restrictions.body[0]).toMatchObject({
      kind: 'BAN_JOIN',
      reason: 'action:user_slot_abuse',
    });
    expect(new Date(restrictions.body[0]['until'] as string).getTime()).toBeGreaterThan(Date.now());

    // 断言⑫ /credit/mine：分数 100-5=95 + 流水 ref 绑定回投递行 id（消费端 ref=(outbox_event, 行id)）
    const mine = await request(app.getHttpServer())
      .get('/credit/mine')
      .set('Authorization', `Bearer ${user.token}`);
    expect(mine.status).toBe(200);
    expect(mine.body.score).toBe(95);
    expect(mine.body.recent_events).toHaveLength(1);
    expect(mine.body.recent_events[0]).toMatchObject({
      action: 'user_slot_abuse',
      delta: -5,
      rule_version: 1,
      ref_type: 'outbox_event',
      ref_id: abuseRowId,
    });
    expect(mine.body.restrictions).toHaveLength(1);

    // 入账/限制令两事件同事务出箱（G1 §6）
    const emittedRows = await outboxRowOf(CREDIT_EVENT_EMITTED_TOPIC);
    expect(emittedRows).toHaveLength(1);
    expect(emittedRows[0]?.payload).toMatchObject({
      owner_type: 'user',
      owner_id: user.userId,
      action: 'user_slot_abuse',
      delta: -5,
      score_after: 95,
    });
    const issuedRows = await outboxRowOf(RESTRICTION_ISSUED_TOPIC);
    expect(issuedRows).toHaveLength(1);
    expect(issuedRows[0]?.payload).toMatchObject({
      owner_type: 'user',
      owner_id: user.userId,
      kind: 'BAN_JOIN',
    });

    // ---------- 段 6：幂等附验——链上两真事件重驱动一次（relay 幂等键口径，W1 同款） ----------
    // 模拟 at-least-once 重投递（效果已生效、SENT 标记丢失的崩溃窗口）
    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL
        WHERE topic IN ($1, $2)`,
      [LAWYER_AUDIT_PASSED_TOPIC, SLOT_ABUSE_DETECTED_TOPIC],
    );
    const tick3 = await relay.tick();
    expect(tick3).toMatchObject({ dispatched: 2, retried: 0, dead: 0 }); // 确实重投了两次

    // 断言⑬ 重驱动恰一次生效：user_roles 仍双行（PK 幂等）/信用流水·分数·限制令均不重复
    const rolesReplay = await pool.query<{ role: string }>(
      'SELECT role FROM identity.user_roles WHERE user_id = $1 ORDER BY role',
      [lawyer.userId],
    );
    expect(rolesReplay.rows.map((r) => r.role)).toEqual(['lawyer', 'user']);

    const mineReplay = await request(app.getHttpServer())
      .get('/credit/mine')
      .set('Authorization', `Bearer ${user.token}`);
    expect(mineReplay.status).toBe(200);
    expect(mineReplay.body.score).toBe(95); // 幂等重放：分数不变
    expect(mineReplay.body.recent_events).toHaveLength(1); // uq_credit_events_idem 挡下二次入账
    expect(mineReplay.body.restrictions).toHaveLength(1); // 同 kind 未到期幂等跳过

    const restrictionsReplay = await request(app.getHttpServer())
      .get('/credit/restrictions')
      .query({ owner_type: 'user', owner_id: String(user.userId) });
    expect(restrictionsReplay.body).toHaveLength(1);

    // 全链收口：无死信；7 事件（USER_REGISTERED×2/LAP/SLOT_LOCKED/SAD/CEE/RI）全部 SENT
    const dead = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM platform.outbox_dead_letter',
    );
    expect(dead.rows[0]?.n).toBe(0);
    const outbox = await pool.query<{ status: string }>('SELECT status FROM platform.outbox');
    expect(outbox.rows).toHaveLength(7);
    expect(outbox.rows.every((r) => r.status === 'SENT')).toBe(true);
  });
});
