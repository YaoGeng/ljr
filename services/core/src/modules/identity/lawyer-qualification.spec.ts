import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, type INestApplication, type LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  LAWYER_AUDIT_PASSED_TOPIC,
  LAWYER_SUSPENDED_TOPIC,
  type LawyerAuditPassedPayload,
  type LawyerSuspendedPayload,
} from '@ljr/shared';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { IdentityCryptoService } from './identity.crypto';
import { IdentityUserConsumer } from './identity.consumer';
import { LAWYER_AUDIT_MACHINE } from './lawyer.machine';
import { LawyerQualificationModule } from './lawyer-qualification.module';
import { LawyerQualificationService, materialFingerprintOf } from './lawyer.service';

/**
 * A3a 律师资质审核领域层 e2e（需 PG）：状态机全迁移矩阵（§4，经守卫+STL 禁裸写）、
 * R-03 license_no 盲索引唯一（409）、重提新材料版本（§4 守卫）、R-01 isAuditPassed 查询面、
 * R-02 submitted_at/audited_at 数据位、LawyerAuditPassed/LawyerSuspended 生产端真实发射、
 * A1 授角闭环（真事件→真消费端→user_roles 双行）、PII 红线（license_no 明文禁日志/载荷/DB）。
 */

/** 虚构执业证号（仅测试域；与任何真实执业证无关） */
const LICENSE_A = 'LICENSE-SPEC-0001';
/** 变更后的材料 B 版（重提/修改用：文件引用换新，执业证号不变） */
const LICENSE_A_FILES_V2 = [
  { kind: 'LICENSE_PHOTO', ref: 'spec/oss/license-a-v2.jpg' },
  { kind: 'FIRM_AUTHORIZATION', ref: 'spec/oss/auth-a-v2.pdf' },
];

const licenseFilesV1 = (tag: string) => [
  { kind: 'LICENSE_PHOTO', ref: `spec/oss/license-${tag}-v1.jpg` },
  { kind: 'FIRM_AUTHORIZATION', ref: `spec/oss/auth-${tag}-v1.pdf` },
];

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

/** 日志捕获（Nest Logger 静态 override）：PII 红线断言载体，兼保输出纯净（identity.spec 同款） */
const logCalls = vi.fn();

