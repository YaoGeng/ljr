import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  type NotifyChannelAdapter,
  type NotifyChannelMessage,
  NOTIFY_CHANNEL_ADAPTERS,
} from '../notify/notify.channels';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { IdentityModule } from './identity.module';

/**
 * A1 REST 契约（§5 + 裁决 R-W2-B/C）：/auth/sms、/auth/verify、/auth/refresh、/auth/logout、
 * /auth/switch-role、GET /me；R-03 越权（lawyer 角色访问用户端接口 403，W2 交接 4-B 接线后
 * 的 I1 用户面为标本）。
 */

/** 捕获式 SMS 适配器：测试经 mock 通道取回验证码（供应商位=M2+） */
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

describe('A1 REST 契约（需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let capture: CapturingSmsAdapter;
  let relay: OutboxRelayService;

  /** 由 access_token 解 claims（测试侧校验签发内容） */
  function claimsOf(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  }

  /** 合成领域事件（生产方未落位：A3a=Task 3 / A4=M4） */
  async function insertSyntheticEvent(topic: string, payload: unknown): Promise<void> {
    await pool.query(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES (gen_random_uuid(), $1, $2::jsonb, 'PENDING')`,
      [topic, JSON.stringify(payload)],
    );
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    capture = new CapturingSmsAdapter();
    const moduleRef = await Test.createTestingModule({ imports: [IdentityModule] })
      .overrideProvider(NOTIFY_CHANNEL_ADAPTERS)
      .useValue([capture])
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    relay = app.get(OutboxRelayService);
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

  it('POST /auth/sms：{phone} → {ttl:60}；60s 内第 2 条 → 429 E_RATE_LIMITED；非大陆号 → 400', async () => {
    const ok = await request(app.getHttpServer()).post('/auth/sms').send({ phone: '13800003001' });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ ttl: 60 });

    const limited = await request(app.getHttpServer())
      .post('/auth/sms')
      .send({ phone: '13800003001' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe(ErrorCode.RateLimited);

    const bad = await request(app.getHttpServer()).post('/auth/sms').send({ phone: '12345' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(ErrorCode.InvalidArgument);
  });

  it('POST /auth/verify：新号缺 age_declared → 400 E_AGE_DECLARATION_REQUIRED（R-04/R-W2-C）；补声明 → {access_token, refresh_token, roles}', async () => {
    const phone = '13800003002';
    await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    const code = capture.lastCode();

    const noAge = await request(app.getHttpServer()).post('/auth/verify').send({ phone, code });
    expect(noAge.status).toBe(400);
    expect(noAge.body.code).toBe(ErrorCode.AgeDeclarationRequired);

    const ok = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code, age_declared: true });
    expect(ok.status).toBe(201);
    expect(ok.body.roles).toEqual(['user']);
    expect(ok.body.access_token.split('.')).toHaveLength(3);
    expect(typeof ok.body.refresh_token).toBe('string');

    const wrong = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: '999999', age_declared: true });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe(ErrorCode.CodeInvalid);
  });

  it('POST /auth/refresh：换新 access；logout（R-W2-B）后 → 401 E_REFRESH_EXPIRED（R-W2-4 即时生效）', async () => {
    const phone = '13800003003';
    await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    const register = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: capture.lastCode(), age_declared: true });
    const { refresh_token } = register.body;

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token });
    expect(refreshed.status).toBe(201);
    expect(refreshed.body.access_token.split('.')).toHaveLength(3);

    await request(app.getHttpServer()).post('/auth/logout').send({ refresh_token });
    const after = await request(app.getHttpServer()).post('/auth/refresh').send({ refresh_token });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe(ErrorCode.RefreshExpired);
  });

  it('POST /auth/switch-role：未认证 → 401；未持有目标角色 → 403 E_ROLE_NOT_HELD；合成审核事件授予后重签 claims.role', async () => {
    const phone = '13800003004';
    await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    const register = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: capture.lastCode(), age_declared: true });
    const token = register.body.access_token as string;
    const userId = claimsOf(token)['sub'] as string;

    const anon = await request(app.getHttpServer())
      .post('/auth/switch-role')
      .send({ target_role: 'lawyer' });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const notHeld = await request(app.getHttpServer())
      .post('/auth/switch-role')
      .set('Authorization', `Bearer ${token}`)
      .send({ target_role: 'lawyer' });
    expect(notHeld.status).toBe(403);
    expect(notHeld.body.code).toBe(ErrorCode.RoleNotHeld);

    // 合成事件：A3a 审核通过（生产方=Task 3）→ relay 消费授予 lawyer
    await insertSyntheticEvent('identity.lawyer.audit.passed', {
      lawyer_user_id: Number(userId),
      firm_id: 902,
    });
    expect((await relay.tick()).dispatched).toBe(1);

    const switched = await request(app.getHttpServer())
      .post('/auth/switch-role')
      .set('Authorization', `Bearer ${token}`)
      .send({ target_role: 'lawyer' });
    expect(switched.status).toBe(201);
    const claims = claimsOf(switched.body.access_token);
    expect(claims['role']).toBe('lawyer');
    expect(claims['roles']).toEqual(expect.arrayContaining(['user', 'lawyer'])); // R-02
    expect(claims['sub']).toBe(userId); // 不产生新账号
  });

  it('GET /me：无 token → 401 E_UNAUTHORIZED；坏 token → 401；有效 → {id, roles, status, phone_masked}', async () => {
    const anon = await request(app.getHttpServer()).get('/me');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    const garbage = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Bearer not-a-jwt');
    expect(garbage.status).toBe(401);
    expect(garbage.body.code).toBe(ErrorCode.Unauthorized);

    const phone = '13812345678';
    await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    const register = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: capture.lastCode(), age_declared: true });
    const me = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${register.body.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      roles: ['user'],
      status: 'ACTIVE',
      phone_masked: '138****5678',
    });
    expect(me.body.id).toBe(Number(claimsOf(register.body.access_token)['sub']));
  });

  it('R-03 越权：lawyer 角色访问用户端接口（GET /notifications/mine）→ 403 E_ROLE_FORBIDDEN；user 角色正常', async () => {
    const phone = '13800003005';
    await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    const register = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: capture.lastCode(), age_declared: true });
    const userToken = register.body.access_token as string;
    const userId = Number(claimsOf(userToken)['sub']);

    // 合成事件授予 lawyer → switch-role 拿 lawyer 角色 token（旧 token 仍是 user 角色）
    await insertSyntheticEvent('identity.lawyer.audit.passed', {
      lawyer_user_id: userId,
      firm_id: 903,
    });
    await relay.tick();
    const switched = await request(app.getHttpServer())
      .post('/auth/switch-role')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ target_role: 'lawyer' });
    const lawyerToken = switched.body.access_token as string;

    // 旧 token（user 角色）在新角色接口语义下不可用：lawyer token 访问用户端接口被 403
    const asLawyer = await request(app.getHttpServer())
      .get('/notifications/mine')
      .set('Authorization', `Bearer ${lawyerToken}`);
    expect(asLawyer.status).toBe(403);
    expect(asLawyer.body.code).toBe(ErrorCode.RoleForbidden);

    // user 角色访问用户端接口正常（双角色同账号，切回即恢复）
    const asUser = await request(app.getHttpServer())
      .get('/notifications/mine')
      .set('Authorization', `Bearer ${userToken}`);
    expect(asUser.status).toBe(200);
    expect(asUser.body).toEqual([]);

    // 未认证访问用户端接口 → 401
    const anon = await request(app.getHttpServer()).get('/notifications/mine');
    expect(anon.status).toBe(401);
  });
});
