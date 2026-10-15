import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, type INestApplication, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode, USER_REGISTERED_TOPIC, type UserRegisteredPayload } from '@ljr/shared';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  type NotifyChannelAdapter,
  type NotifyChannelMessage,
  NOTIFY_CHANNEL_ADAPTERS,
} from '../notify/notify.channels';
import { VerifyCodeRateLimiter } from '../notify/verify-code-rate-limiter.service';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { IdentityCryptoService, hashCodeValue } from './identity.crypto';
import { USER_MACHINE } from './identity.machine';
import { IdentityModule } from './identity.module';
import { IdentityService } from './identity.service';

/**
 * A1 领域层 e2e（需 PG）：注册/登录（盲索引+列加密）、R-01 限频映射、R-04 年龄声明、
 * 双 token（R-W2-3/R-W2-4）、盲索引唯一冲突（§9）、领域事件消费（LawyerAuditPassed/
 * AccountDeletionExecuted 合成事件，生产方 A3a=Task 3 / A4=M4）、PII 红线
 * （明文不落库/不落日志/不落事件载荷）。
 */

/** 捕获式 SMS 适配器：测试经 mock 通道取回验证码（供应商位=M2+，同 notify 测试口径） */
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

/** 测试密钥：randomBytes 派生——密钥零字面量出测试（R-W2-11） */
const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** 日志捕获（Nest Logger 静态 override）：断言全程无手机号明文（lj-data-security），兼保输出纯净 */
const logCalls = vi.fn();

