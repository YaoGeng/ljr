import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, type INestApplication, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  REAL_NAME_VERIFIED_TOPIC,
  type RealNameVerifiedPayload,
} from '@ljr/shared';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { IdentityCryptoService } from './identity.crypto';
import { REALNAME_MACHINE } from './realname.machine';
import { REALNAME_CONFIG, type RealnameConfig } from './realname.config';
import { MockRealnameProvider, REALNAME_PROVIDER } from './realname.provider';
import { RealnameConsentModule } from './realname-consent.module';
import { RealnameService } from './realname.service';

/**
 * A2 实名领域层 e2e（需 PG）：提交核验状态机（NONE→PENDING→VERIFIED/FAILED，经守卫+STL）、
 * 400 INVALID_ID 形态闸、FAILED 可重提、幂等键=user、isRealnameVerified（R-01 内部查询面）、
 * 受控解密双人复核（R-04/R-W2-5）、PII 红线（§9：明文禁落库/落日志/进载荷）。
 */

/** 形态合法、校验位合法的测试证件号（GB 11643 标准示例位）；与任何真人无关 */
const VALID_ID_NO = '11010519491231002X';
/** 形态合法但校验位错 → 通道否决（FAILED 路径） */
const BAD_CHECKSUM_ID_NO = '110105194912310021';

/** 测试密钥：randomBytes 派生——密钥零字面量出测试（R-W2-11 同 A1 口径） */
const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** 日志捕获（Nest Logger 静态注入，A1 spec 同款挂点）：PII 红线 + 解密审计断言的事实源 */
const logCalls = vi.fn();

/** 计数包装通道：幂等短路「不重复核验」断言的事实源 */
class CountingMockProvider extends MockRealnameProvider {
  calls = 0;

  override async verify(input: {
    name: string;
    idNo: string;
  }): Promise<{ passed: boolean; token: string }> {
    this.calls += 1;
    return super.verify(input);
  }
}