describe('A3a 领域层（状态机/盲索引唯一/重提版本/事件生产/A1 闭环/PII，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let service: LawyerQualificationService;
  let crypto: IdentityCryptoService;
  let guard: StateTransitionGuardService;
  let relay: OutboxRelayService;

  /** 直插测试账号（A1 建号链路由 identity.spec 覆盖）：返回 user_id */
  async function seedUser(tag: string): Promise<number> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO identity.users (phone_enc, phone_blind_idx, status, age_declared)
       VALUES ($1, $2, 'ACTIVE', true) RETURNING id`,
      [Buffer.from(`fixture-${tag}`), randomBytes(32).toString('hex')],
    );
    return Number(res.rows[0]!.id);
  }

  async function profileRow(userId: number): Promise<
    | {
        id: string;
        audit_status: string;
        material_version: number;
        material_fingerprint: string;
        license_no_blind_idx: string;
        firm_name: string | null;
        submitted_at: Date | null;
        audited_at: Date | null;
        auditor_id: string | null;
        reject_reason: string | null;
      }
    | undefined
  > {
    const res = await pool.query<{
      id: string;
      audit_status: string;
      material_version: number;
      material_fingerprint: string;
      license_no_blind_idx: string;
      firm_name: string | null;
      submitted_at: Date | null;
      audited_at: Date | null;
      auditor_id: string | null;
      reject_reason: string | null;
    }>(
      `SELECT id, audit_status, material_version, material_fingerprint, license_no_blind_idx,
              firm_name, submitted_at, audited_at, auditor_id, reject_reason
         FROM identity.lawyer_profiles WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0];
  }

  async function stlRows(
    userId: number,
  ): Promise<{ from_status: string; to_status: string; allowed: boolean }[]> {
    const res = await pool.query<{ from_status: string; to_status: string; allowed: boolean }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'identity_lawyer_profile' AND entity_id = $1 ORDER BY id`,
      [userId],
    );
    return res.rows;
  }

  async function fileRows(
    profileId: number,
  ): Promise<{ material_version: number; kind: string; file_ref: string }[]> {
    const res = await pool.query<{
      material_version: number;
      kind: string;
      file_ref: string;
    }>(
      `SELECT material_version, kind, file_ref FROM identity.qualification_files
        WHERE lawyer_id = $1 ORDER BY material_version, id`,
      [profileId],
    );
    return res.rows;
  }

  async function outboxPayloads(topic: string): Promise<unknown[]> {
    const res = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id',
      [topic],
    );
    return res.rows.map((r) => r.payload);
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [LawyerQualificationModule] })
      .setLogger({
        log: logCalls,
        warn: logCalls,
        error: logCalls,
      } as unknown as LoggerService)
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(LawyerQualificationService);
    crypto = app.get(IdentityCryptoService);
    guard = app.get(StateTransitionGuardService);
    relay = app.get(OutboxRelayService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    Logger.overrideLogger([]); // 还原静默（identity.spec 同口径）
  });

  beforeEach(async () => {
    logCalls.mockClear();
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('状态机迁移矩阵（§4 全集）：恰 8 条边可过（含 REJECTED→SUBMITTED 重提、PASSED→SUBMITTED 材料修改），其余全拒绝', () => {
    const allowed = new Set([
      'DRAFT→SUBMITTED', // 提交
      'SUBMITTED→IN_REVIEW', // H1 领取
      'IN_REVIEW→PASSED', // 通过
      'IN_REVIEW→REJECTED', // 拒绝
      'REJECTED→SUBMITTED', // 重提（新材料版本）
      'PASSED→SUBMITTED', // PASSED 后材料修改
      'PASSED→SUSPENDED', // 停用
      'SUSPENDED→PASSED', // 恢复
    ]);
    const states = LAWYER_AUDIT_MACHINE.def.states;
    for (const from of states) {
      for (const to of states) {
        expect(LAWYER_AUDIT_MACHINE.canTransition(from, to)).toBe(allowed.has(`${from}→${to}`));
      }
    }
    expect(allowed.size).toBe(8);
    // 纯校验面：非法迁移抛 409 E_STATE_ILLEGAL_TRANSITION
    expect(() => LAWYER_AUDIT_MACHINE.assertTransition('DRAFT', 'PASSED')).toThrowError(
      /非法状态迁移 DRAFT → PASSED/,
    );
  });

  it('提交（DRAFT→SUBMITTED）：建行 SUBMITTED/v1，license_no 只存密文+盲索引，STL 留痕，qualification_files v1 入库，无事件', async () => {
    const userId = await seedUser('submit');
    expect(await service.isAuditPassed(userId)).toBe(false); // R-01：未 PASSED 不见列表（查询面）

    const done = await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    expect(done.status).toBe('SUBMITTED');
    expect(done.materialVersion).toBe(1);

    const row = await profileRow(userId);
    expect(row).toMatchObject({
      audit_status: 'SUBMITTED',
      material_version: 1,
      firm_name: '北京测试律师事务所',
    });
    expect(row!.submitted_at).toBeInstanceOf(Date); // R-02 SLA 数据位
    expect(row!.license_no_blind_idx).toBe(crypto.blindIndex(LICENSE_A)); // HMAC 盲索引（复用 T1 pepper）
    expect(await service.isAuditPassed(userId)).toBe(false);

    // 密文形态：可解回原文、不等于明文字节（列加密复用 A1 信封）
    const enc = await pool.query<{ license_no_enc: Buffer }>(
      'SELECT license_no_enc FROM identity.lawyer_profiles WHERE user_id = $1',
      [userId],
    );
    expect(enc.rows[0]!.license_no_enc.equals(Buffer.from(LICENSE_A))).toBe(false);
    expect(crypto.decryptIdentityField(enc.rows[0]!.license_no_enc, 'license_no_enc')).toBe(
      LICENSE_A,
    );

    expect(await stlRows(userId)).toEqual([
      { from_status: 'DRAFT', to_status: 'SUBMITTED', allowed: true },
    ]);
    expect(await fileRows(Number(row!.id))).toEqual([
      { material_version: 1, kind: 'LICENSE_PHOTO', file_ref: 'spec/oss/license-a-v1.jpg' },
      { material_version: 1, kind: 'FIRM_AUTHORIZATION', file_ref: 'spec/oss/auth-a-v1.pdf' },
    ]);
    // 提交不产生领域事件（§6 只有 PASSED/SUSPENDED 两个生产事件）
    expect(await outboxPayloads(LAWYER_AUDIT_PASSED_TOPIC)).toEqual([]);
    expect(await outboxPayloads(LAWYER_SUSPENDED_TOPIC)).toEqual([]);

    // 指纹离线猜测预言机防线（T3 评审 Important-1）：
    // ①白盒正向——license 组件以盲索引（HMAC+pepper）参与时可精确重算（确定性判定依据）
    expect(
      materialFingerprintOf(
        crypto.blindIndex(LICENSE_A),
        '北京测试律师事务所',
        licenseFilesV1('a'),
      ),
    ).toBe(row!.material_fingerprint);
    // ②否定向——明文 license_no 参与的无钥 canonical（评审点名的泄露后离线验证形态）
    //   哈希 ≠ 库内指纹：DB 泄露 + 同行明文字段不可穷举强格式证号
    const offlinePlaintextCanonical = JSON.stringify({
      license_no: LICENSE_A,
      firm_name: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    expect(createHash('sha256').update(offlinePlaintextCanonical, 'utf8').digest('hex')).not.toBe(
      row!.material_fingerprint,
    );
    // ③指纹不含明文证号字面（与盲索引同性质的派生值）
    expect(row!.material_fingerprint).not.toContain(LICENSE_A);
  });

  it('幂等键=user（§5 409 ALREADY_SUBMITTED）：SUBMITTED/IN_REVIEW 中再提交一律 409，无新留痕/文件/事件', async () => {
    const userId = await seedUser('dup');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const before = (await stlRows(userId)).length;

    await expect(
      service.submitQualification(userId, {
        licenseNo: LICENSE_A,
        firmName: '北京测试律师事务所',
        files: licenseFilesV1('a'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AlreadySubmitted, httpStatus: 409 });

    await service.audit(Number((await profileRow(userId))!.id), { action: 'claim' });
    await expect(
      service.submitQualification(userId, {
        licenseNo: LICENSE_A,
        firmName: '北京测试律师事务所',
        files: licenseFilesV1('a'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AlreadySubmitted, httpStatus: 409 });

    expect(await stlRows(userId)).toHaveLength(before + 1); // 仅 claim 一次迁移
    const row = await profileRow(userId);
    expect(await fileRows(Number(row!.id))).toHaveLength(2); // 仍只有 v1 两件
  });

  it('R-03 盲索引唯一：他人已用 license_no → 409 E_LICENSE_NO_TAKEN；唯一索引直插第二行必 23505（DB 事实源）', async () => {
    const userA = await seedUser('r03a');
    const userB = await seedUser('r03b');
    await service.submitQualification(userA, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });

    await expect(
      service.submitQualification(userB, {
        licenseNo: LICENSE_A,
        firmName: '上海测试律师事务所',
        files: licenseFilesV1('b'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LicenseNoTaken, httpStatus: 409 });
    expect(await profileRow(userB)).toBeUndefined(); // 未落行

    // 唯一索引本体（ux_lawyer_profiles_license）：应用预检竞窗的 DB 兜底
    await expect(
      pool.query(
        `INSERT INTO identity.lawyer_profiles
           (user_id, license_no_enc, license_no_blind_idx, material_version, material_fingerprint, audit_status, submitted_at)
         VALUES ($1, $2, $3, 1, $4, 'SUBMITTED', now())`,
        [userB, Buffer.from('dup-license'), crypto.blindIndex(LICENSE_A), '0'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // 本人重提（REJECTED）带同号合法：唯一性只限他人（后面用例走全链路验证）
  });

  it('审核链（claim→approve）：SUBMITTED→IN_REVIEW→PASSED 守卫留痕，audited_at 落位，LawyerAuditPassed 载荷 firm_id=null 且无 license 明文', async () => {
    const userId = await seedUser('audit');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);

    expect(await service.audit(profileId, { action: 'claim' })).toEqual({ status: 'IN_REVIEW' });
    expect((await profileRow(userId))!.audit_status).toBe('IN_REVIEW');

    expect(await service.audit(profileId, { action: 'approve' })).toEqual({ status: 'PASSED' });
    const row = await profileRow(userId);
    expect(row!.audit_status).toBe('PASSED');
    expect(row!.audited_at).toBeInstanceOf(Date); // R-02 审核结论时刻
    expect(await service.isAuditPassed(userId)).toBe(true); // R-01 查询面翻转

    expect(await stlRows(userId)).toEqual([
      { from_status: 'DRAFT', to_status: 'SUBMITTED', allowed: true },
      { from_status: 'SUBMITTED', to_status: 'IN_REVIEW', allowed: true },
      { from_status: 'IN_REVIEW', to_status: 'PASSED', allowed: true },
    ]);

    const payloads = await outboxPayloads(LAWYER_AUDIT_PASSED_TOPIC);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      lawyer_user_id: userId,
      firm_id: null, // A3b 进件前为 null（T3 简报裁决；契约 firm_id: number|null）
    } satisfies LawyerAuditPassedPayload);
    expect(JSON.stringify(payloads)).not.toContain(LICENSE_A); // PII：载荷无 license 明文
  });

  it('拒绝（IN_REVIEW→REJECTED）：reject_reason 必填（缺省 400），落库留痕；出参/载荷不携带之外无 license 明文', async () => {
    const userId = await seedUser('reject');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' });

    await expect(service.audit(profileId, { action: 'reject' })).rejects.toMatchObject({
      code: ErrorCode.InvalidArgument,
      httpStatus: 400,
    });

    expect(
      await service.audit(profileId, { action: 'reject', rejectReason: '执业证照片模糊' }),
    ).toEqual({ status: 'REJECTED' });
    const row = await profileRow(userId);
    expect(row).toMatchObject({ audit_status: 'REJECTED', reject_reason: '执业证照片模糊' });
    expect(row!.audited_at).toBeInstanceOf(Date);
    expect(await stlRows(userId)).toEqual([
      { from_status: 'DRAFT', to_status: 'SUBMITTED', allowed: true },
      { from_status: 'SUBMITTED', to_status: 'IN_REVIEW', allowed: true },
      { from_status: 'IN_REVIEW', to_status: 'REJECTED', allowed: true },
    ]);
    expect(await service.isAuditPassed(userId)).toBe(false);
  });

  it('重提（REJECTED→SUBMITTED）：新材料版本=material_version 递增，qualification_files v2 新增且 v1 保留（审核留痕），reject_reason 清空', async () => {
    const userId = await seedUser('resubmit');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'reject', rejectReason: '授权书缺页' });
    const submittedAtV1 = (await profileRow(userId))!.submitted_at;

    const done = await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: LICENSE_A_FILES_V2,
    });
    expect(done).toEqual({ status: 'SUBMITTED', materialVersion: 2 });

    const row = await profileRow(userId);
    expect(row).toMatchObject({
      audit_status: 'SUBMITTED',
      material_version: 2,
      reject_reason: null,
    });
    expect(row!.submitted_at!.getTime()).toBeGreaterThanOrEqual(submittedAtV1!.getTime()); // R-02 重提刷新
    expect(await fileRows(profileId)).toEqual([
      { material_version: 1, kind: 'LICENSE_PHOTO', file_ref: 'spec/oss/license-a-v1.jpg' },
      { material_version: 1, kind: 'FIRM_AUTHORIZATION', file_ref: 'spec/oss/auth-a-v1.pdf' },
      { material_version: 2, kind: 'LICENSE_PHOTO', file_ref: 'spec/oss/license-a-v2.jpg' },
      { material_version: 2, kind: 'FIRM_AUTHORIZATION', file_ref: 'spec/oss/auth-a-v2.pdf' },
    ]);
    expect(await stlRows(userId)).toEqual([
      { from_status: 'DRAFT', to_status: 'SUBMITTED', allowed: true },
      { from_status: 'SUBMITTED', to_status: 'IN_REVIEW', allowed: true },
      { from_status: 'IN_REVIEW', to_status: 'REJECTED', allowed: true },
      { from_status: 'REJECTED', to_status: 'SUBMITTED', allowed: true },
    ]);
  });

  it('重提材料未变更 → 409 Conflict（§4 守卫：重提需新材料版本，同材料不构成新版本）', async () => {
    const userId = await seedUser('samematerial');
    const materials = {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    };
    await service.submitQualification(userId, materials);
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'reject', rejectReason: '材料待补' });

    await expect(service.submitQualification(userId, materials)).rejects.toMatchObject({
      code: ErrorCode.Conflict,
      httpStatus: 409,
    });
    expect((await profileRow(userId))!.material_version).toBe(1); // 未产生新版本
  });

  it('PASSED 后材料修改（PASSED→SUBMITTED）：重新进审核、isAuditPassed 翻 false，复审通过再发 LawyerAuditPassed（两次事件）', async () => {
    const userId = await seedUser('revision');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'approve' });
    expect(await service.isAuditPassed(userId)).toBe(true);

    const done = await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所（分所）',
      files: LICENSE_A_FILES_V2,
    });
    expect(done).toEqual({ status: 'SUBMITTED', materialVersion: 2 });
    expect((await profileRow(userId))!.audit_status).toBe('SUBMITTED');
    expect(await service.isAuditPassed(userId)).toBe(false); // 材料修改后回到未过审语义（R-01）

    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'approve' });
    expect(await service.isAuditPassed(userId)).toBe(true);

    const payloads = await outboxPayloads(LAWYER_AUDIT_PASSED_TOPIC);
    expect(payloads).toHaveLength(2);
    expect(await stlRows(userId)).toEqual([
      { from_status: 'DRAFT', to_status: 'SUBMITTED', allowed: true },
      { from_status: 'SUBMITTED', to_status: 'IN_REVIEW', allowed: true },
      { from_status: 'IN_REVIEW', to_status: 'PASSED', allowed: true },
      { from_status: 'PASSED', to_status: 'SUBMITTED', allowed: true },
      { from_status: 'SUBMITTED', to_status: 'IN_REVIEW', allowed: true },
      { from_status: 'IN_REVIEW', to_status: 'PASSED', allowed: true },
    ]);
  });

  it('停用/恢复（PASSED→SUSPENDED→PASSED）：LawyerSuspended 载荷 {lawyer_user_id, reason}，恢复无事件，isAuditPassed 随之翻转', async () => {
    const userId = await seedUser('suspend');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'approve' });

    expect(await service.audit(profileId, { action: 'suspend', reason: '投诉核查中' })).toEqual({
      status: 'SUSPENDED',
    });
    expect((await profileRow(userId))!.audit_status).toBe('SUSPENDED');
    expect(await service.isAuditPassed(userId)).toBe(false);

    const suspended = await outboxPayloads(LAWYER_SUSPENDED_TOPIC);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toEqual({
      lawyer_user_id: userId,
      reason: '投诉核查中',
    } satisfies LawyerSuspendedPayload);

    expect(await service.audit(profileId, { action: 'resume' })).toEqual({ status: 'PASSED' });
    expect(await service.isAuditPassed(userId)).toBe(true);
    expect(await outboxPayloads(LAWYER_SUSPENDED_TOPIC)).toHaveLength(1); // 恢复不发事件（§6 仅两个生产事件）
    expect(await stlRows(userId)).toEqual([
      { from_status: 'DRAFT', to_status: 'SUBMITTED', allowed: true },
      { from_status: 'SUBMITTED', to_status: 'IN_REVIEW', allowed: true },
      { from_status: 'IN_REVIEW', to_status: 'PASSED', allowed: true },
      { from_status: 'PASSED', to_status: 'SUSPENDED', allowed: true },
      { from_status: 'SUSPENDED', to_status: 'PASSED', allowed: true },
    ]);
  });

  it('非法迁移被守卫拒绝并留痕（§10-2）：SUBMITTED 直接 approve 409 且 STL allowed=false；SUSPENDED 中提交同样拒绝', async () => {
    const userId = await seedUser('illegal');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);

    // 越过领取直接通过：守卫拒绝 + 拒绝留痕（独立连接，不随业务回滚）
    await expect(service.audit(profileId, { action: 'approve' })).rejects.toMatchObject({
      code: ErrorCode.StateIllegalTransition,
      httpStatus: 409,
    });
    const denied = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log
        WHERE entity_type = 'identity_lawyer_profile' AND entity_id = $1 ORDER BY id`,
      [userId],
    );
    expect(denied.rows).toEqual([{ allowed: true }, { allowed: false }]); // 提交留痕 + 越权拒绝留痕
    expect((await profileRow(userId))!.audit_status).toBe('SUBMITTED'); // 状态未被改写

    // SUSPENDED 无 SUBMITTED 出边：提交请求被守卫拒绝（非法迁移留痕 +1）
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'approve' });
    await service.audit(profileId, { action: 'suspend', reason: '核查' });
    await expect(
      service.submitQualification(userId, {
        licenseNo: LICENSE_A,
        firmName: '北京测试律师事务所',
        files: LICENSE_A_FILES_V2,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateIllegalTransition, httpStatus: 409 });
    expect((await profileRow(userId))!.audit_status).toBe('SUSPENDED');
    expect(
      (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM platform.state_transition_log
        WHERE entity_type = 'identity_lawyer_profile' AND entity_id = $1 AND allowed = false`,
          [userId],
        )
      ).rows[0]!.n,
    ).toBe(2);
  });

  it('license 唯一竞窗（23505 显式校验）：预检放行后他人并发占用 → 败退方 409 E_LICENSE_NO_TAKEN（显式校验不吞错），无幽灵留痕', async () => {
    const userA = await seedUser('raceA');
    const userB = await seedUser('raceB');
    const client = await pool.connect();
    try {
      // 竞争者：未提交的他人占用行——对 service 预检不可见，但独占盲索引唯一位
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO identity.lawyer_profiles
           (user_id, license_no_enc, license_no_blind_idx, material_version, material_fingerprint, audit_status, submitted_at)
         VALUES ($1, $2, $3, 1, $4, 'SUBMITTED', now())`,
        [userB, Buffer.from('competitor'), crypto.blindIndex(LICENSE_A), '0'.repeat(64)],
      );

      const pending = service.submitQualification(userA, {
        licenseNo: LICENSE_A,
        firmName: '北京测试律师事务所',
        files: licenseFilesV1('a'),
      });
      await waitForBlockedInsert(pool); // service 的 INSERT 阻塞在唯一索引上（条件等待）
      await client.query('COMMIT');

      await expect(pending).rejects.toMatchObject({
        code: ErrorCode.LicenseNoTaken,
        httpStatus: 409,
      });
      expect(await profileRow(userA)).toBeUndefined(); // 败退方整体回滚：无行
      expect(await stlRows(userA)).toEqual([]); // 无幽灵守卫留痕
    } finally {
      client.release();
    }
  });

  it('A1 授角闭环（真事件→真消费端）：提交→领取→通过→outbox→A1 消费端→user_roles 含 user+lawyer 双行（R-04）', async () => {
    const userId = await seedUser('loop');
    // R-04 前置：律师账号默认具备 user 身份（A1 注册即授，这里以同形态落底）
    await pool.query("INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'user')", [
      userId,
    ]);
    // A1 消费端真实注册路径（IdentityUserConsumer.onModuleInit——进程内同款）
    new IdentityUserConsumer(relay, guard).onModuleInit();

    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'approve' });

    expect((await relay.tick()).dispatched).toBe(1); // LawyerAuditPassed 真实投递
    const roles = await pool.query<{ role: string }>(
      'SELECT role FROM identity.user_roles WHERE user_id = $1 ORDER BY role',
      [userId],
    );
    expect(roles.rows.map((r) => r.role)).toEqual(['lawyer', 'user']); // 双行（R-02/R-04）

    // at-least-once 重投：PK 幂等，仍单份双行
    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE topic = $1`,
      [LAWYER_AUDIT_PASSED_TOPIC],
    );
    expect((await relay.tick()).dispatched).toBe(1);
    expect(
      (
        await pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM identity.user_roles WHERE user_id = $1',
          [userId],
        )
      ).rows[0]!.n,
    ).toBe(2);
  });

  it('PII 红线：全流程后日志、事件载荷、DB 文本列均无 license_no 明文（非空前置防假绿）', async () => {
    const userId = await seedUser('pii');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'reject', rejectReason: '照片模糊' });
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京测试律师事务所',
      files: LICENSE_A_FILES_V2,
    });
    await service.audit(profileId, { action: 'claim' });
    await service.audit(profileId, { action: 'approve' });
    await service.audit(profileId, { action: 'suspend', reason: '核查' });
    expect(await service.auditStatus(userId)).toMatchObject({ status: 'SUSPENDED' });

    // 日志非空前置：流程确有日志产出，否定断言才非空转
    const logged = logCalls.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).not.toBe('');
    expect(logged).not.toContain(LICENSE_A);

    // 事件载荷：两类事件均无明文
    const passed = await outboxPayloads(LAWYER_AUDIT_PASSED_TOPIC);
    const suspended = await outboxPayloads(LAWYER_SUSPENDED_TOPIC);
    expect(passed.length).toBeGreaterThan(0);
    expect(suspended.length).toBeGreaterThan(0);
    expect(JSON.stringify([...passed, ...suspended])).not.toContain(LICENSE_A);

    // DB 文本列（盲索引/指纹/reject_reason/kind/file_ref/firm_name）无明文
    const texts = await pool.query<{ text: string }>(
      `SELECT (license_no_blind_idx || '|' || material_fingerprint || '|' || coalesce(reject_reason, '')
              || '|' || coalesce(firm_name, '')) AS text FROM identity.lawyer_profiles`,
    );
    for (const row of texts.rows) expect(row.text).not.toContain(LICENSE_A);
    const fileTexts = await pool.query<{ text: string }>(
      "SELECT (kind || '|' || file_ref) AS text FROM identity.qualification_files",
    );
    for (const row of fileTexts.rows) expect(row.text).not.toContain(LICENSE_A);
  });

  // ---------- W3 T10：H1 导出面（G-A R-W2-G auditor_id 回填绑定 + 工作台/档案只读导出） ----------

  it('H1 导出面（R-W2-G 绑定项）：audit 带 auditorId → lawyer_profiles.auditor_id 落值（claim/approve/reject/suspend/resume 全动作）；存量服务级调用不传保持 NULL 兼容', async () => {
    const userId = await seedUser('auditor');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京审计律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);

    // 未传 auditorId（既有服务级内部调用形态）→ NULL 兼容（历史行为不变）
    await service.audit(profileId, { action: 'claim' });
    expect((await profileRow(userId))!.auditor_id).toBeNull();

    // admin 面透传（H1 ops 控制器恒传 claims userId）→ 每个动作都回填
    await service.audit(profileId, { action: 'approve' }, 9001);
    expect((await profileRow(userId))!.auditor_id).toBe('9001');
    await service.audit(profileId, { action: 'suspend', reason: '投诉核查' }, 9002);
    expect((await profileRow(userId))!.auditor_id).toBe('9002');
    await service.audit(profileId, { action: 'resume' }, 9001);
    expect((await profileRow(userId))!.auditor_id).toBe('9001');

    // reject 链同样落值
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京审计律师事务所',
      files: LICENSE_A_FILES_V2,
    });
    const profileId2 = Number((await profileRow(userId))!.id);
    await service.audit(profileId2, { action: 'claim' }, 9003);
    await service.audit(profileId2, { action: 'reject', rejectReason: '材料模糊' }, 9003);
    expect((await profileRow(userId))!.auditor_id).toBe('9003');
  });

  it('H1 导出面：auditWithExecutor 外部事务变体——事务内可见、回滚即消失（H1 同事务落 ops 域审计表的缝合点）', async () => {
    const userId = await seedUser('uow');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京缝合律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    const poolSvc = app.get(PgPoolService);

    // 事务内迁移经同一连接可见（uow 读侧=H1 同事务缝合点）；回滚后状态还原
    await expect(
      poolSvc.withTransaction(async (uow) => {
        const done = await service.auditWithExecutor(uow, profileId, { action: 'claim' }, 9001);
        expect(done.status).toBe('IN_REVIEW');
        const inTx = await uow.query<{ audit_status: string }>(
          'SELECT audit_status FROM identity.lawyer_profiles WHERE user_id = $1',
          [userId],
        );
        expect(inTx.rows[0]!.audit_status).toBe('IN_REVIEW');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await profileRow(userId))!.audit_status).toBe('SUBMITTED');

    // 正常提交路径：外部事务 + auditorId 落值
    await poolSvc.withTransaction((uow) =>
      service.auditWithExecutor(uow, profileId, { action: 'claim' }, 9001),
    );
    expect((await profileRow(userId))!.audit_status).toBe('IN_REVIEW');
    expect((await profileRow(userId))!.auditor_id).toBe('9001');
  });

  it('H1 工作台导出面：listSubmissions 提交时间排序（ASC=最久在审在前）+status 过滤+分页（total/items）', async () => {
    const u1 = await seedUser('q1');
    const u2 = await seedUser('q2');
    const u3 = await seedUser('q3');
    await service.submitQualification(u1, { licenseNo: LICENSE_A, files: licenseFilesV1('a') });
    await service.submitQualification(u2, {
      licenseNo: 'LICENSE-SPEC-0002',
      files: licenseFilesV1('b'),
    });
    await service.submitQualification(u3, {
      licenseNo: 'LICENSE-SPEC-0003',
      files: licenseFilesV1('c'),
    });

    // 默认=审核队列（SUBMITTED|IN_REVIEW），提交时间 ASC
    const queue = await service.listSubmissions({});
    expect(queue.total).toBe(3);
    expect(queue.items.map((i) => i.lawyer_user_id)).toEqual([u1, u2, u3]);
    expect(queue.items[0]).toMatchObject({
      audit_status: 'SUBMITTED',
      material_version: 1,
    });
    expect(typeof queue.items[0]!.id).toBe('number');

    // u1 领取后：status=IN_REVIEW 单过滤仍含；PASSED 过滤不含
    const p1 = Number((await profileRow(u1))!.id);
    await service.audit(p1, { action: 'claim' }, 9001);
    const inReview = await service.listSubmissions({ statuses: ['IN_REVIEW'] });
    expect(inReview.items.map((i) => i.lawyer_user_id)).toEqual([u1]);
    const passed = await service.listSubmissions({ statuses: ['PASSED'] });
    expect(passed.total).toBe(0);

    // 分页：page=2 pageSize=2 → 恰剩 1 条；越界页空
    const page2 = await service.listSubmissions({ page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.total).toBe(3);
    expect((await service.listSubmissions({ page: 9, pageSize: 2 })).items).toEqual([]);
  });

  it('H1 档案导出面：profileViewById 返回资质状态/用户/律所/材料版本/时刻/auditor_id（无 license 字段=PII 红线）；未知 id → undefined', async () => {
    const userId = await seedUser('view');
    await service.submitQualification(userId, {
      licenseNo: LICENSE_A,
      firmName: '北京档案律师事务所',
      files: licenseFilesV1('a'),
    });
    const profileId = Number((await profileRow(userId))!.id);
    await service.audit(profileId, { action: 'claim' }, 9001);

    const view = await service.profileViewById(profileId);
    expect(view).toMatchObject({
      id: profileId,
      lawyer_user_id: userId,
      audit_status: 'IN_REVIEW',
      firm_name: '北京档案律师事务所',
      firm_id: null,
      material_version: 1,
      auditor_id: 9001,
      submitted_at: expect.any(String),
    });
    expect(JSON.stringify(view)).not.toContain(LICENSE_A); // PII 红线：导出面无明文证号字段
    expect(await service.profileViewById(999999)).toBeUndefined();
  });
});

/** 确定性交错原语：轮询 pg_stat_activity 等 service 的 INSERT 阻塞在锁上（consent.spec 同款） */
async function waitForBlockedInsert(pool: Pool): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO identity.lawyer_profiles%'`,
    );
    if ((res.rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        'service 未在 5s 内阻塞到 identity.lawyer_profiles 的 INSERT（交错前提不成立）',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