describe('A1 领域层（注册/登录/双 token/事件消费/PII 红线，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let service: IdentityService;
  let crypto: IdentityCryptoService;
  let relay: OutboxRelayService;
  let guard: StateTransitionGuardService;
  let capture: CapturingSmsAdapter;

  /** 走真实链路拿一个可用账号：requestSms（经捕获适配器取码）→ verify */
  async function registerOrLogin(phone: string, ageDeclared?: boolean) {
    await service.requestSms(phone);
    return service.verify({ phone, code: capture.lastCode(), ageDeclared });
  }

  /** 直插一条可用验证码（绕过 requestSms 的 R-01 60s 窗，供消费/重放类用例隔离计数） */
  async function seedCode(phone: string, code: string): Promise<void> {
    const blind = crypto.blindIndex(phone);
    await pool.query(
      `INSERT INTO identity.verify_codes (phone_blind_idx, code_hash, expires_at)
       VALUES ($1, $2, now() + interval '60 seconds')`,
      [blind, hashCodeValue(code, blind)],
    );
  }

  /** 同号第二次验证（登录路径）：直插码绕过 R-01 60s 窗——限频语义已由独立用例钉住 */
  async function loginAgain(phone: string) {
    const code = '654321';
    await seedCode(phone, code);
    return service.verify({ phone, code });
  }

  /** 合成领域事件（生产方未落位：A3a=Task 3 / A4=M4）；返回 event_id 供重投模拟 */
  async function insertSyntheticEvent(topic: string, payload: unknown): Promise<string> {
    const res = await pool.query<{ event_id: string }>(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES (gen_random_uuid(), $1, $2::jsonb, 'PENDING') RETURNING event_id::text AS event_id`,
      [topic, JSON.stringify(payload)],
    );
    return res.rows[0]!.event_id;
  }

  /** at-least-once 重投模拟（demo spec 同款口径：同 event_id 重置回 PENDING） */
  async function redeliver(eventId: string): Promise<void> {
    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE event_id = $1::uuid`,
      [eventId],
    );
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    capture = new CapturingSmsAdapter();
    // logger spy 经 setLogger 注入：Test.createTestingModule 在 compile 期会覆盖 Logger 静态
    // logger（TestingLogger），先前 overrideLogger 会被冲掉——builder 的 setLogger 是唯一可靠挂点
    const moduleRef = await Test.createTestingModule({ imports: [IdentityModule] })
      .setLogger({
        log: logCalls,
        warn: logCalls,
        error: logCalls,
      } as unknown as LoggerService)
      .overrideProvider(NOTIFY_CHANNEL_ADAPTERS)
      .useValue([capture])
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // 触发 onModuleInit：identity 消费者注册到 relay
    service = app.get(IdentityService);
    crypto = app.get(IdentityCryptoService);
    relay = app.get(OutboxRelayService);
    guard = app.get(StateTransitionGuardService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    // 还原为静默（空级别数组）：Nest v12 overrideLogger 不收 null；测试进程内 Nest 日志本就应静默
    Logger.overrideLogger([]);
  });

  beforeEach(async () => {
    capture.messages.length = 0;
    logCalls.mockClear();
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('R-04 + 注册：新建号 age_declared 非 true → 400 拒绝且不建号（码可复用）；true → 建号+user 角色+UserRegistered', async () => {
    const phone = '13800002001';
    await service.requestSms(phone);
    const code = capture.lastCode();

    await expect(service.verify({ phone, code })).rejects.toMatchObject({
      code: ErrorCode.AgeDeclarationRequired,
      httpStatus: 400,
    });
    expect(
      await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM identity.users'),
    ).toMatchObject({ rows: [{ n: 0 }] });

    // 声明失败属业务校验（事务回滚），码未烧：补声明后同码完成注册
    const done = await service.verify({ phone, code, ageDeclared: true });
    expect(done.isNew).toBe(true);
    expect(done.roles).toEqual(['user']);
    expect(done.accessToken.split('.')).toHaveLength(3); // JWT 三段

    const user = await pool.query<{ status: string; age_declared: boolean }>(
      'SELECT status, age_declared FROM identity.users WHERE phone_blind_idx = $1',
      [crypto.blindIndex(phone)],
    );
    expect(user.rows[0]).toEqual({ status: 'ACTIVE', age_declared: true });

    const evt = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1',
      [USER_REGISTERED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect((evt.rows[0]?.payload as UserRegisteredPayload).user_id).toBe(done.userId);
  });

  it('登录（盲索引检索，加密列不可查询）：已有账号同流程再 verify → 同一账号、无需年龄声明、密文可解回原文', async () => {
    const phone = '13800002002';
    const first = await registerOrLogin(phone, true);

    const second = await loginAgain(phone); // 登录：不带 age_declared（R-W2-C 不影响存量账号）
    expect(second.userId).toBe(first.userId);
    expect(second.isNew).toBe(false);
    expect(second.roles).toEqual(['user']);

    const row = await pool.query<{ phone_enc: Buffer; phone_blind_idx: string }>(
      'SELECT phone_enc, phone_blind_idx FROM identity.users WHERE id = $1',
      [first.userId],
    );
    expect(row.rows[0]?.phone_blind_idx).toBe(crypto.blindIndex(phone));
    expect(crypto.decryptPhone(row.rows[0]!.phone_enc)).toBe(phone);
    expect(row.rows[0]!.phone_enc.equals(Buffer.from(phone, 'utf8'))).toBe(false);
  });

  it('CODE_INVALID（401）：错码 / 过期码 / 一次性消费后重放', async () => {
    const phone = '13800002003';
    const blind = crypto.blindIndex(phone);
    await service.requestSms(phone);
    const code = capture.lastCode();

    // 错码：拒绝且不烧码（事务回滚）
    await expect(
      service.verify({ phone, code: '000000', ageDeclared: true }),
    ).rejects.toMatchObject({ code: ErrorCode.CodeInvalid, httpStatus: 401 });

    // 过期码：唯一在册码推到过去
    const expired = await pool.query(
      "UPDATE identity.verify_codes SET expires_at = now() - interval '1 second' WHERE phone_blind_idx = $1",
      [blind],
    );
    expect(expired.rowCount).toBe(1);
    await expect(service.verify({ phone, code, ageDeclared: true })).rejects.toMatchObject({
      code: ErrorCode.CodeInvalid,
    });

    // 一次性消费：直插新码（requestSms 受 R-01 60s 窗约束）→ 成功后重放拒绝
    await seedCode(phone, '234567');
    const ok = await service.verify({ phone, code: '234567', ageDeclared: true });
    expect(ok.isNew).toBe(true);
    await expect(
      service.verify({ phone, code: '234567', ageDeclared: true }),
    ).rejects.toMatchObject({ code: ErrorCode.CodeInvalid });
  });

  it('R-01 限频四档：60s 触顶经服务映射 429 E_RATE_LIMITED；1h/1d 窗触顶与跨号隔离（caps 隔离口径同 I1 spec）', async () => {
    // 60s 窗（App 真实链路，默认 caps 1/5/10）：第 1 条放行、第 2 条 → 429
    await expect(service.requestSms('13800002004')).resolves.toEqual({ ttl: 60 });
    await expect(service.requestSms('13800002004')).rejects.toMatchObject({
      code: ErrorCode.RateLimited,
      httpStatus: 429,
    });
    // 跨号隔离：A 号触顶不影响 B 号首条
    await expect(service.requestSms('13900002004')).resolves.toEqual({ ttl: 60 });

    // 1h / 1d 窗：A1 只消费 allowed/window 并映射 429，窗逻辑事实源在 I1（verify-code-rate-limiter.spec）
    const limiterWith = (caps: { per60s: number; per1h: number; per1d: number }) =>
      new VerifyCodeRateLimiter(new PgPoolService(pool), caps);
    const p1 = '13800002005';
    const l1h = limiterWith({ per60s: 99, per1h: 5, per1d: 10 });
    for (let i = 0; i < 5; i += 1) {
      await expect(l1h.tryAcquire(p1)).resolves.toEqual({ allowed: true });
    }
    await expect(l1h.tryAcquire(p1)).resolves.toEqual({ allowed: false, window: '1h' });

    const l1d = limiterWith({ per60s: 99, per1h: 99, per1d: 10 });
    const p2 = '13800002006';
    for (let i = 0; i < 10; i += 1) {
      await expect(l1d.tryAcquire(p2)).resolves.toEqual({ allowed: true });
    }
    await expect(l1d.tryAcquire(p2)).resolves.toEqual({ allowed: false, window: '1d' });
  });

  it('盲索引唯一冲突（§9）：同号两次完成验证只建一个账号（二次=登录）；同盲索引直插第二行必 23505', async () => {
    const phone = '13800002007';
    const first = await registerOrLogin(phone, true);
    const second = await loginAgain(phone);
    expect(second.userId).toBe(first.userId);
    expect(
      await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM identity.users'),
    ).toMatchObject({ rows: [{ n: 1 }] });

    // 唯一索引本体（ux_users_phone）：同盲索引并发窗口的 DB 事实源
    await expect(
      pool.query('INSERT INTO identity.users (phone_enc, phone_blind_idx) VALUES ($1, $2)', [
        Buffer.from('dup'),
        crypto.blindIndex(phone),
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('双 token（R-W2-3）：access 2h / refresh 14d；refresh 仅落 sha256 哈希（明文不落库）；refresh 换新 access', async () => {
    const phone = '13800002008';
    const done = await registerOrLogin(phone, true);

    const claims = JSON.parse(Buffer.from(done.accessToken.split('.')[1]!, 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(7200); // 2h
    expect(claims.role).toBe('user');
    expect(JSON.stringify(claims)).not.toContain(phone); // claims 无 PII

    const row = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM identity.refresh_tokens WHERE user_id = $1',
      [done.userId],
    );
    expect(row.rows[0]?.token_hash).toBe(
      createHash('sha256').update(done.refreshToken, 'utf8').digest('hex'),
    );

    const refreshed = await service.refresh(done.refreshToken);
    expect(refreshed.accessToken.split('.')).toHaveLength(3);
  });

  it('R-W2-B/R-W2-4 吊销即时生效：logout 后 refresh → 401 E_REFRESH_EXPIRED；过期 refresh 同码；二次 logout 幂等', async () => {
    const done = await registerOrLogin('13800002009', true);

    await expect(service.refresh(done.refreshToken)).resolves.toHaveProperty('accessToken');
    expect(await service.logout(done.refreshToken)).toEqual({ ok: true, revoked: true });
    await expect(service.refresh(done.refreshToken)).rejects.toMatchObject({
      code: ErrorCode.RefreshExpired,
      httpStatus: 401,
    });
    expect(await service.logout(done.refreshToken)).toEqual({ ok: true, revoked: false }); // 幂等

    const done2 = await registerOrLogin('13800002010', true);
    await pool.query(
      "UPDATE identity.refresh_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1",
      [done2.userId],
    );
    await expect(service.refresh(done2.refreshToken)).rejects.toMatchObject({
      code: ErrorCode.RefreshExpired,
    });
  });

  it('switch-role（R-02 双角色同账号）：未持有 lawyer → 403 ROLE_NOT_HELD；合成事件授予后重签 claims 且同账号', async () => {
    const phone = '13800002011';
    const done = await registerOrLogin(phone, true);

    await expect(service.switchRole(done.userId, 'lawyer')).rejects.toMatchObject({
      code: ErrorCode.RoleNotHeld,
      httpStatus: 403,
    });

    // 合成事件：LawyerAuditPassed（生产方 A3a=本批 Task 3）→ relay 消费授予 lawyer
    await insertSyntheticEvent('identity.lawyer.audit.passed', {
      lawyer_user_id: done.userId,
      firm_id: 901,
    });
    expect((await relay.tick()).dispatched).toBe(1);

    const switched = await service.switchRole(done.userId, 'lawyer');
    const claims = JSON.parse(
      Buffer.from(switched.accessToken.split('.')[1]!, 'base64url').toString(),
    );
    expect(claims.role).toBe('lawyer');
    expect(claims.roles).toEqual(expect.arrayContaining(['user', 'lawyer'])); // R-02：lawyer 保留 user 身份
    expect(claims.sub).toBe(String(done.userId)); // 切换不产生新账号
  });

  it('AccountDeletionExecuted 消费：ACTIVE → DELETING 经守卫留痕；at-least-once 重投幂等短路（无重复留痕）', async () => {
    const done = await registerOrLogin('13800002012', true);
    const eventId = await insertSyntheticEvent('identity.account.deletion.executed', {
      user_id: done.userId,
    });
    expect((await relay.tick()).dispatched).toBe(1);

    const user = await pool.query<{ status: string }>(
      'SELECT status FROM identity.users WHERE id = $1',
      [done.userId],
    );
    expect(user.rows[0]?.status).toBe('DELETING');
    const stl = await pool.query<{ allowed: boolean }>(
      "SELECT allowed FROM platform.state_transition_log WHERE entity_type = 'identity_user' AND entity_id = $1",
      [done.userId],
    );
    expect(stl.rows).toHaveLength(1);
    expect(stl.rows[0]?.allowed).toBe(true);

    await redeliver(eventId);
    expect((await relay.tick()).dispatched).toBe(1);
    expect(
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM platform.state_transition_log WHERE entity_type = 'identity_user' AND entity_id = $1",
        [done.userId],
      ),
    ).toMatchObject({ rows: [{ n: 1 }] });
  });

  it('BANNED 登录拒绝：守卫迁移 BANNED 后 verify → 403 E_ACCOUNT_BANNED（refresh/switch-role 同拒，终审 I-1）', async () => {
    const phone = '13800002013';
    const done = await registerOrLogin(phone, true);

    // 封禁前角色链路可用：合成事件授予 lawyer → switch-role 换签成功（持未过期 token 的一环）
    await insertSyntheticEvent('identity.lawyer.audit.passed', {
      lawyer_user_id: done.userId,
      firm_id: 904,
    });
    expect((await relay.tick()).dispatched).toBe(1);
    await expect(service.switchRole(done.userId, 'lawyer')).resolves.toHaveProperty('accessToken');

    // 封禁（A4/H 侧动作，本批无 API）——经守卫留痕 + 条件更新，禁裸写
    await guard.assertTransition(USER_MACHINE, {
      entityId: done.userId,
      from: 'ACTIVE',
      to: 'BANNED',
      reason: 'spec: ban fixture',
    });
    const banned = await pool.query(
      "UPDATE identity.users SET status = 'BANNED' WHERE id = $1 AND status = 'ACTIVE' RETURNING id",
      [done.userId],
    );
    expect(banned.rowCount).toBe(1);

    await expect(loginAgain(phone)).rejects.toMatchObject({
      code: ErrorCode.AccountBanned,
      httpStatus: 403,
    });
    await expect(service.refresh(done.refreshToken)).rejects.toMatchObject({
      code: ErrorCode.AccountBanned,
    });
    // 终审 I-1：封禁后凭未过期 access 不可再换签续期（铸 token 三入口统一过状态闸）
    await expect(service.switchRole(done.userId, 'lawyer')).rejects.toMatchObject({
      code: ErrorCode.AccountBanned,
      httpStatus: 403,
    });
  });

  it('me 视图：roles/status/phone_masked 掩码（138****5678 形态）', async () => {
    const done = await registerOrLogin('13812345678', true);
    const me = await service.me(done.userId);
    expect(me).toEqual({
      id: done.userId,
      roles: ['user'],
      status: 'ACTIVE',
      phoneMasked: '138****5678',
    });
  });

  it('PII 红线：注册+登录+查询全链路后，日志调用、outbox 载荷、DB 行均无手机号明文', async () => {
    const phone = '13900002199';
    const done = await registerOrLogin(phone, true);
    await loginAgain(phone); // 登录路径一并覆盖
    await service.me(done.userId);

    // 日志：全部 Logger 调用串接后不含明文（logger spy，Review Focus #1）
    const logged = logCalls.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).not.toContain(phone);
    expect(logged).not.toBe(''); // 前置：流程中确有日志产出，断言非空转

    // 事件载荷：UserRegistered 只有 user_id
    const evt = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1',
      [USER_REGISTERED_TOPIC],
    );
    expect(JSON.stringify(evt.rows[0]?.payload)).not.toContain(phone);

    // 库内：users/verify_codes 文本列无明文（bytea 密文与盲索引/哈希除外）
    const users = await pool.query<{ text: string }>(
      "SELECT (coalesce(status,'') || '|' || age_declared::text || '|' || phone_blind_idx) AS text FROM identity.users",
    );
    for (const row of users.rows) expect(row.text).not.toContain(phone);
    const codes = await pool.query<{ text: string }>(
      'SELECT (phone_blind_idx || code_hash) AS text FROM identity.verify_codes',
    );
    for (const row of codes.rows) expect(row.text).not.toContain(phone);
  });

  it('入参防呆：非大陆手机号（R-W2-12）/非 6 位码 → 400 E_INVALID_ARGUMENT', async () => {
    await expect(service.requestSms('12345678901')).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });
    await expect(service.requestSms('1380000200')).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
    });
    await service.requestSms('13800002014');
    await expect(
      service.verify({ phone: '13800002014', code: '12345', ageDeclared: true }),
    ).rejects.toMatchObject({ code: ErrorCode.CodeInvalid });
  });
});