describe('A2 实名领域层（状态机/幂等/受控解密/PII 红线，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let service: RealnameService;
  let crypto: IdentityCryptoService;
  let guard: StateTransitionGuardService;
  let provider: CountingMockProvider;

  /** 直插一条完整双签审批（R-W2-5：审批行以测试直插合成；创建面=H9 M4） */
  async function seedApproval(
    userId: number,
    opts: { approvedBy?: number | null; reviewedBy?: number | null } = {},
  ): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO identity.decrypt_approvals (user_id, reason, approved_by, reviewed_by)
       VALUES ($1, 'spec: 纠纷处理演练', $2, $3) RETURNING id`,
      [
        userId,
        opts.approvedBy === undefined ? 9001 : opts.approvedBy,
        opts.reviewedBy === undefined ? 9002 : opts.reviewedBy,
      ],
    );
    return Number(res.rows[0]!.id);
  }

  async function stlRows(entityId: number): Promise<{ from_status: string; to_status: string; allowed: boolean }[]> {
    const res = await pool.query<{
      from_status: string;
      to_status: string;
      allowed: boolean;
    }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'identity_realname' AND entity_id = $1 ORDER BY id`,
      [entityId],
    );
    return res.rows;
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    provider = new CountingMockProvider();
    const moduleRef = await Test.createTestingModule({ imports: [RealnameConsentModule] })
      .setLogger({
        log: logCalls,
        warn: logCalls,
        error: logCalls,
      } as unknown as LoggerService)
      .overrideProvider(REALNAME_PROVIDER)
      .useValue(provider)
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(REALNAME_CONFIG)
      .useValue({ retainIdentityText: true } satisfies RealnameConfig) // 留存开启：解密正路径可测
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(RealnameService);
    crypto = app.get(IdentityCryptoService);
    guard = app.get(StateTransitionGuardService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    Logger.overrideLogger([]);
  });

  beforeEach(async () => {
    provider.calls = 0;
    logCalls.mockClear();
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('状态机矩阵（§4）：合法五边可过、越边拒绝（NONE→VERIFIED / ABSENT 思维不可用于实名侧）', () => {
    expect(REALNAME_MACHINE.canTransition('NONE', 'PENDING')).toBe(true);
    expect(REALNAME_MACHINE.canTransition('FAILED', 'PENDING')).toBe(true);
    expect(REALNAME_MACHINE.canTransition('PENDING', 'VERIFIED')).toBe(true);
    expect(REALNAME_MACHINE.canTransition('PENDING', 'FAILED')).toBe(true);
    expect(REALNAME_MACHINE.canTransition('NONE', 'VERIFIED')).toBe(false);
    expect(REALNAME_MACHINE.canTransition('VERIFIED', 'PENDING')).toBe(false);
    expect(() => REALNAME_MACHINE.assertTransition('NONE', 'VERIFIED')).toThrowError(
      /非法状态迁移 NONE → VERIFIED/,
    );
  });

  it('R-01 提交→VERIFIED：NONE→PENDING→VERIFIED 双侧守卫留痕；落行（provider/digest/verified_at）；RealNameVerified 同事务', async () => {
    const done = await service.submitRealname(501, { name: '张三', idNo: VALID_ID_NO });
    expect(done.status).toBe('VERIFIED');
    expect(done.verifiedAt).toBeInstanceOf(Date);

    // 状态机两侧都过守卫+STL（简报红线：非法迁移拒绝+留痕，放行也留痕）
    expect(await stlRows(501)).toEqual([
      { from_status: 'NONE', to_status: 'PENDING', allowed: true },
      { from_status: 'PENDING', to_status: 'VERIFIED', allowed: true },
    ]);

    const row = await pool.query<{
      verify_provider: string;
      verify_token_digest: string;
      verified_at: Date;
    }>(
      'SELECT verify_provider, verify_token_digest, verified_at FROM identity.real_name_infos WHERE user_id = $1',
      [501],
    );
    expect(row.rows[0]?.verify_provider).toBe('MOCK'); // 裁决 D12：通道名落 MOCK
    expect(row.rows[0]?.verify_token_digest).toMatch(/^[0-9a-f]{64}$/); // char(64) 摘要不存原文
    expect(row.rows[0]?.verified_at).toEqual(done.verifiedAt);

    const evt = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1',
      [REAL_NAME_VERIFIED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]?.payload).toEqual({ user_id: 501 } satisfies RealNameVerifiedPayload);
  });

  it('400 INVALID_ID 形态闸：空姓名/非 18 位证件 → 400，不触达通道、无状态迁移留痕', async () => {
    await expect(service.submitRealname(502, { name: '  ', idNo: VALID_ID_NO })).rejects.toMatchObject({
      code: ErrorCode.InvalidId,
      httpStatus: 400,
    });
    await expect(
      service.submitRealname(502, { name: '张三', idNo: '1101051949123100' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidId, httpStatus: 400 });
    await expect(
      service.submitRealname(502, { name: '张三', idNo: '11010519491231002Y' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidId });
    expect(provider.calls).toBe(0); // 形态错不触达通道
    expect(await stlRows(502)).toEqual([]); // 无任何迁移
    expect(
      await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM identity.real_name_infos'),
    ).toMatchObject({ rows: [{ n: 0 }] });
  });

  it('通道否决→FAILED：PENDING→FAILED 留痕、不落行；FAILED 可重提（→PENDING→VERIFIED）', async () => {
    const failed = await service.submitRealname(503, { name: '张三', idNo: BAD_CHECKSUM_ID_NO });
    expect(failed).toEqual({ status: 'FAILED' });
    expect(await stlRows(503)).toEqual([
      { from_status: 'NONE', to_status: 'PENDING', allowed: true },
      { from_status: 'PENDING', to_status: 'FAILED', allowed: true },
    ]);
    expect(await service.realnameStatus(503)).toEqual({ status: 'FAILED' });
    expect(
      await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM identity.real_name_infos'),
    ).toMatchObject({ rows: [{ n: 0 }] });

    // FAILED 可重提（§4），通过后 VERIFIED（FAILED→PENDING 守卫留痕）
    const retried = await service.submitRealname(503, { name: '张三', idNo: VALID_ID_NO });
    expect(retried.status).toBe('VERIFIED');
    expect(await stlRows(503)).toEqual([
      { from_status: 'NONE', to_status: 'PENDING', allowed: true },
      { from_status: 'PENDING', to_status: 'FAILED', allowed: true },
      { from_status: 'FAILED', to_status: 'PENDING', allowed: true },
      { from_status: 'PENDING', to_status: 'VERIFIED', allowed: true },
    ]);
  });

  it('非法迁移拒绝+留痕（计划红线）：守卫对 NONE→VERIFIED 写 allowed=false 后抛 409', async () => {
    await expect(
      guard.assertTransition(REALNAME_MACHINE, {
        entityId: 504,
        from: 'NONE',
        to: 'VERIFIED',
        reason: 'spec: 裸写尝试',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateIllegalTransition, httpStatus: 409 });
    const denied = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log
        WHERE entity_type = 'identity_realname' AND entity_id = 504`,
    );
    expect(denied.rows).toEqual([{ allowed: false }]);
  });

  it('幂等键=user：已 VERIFIED 再提交返回现值（同 verified_at）、不重复核验、不重复事件/留痕', async () => {
    const first = await service.submitRealname(505, { name: '张三', idNo: VALID_ID_NO });
    const callsAfterFirst = provider.calls;
    const stlCount = (await stlRows(505)).length;

    const second = await service.submitRealname(505, { name: '李四', idNo: BAD_CHECKSUM_ID_NO });
    expect(second.status).toBe('VERIFIED');
    expect(second.verifiedAt).toEqual(first.verifiedAt); // 现值
    expect(provider.calls).toBe(callsAfterFirst); // 不重复核验
    expect((await stlRows(505)).length).toBe(stlCount); // 无新迁移
    const evt = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1',
      [REAL_NAME_VERIFIED_TOPIC],
    );
    expect(evt.rows[0]?.n).toBe(1); // 事件不重复
  });

  it('isRealnameVerified（R-01 内部查询面）：未实名 false；VERIFIED true——W3 C3/F1 闸口消费位', async () => {
    expect(await service.isRealnameVerified(506)).toBe(false);
    await service.submitRealname(506, { name: '张三', idNo: VALID_ID_NO });
    expect(await service.isRealnameVerified(506)).toBe(true);
    // 「未实名支付被 C3 拦截」=W3 联调（§10-1 桩）：本批只交查询面
  });

  it('R-04 受控解密：无审批/未双签/指向不符 → 403 NOT_APPROVED；双签完整 → 返回姓名与证件号（临时解密不改状态）', async () => {
    await service.submitRealname(507, { name: '张三', idNo: VALID_ID_NO });

    // 无审批记录
    await expect(
      service.decryptForCompliance({ userId: 507, reason: '纠纷处理', approvalId: 424242 }),
    ).rejects.toMatchObject({ code: ErrorCode.NotApproved, httpStatus: 403 });
    // 审批未双签（复核人空=H9 渐进签发中的中间态）
    const pendingReview = await seedApproval(507, { reviewedBy: null });
    await expect(
      service.decryptForCompliance({ userId: 507, reason: '纠纷处理', approvalId: pendingReview }),
    ).rejects.toMatchObject({ code: ErrorCode.NotApproved });
    // 双签完整但指向他人（审批不覆盖该 user）
    const otherUser = await seedApproval(999, {});
    await expect(
      service.decryptForCompliance({ userId: 507, reason: '纠纷处理', approvalId: otherUser }),
    ).rejects.toMatchObject({ code: ErrorCode.NotApproved });

    // 双签完整 → 临时解密返回（明文只出现在返回值）
    const approvalId = await seedApproval(507, {});
    const decrypted = await service.decryptForCompliance({
      userId: 507,
      reason: '纠纷处理-2026-001',
      approvalId,
    });
    expect(decrypted).toEqual({ name: '张三', idNo: VALID_ID_NO });
    // 临时解密：不留痕、不改状态、不重复审计以外的任何写
    expect(await service.realnameStatus(507)).toHaveProperty('status', 'VERIFIED');
  });

  it('R-04 密文最小化边界：默认（留存关）仅存摘要——密文列为 NULL，审批完整也无内容可解（404）', async () => {
    const moduleRef2 = await Test.createTestingModule({ imports: [RealnameConsentModule] })
      .setLogger({
        log: logCalls,
        warn: logCalls,
        error: logCalls,
      } as unknown as LoggerService)
      .overrideProvider(REALNAME_PROVIDER)
      .useValue(provider)
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(REALNAME_CONFIG)
      .useValue({ retainIdentityText: false } satisfies RealnameConfig)
      .compile();
    const app2 = moduleRef2.createNestApplication();
    await app2.init();
    const serviceNoRetain = app2.get(RealnameService);

    await serviceNoRetain.submitRealname(508, { name: '张三', idNo: VALID_ID_NO });
    const row = await pool.query<{ name_enc: Buffer | null; id_no_enc: Buffer | null }>(
      'SELECT name_enc, id_no_enc FROM identity.real_name_infos WHERE user_id = $1',
      [508],
    );
    expect(row.rows[0]?.name_enc).toBeNull();
    expect(row.rows[0]?.id_no_enc).toBeNull();

    const approvalId = await seedApproval(508, {});
    await expect(
      serviceNoRetain.decryptForCompliance({ userId: 508, reason: '纠纷处理', approvalId }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound, httpStatus: 404 });

    await app2.close();
  });

  it('PII 红线（§9）：全链路后，日志、RealNameVerified 载荷、库内文本列均无姓名/证件号明文；密文列可解回原文', async () => {
    const done = await service.submitRealname(509, { name: '张小明', idNo: VALID_ID_NO });
    await service.realnameStatus(509);
    await service.decryptForCompliance({
      userId: 509,
      reason: '纠纷处理',
      approvalId: await seedApproval(509, {}),
    });

    // 日志：全程产出非空（防假绿前置），且不含姓名/证件号明文
    const logged = logCalls.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).not.toBe('');
    expect(logged).not.toContain('张小明');
    expect(logged).not.toContain(VALID_ID_NO);

    // 事件载荷：仅 user_id
    const evt = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1',
      [REAL_NAME_VERIFIED_TOPIC],
    );
    const payloadText = JSON.stringify(evt.rows.map((r) => r.payload));
    expect(payloadText).not.toContain('张小明');
    expect(payloadText).not.toContain(VALID_ID_NO);

    // 库内文本列：provider/摘要 hex 无明文；STL reason 无明文
    const texts = await pool.query<{ text: string }>(
      `SELECT verify_provider || '|' || verify_token_digest AS text FROM identity.real_name_infos
        UNION ALL SELECT coalesce(reason,'') FROM platform.state_transition_log
        WHERE entity_type = 'identity_realname'`,
    );
    for (const row of texts.rows) {
      expect(row.text).not.toContain('张小明');
      expect(row.text).not.toContain(VALID_ID_NO);
    }

    // 密文列：解回=原文（信封可逆），密文字节≠明文
    const enc = await pool.query<{ name_enc: Buffer; id_no_enc: Buffer }>(
      'SELECT name_enc, id_no_enc FROM identity.real_name_infos WHERE user_id = $1',
      [509],
    );
    expect(crypto.decryptIdentityField(enc.rows[0]!.name_enc, 'name_enc')).toBe('张小明');
    expect(crypto.decryptIdentityField(enc.rows[0]!.id_no_enc, 'id_no_enc')).toBe(VALID_ID_NO);
    expect(enc.rows[0]!.id_no_enc.equals(Buffer.from(VALID_ID_NO, 'utf8'))).toBe(false);
    expect(done.status).toBe('VERIFIED');

    // 解密审计留痕（自定=log 形态，R-W2-5）：日志含审批行且无明文
    expect(logged).toContain('realname.decrypt 审计');
    expect(logged).toContain('approved_by=9001');
    expect(logged).toContain('reviewed_by=9002');
  });

  it('verify_token_digest 是凭据 sha256（不存原文凭据形态）：摘要与 MOCK-UUID 原文不同名', async () => {
    await service.submitRealname(510, { name: '张三', idNo: VALID_ID_NO });
    const row = await pool.query<{ verify_token_digest: string }>(
      'SELECT verify_token_digest FROM identity.real_name_infos WHERE user_id = $1',
      [510],
    );
    const digest = row.rows[0]!.verify_token_digest;
    expect(digest).not.toContain('MOCK-'); // 原文凭据（MOCK- 前缀）不落库
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(createHash('sha256').update(digest, 'utf8').digest('hex'));
  });
});
