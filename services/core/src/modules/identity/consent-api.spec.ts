import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ErrorCode } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import {
  type NotifyChannelAdapter,
  type NotifyChannelMessage,
  NOTIFY_CHANNEL_ADAPTERS,
} from '../notify/notify.channels';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { IdentityModule } from './identity.module';
import { CONSENT_CONFIG, type ConsentConfig } from './consent.config';
import { RealnameConsentModule } from './realname-consent.module';

/**
 * A2 REST 契约（同意面，§5 + §2 做项）：POST /consents/training、POST /consents/training/revoke、
 * GET /consents/training（状态查询=§2 设置中心做项，§5 契约表缺口回写项）。
 * R-02 用例钉住：拒绝 training 授权后其余功能不受影响（/me 同 session 可用）。
 */

const CURRENT_POLICY = 'v1.0.0';

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** 捕获式 SMS 适配器（IdentityModule 建号链路需要；供应商位=M2+，同 A1 spec 口径） */
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

describe('A2 REST 契约（同意面 + R-02 拒绝不降级，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let capture: CapturingSmsAdapter;
  let token: string;

  /** 走真实 A1 链路拿一个可用账号与 token */
  async function register(phone: string): Promise<void> {
    await request(app.getHttpServer()).post('/auth/sms').send({ phone });
    const res = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ phone, code: capture.lastCode(), age_declared: true });
    token = res.body.access_token as string;
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    capture = new CapturingSmsAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule, RealnameConsentModule], // R-02 跨切片：/me（A1）与同意面（A2）同 app
    })
      .overrideProvider(NOTIFY_CHANNEL_ADAPTERS)
      .useValue([capture])
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(CONSENT_CONFIG)
      .useValue({ trainingPolicyVersion: CURRENT_POLICY } satisfies ConsentConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
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

  it('POST /consents/training：无 token → 401；{policy_version, accept:true} → {status:"GRANTED"}', async () => {
    const anon = await request(app.getHttpServer())
      .post('/consents/training')
      .send({ policy_version: CURRENT_POLICY, accept: true });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe(ErrorCode.Unauthorized);

    await register('13800004001');
    const ok = await request(app.getHttpServer())
      .post('/consents/training')
      .set('Authorization', `Bearer ${token}`)
      .send({ policy_version: CURRENT_POLICY, accept: true });
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ status: 'GRANTED' });
  });

  it('POST /consents/training：policy_version ≠ 当前有效值 → 409 E_VERSION_MISMATCH（R-W2-6）', async () => {
    await register('13800004002');
    const bad = await request(app.getHttpServer())
      .post('/consents/training')
      .set('Authorization', `Bearer ${token}`)
      .send({ policy_version: 'v9.9.9', accept: true });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe(ErrorCode.VersionMismatch);
  });

  it('R-02 拒绝路径（§10-2）：accept=false → {status:"ABSENT"}；拒绝后 /me 等其余功能不受影响', async () => {
    await register('13800004003');
    const declined = await request(app.getHttpServer())
      .post('/consents/training')
      .set('Authorization', `Bearer ${token}`)
      .send({ policy_version: CURRENT_POLICY, accept: false });
    expect(declined.status).toBe(201);
    expect(declined.body).toEqual({ status: 'ABSENT' });

    // 拒绝不降级：同 session 的 /me（A1 用户面）与 /realname/status（A2 查询面）均可用
    const me = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ status: 'ACTIVE' });

    const realname = await request(app.getHttpServer())
      .get('/realname/status')
      .set('Authorization', `Bearer ${token}`);
    expect(realname.status).toBe(200);
    expect(realname.body).toEqual({ status: 'NONE' });

    // 拒绝也不留授权行：状态查询仍 ABSENT
    const view = await request(app.getHttpServer())
      .get('/consents/training')
      .set('Authorization', `Bearer ${token}`);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({ status: 'ABSENT' });
  });

  it('POST /consents/training/revoke：授权后撤回 → {status:"REVOKED", revoked_at}；重复撤回幂等返回现值（R-03 起点）', async () => {
    await register('13800004004');
    await request(app.getHttpServer())
      .post('/consents/training')
      .set('Authorization', `Bearer ${token}`)
      .send({ policy_version: CURRENT_POLICY, accept: true });

    const revoke = await request(app.getHttpServer())
      .post('/consents/training/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(revoke.status).toBe(201);
    expect(revoke.body.status).toBe('REVOKED');
    expect(typeof revoke.body.revoked_at).toBe('string');

    const again = await request(app.getHttpServer())
      .post('/consents/training/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('REVOKED');
    expect(again.body.revoked_at).toBe(revoke.body.revoked_at); // 幂等现值
  });

  it('GET /consents/training：状态查询 ABSENT → 授权 → 撤回全程可视（§2 设置中心做项/§5 缺口回写项）', async () => {
    await register('13800004005');
    const authed = { Authorization: `Bearer ${token}` };

    const before = await request(app.getHttpServer()).get('/consents/training').set(authed);
    expect(before.body).toEqual({ status: 'ABSENT' });

    await request(app.getHttpServer())
      .post('/consents/training')
      .set(authed)
      .send({ policy_version: CURRENT_POLICY, accept: true });
    const granted = await request(app.getHttpServer()).get('/consents/training').set(authed);
    expect(granted.body).toMatchObject({ status: 'GRANTED', policy_version: CURRENT_POLICY });
    expect(typeof granted.body.granted_at).toBe('string');

    await request(app.getHttpServer()).post('/consents/training/revoke').set(authed).send({});
    const revoked = await request(app.getHttpServer()).get('/consents/training').set(authed);
    expect(revoked.body).toMatchObject({ status: 'REVOKED', policy_version: CURRENT_POLICY });
    expect(typeof revoked.body.revoked_at).toBe('string');
  });
});
