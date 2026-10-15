import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import {
  ErrorCode,
  TRAINING_CONSENT_GRANTED_TOPIC,
  TRAINING_CONSENT_REVOKED_TOPIC,
  type TrainingConsentGrantedPayload,
  type TrainingConsentRevokedPayload,
} from '@ljr/shared';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { PgPoolService } from '../../infrastructure/sql';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { IDENTITY_CONFIG, type IdentityConfig } from './identity.config';
import { CONSENT_CONFIG, type ConsentConfig } from './consent.config';
import { CONSENT_MACHINE } from './consent.machine';
import { RealnameConsentModule } from './realname-consent.module';
import { ConsentService } from './consent.service';

/**
 * A2 同意领域层 e2e（需 PG）：授权状态机（ABSENT→GRANTED→REVOKED，可再 GRANTED=新行，
 * 经守卫+STL）、R-W2-6 版本闸（409 VERSION_MISMATCH）、R-02 拒绝路径（不写行不留痕）、
 * 幂等（同版本重复授权返回现值；重复撤回短路；撤回后同版本可重新授权——§10-5 活跃态唯一；
 * 跨版本授权各版本独立幂等=评审 Important-2）、并发败退幂等读回（SAVEPOINT=评审 Important-1）。
 */

const CURRENT_POLICY = 'v1.0.0';
/** 运营升版后的新有效版本（跨版本用例以独立 service handle 模拟配置切换=重新部署） */
const NEXT_POLICY = 'v2.0.0';

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: randomBytes(32),
  phoneBlindPepper: randomBytes(32).toString('hex'),
  jwtSecret: randomBytes(32).toString('hex'),
});

describe('A2 同意领域层（训练授权/撤回/幂等/版本闸，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let service: ConsentService;
  let guard: StateTransitionGuardService;

  async function consentRows(userId: number): Promise<
    {
      id: string;
      status: string;
      policy_version: string;
      granted_at: Date | null;
      revoked_at: Date | null;
    }[]
  > {
    const res = await pool.query<{
      id: string;
      status: string;
      policy_version: string;
      granted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, status, policy_version, granted_at, revoked_at FROM identity.consents
        WHERE user_id = $1 AND scope = 'training' ORDER BY id`,
      [userId],
    );
    return res.rows;
  }

  async function stlRows(
    entityId: number,
  ): Promise<{ from_status: string; to_status: string; allowed: boolean }[]> {
    const res = await pool.query<{
      from_status: string;
      to_status: string;
      allowed: boolean;
    }>(
      `SELECT from_status, to_status, allowed FROM platform.state_transition_log
        WHERE entity_type = 'identity_consent' AND entity_id = $1 ORDER BY id`,
      [entityId],
    );
    return res.rows;
  }

  async function outboxCount(topic: string): Promise<number> {
    const res = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1',
      [topic],
    );
    return res.rows[0]?.n ?? 0;
  }

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [RealnameConsentModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(CONSENT_CONFIG)
      .useValue({ trainingPolicyVersion: CURRENT_POLICY } satisfies ConsentConfig)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = app.get(ConsentService);
    guard = app.get(StateTransitionGuardService);
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

  it('状态机矩阵（§4）：ABSENT→GRANTED / GRANTED→REVOKED / REVOKED→GRANTED 可过；ABSENT→REVOKED 拒绝', () => {
    expect(CONSENT_MACHINE.canTransition('ABSENT', 'GRANTED')).toBe(true);
    expect(CONSENT_MACHINE.canTransition('GRANTED', 'REVOKED')).toBe(true);
    expect(CONSENT_MACHINE.canTransition('REVOKED', 'GRANTED')).toBe(true);
    expect(CONSENT_MACHINE.canTransition('ABSENT', 'REVOKED')).toBe(false);
    expect(CONSENT_MACHINE.canTransition('GRANTED', 'GRANTED')).toBe(false);
    expect(() => CONSENT_MACHINE.assertTransition('ABSENT', 'REVOKED')).toThrowError(
      /非法状态迁移 ABSENT → REVOKED/,
    );
  });

  it('R-02 授权：ABSENT→GRANTED 守卫留痕；落行（GRANTED/policy/granted_at）；TrainingConsentGranted 同事务（无 room_ids）', async () => {
    const done = await service.grantTraining(601, { policyVersion: CURRENT_POLICY, accept: true });
    expect(done.status).toBe('GRANTED');
    expect(done.policyVersion).toBe(CURRENT_POLICY);
    expect(done.grantedAt).toBeInstanceOf(Date);

    expect(await stlRows(601)).toEqual([
      { from_status: 'ABSENT', to_status: 'GRANTED', allowed: true },
    ]);
    const rows = await consentRows(601);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'GRANTED', policy_version: CURRENT_POLICY });

    const evt = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1',
      [TRAINING_CONSENT_GRANTED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]?.payload).toEqual({
      user_id: 601,
      policy_version: CURRENT_POLICY,
    } satisfies TrainingConsentGrantedPayload); // room_ids 缺省（本接口无房间上下文）
  });

  it('R-W2-6 版本闸：policy_version ≠ 当前有效值 → 409 VERSION_MISMATCH，且不写行/不留痕/不发事件（守卫前拒绝）', async () => {
    await expect(
      service.grantTraining(602, { policyVersion: 'v0.9.0', accept: true }),
    ).rejects.toMatchObject({ code: ErrorCode.VersionMismatch, httpStatus: 409 });
    await expect(
      service.grantTraining(602, { policyVersion: 'v0.9.0', accept: false }),
    ).rejects.toMatchObject({ code: ErrorCode.VersionMismatch });
    expect(await consentRows(602)).toEqual([]);
    expect(await stlRows(602)).toEqual([]);
    expect(await outboxCount(TRAINING_CONSENT_GRANTED_TOPIC)).toBe(0);
  });

  it('R-02 拒绝路径：accept=false → {status:ABSENT}，不写行/不留痕/不发事件——拒绝不降级（未授权即 ABSENT）', async () => {
    const done = await service.grantTraining(603, { policyVersion: CURRENT_POLICY, accept: false });
    expect(done).toEqual({ status: 'ABSENT', policyVersion: CURRENT_POLICY });
    expect(await consentRows(603)).toEqual([]);
    expect(await stlRows(603)).toEqual([]);
    expect(await outboxCount(TRAINING_CONSENT_GRANTED_TOPIC)).toBe(0);
  });

  it('幂等键=user+policy_version：同版本重复授权返回现值（同 granted_at），不新增行/留痕/事件（§10-5 前半）', async () => {
    const first = await service.grantTraining(604, { policyVersion: CURRENT_POLICY, accept: true });
    const second = await service.grantTraining(604, {
      policyVersion: CURRENT_POLICY,
      accept: true,
    });
    expect(second.status).toBe('GRANTED');
    expect(second.grantedAt).toEqual(first.grantedAt);
    expect(await consentRows(604)).toHaveLength(1);
    expect(await stlRows(604)).toHaveLength(1);
    expect(await outboxCount(TRAINING_CONSENT_GRANTED_TOPIC)).toBe(1);
  });

  it('撤回：GRANTED→REVOKED 守卫留痕，原行原位 UPDATE（id 不变），TrainingConsentRevoked 载荷带 ISO revoked_at；重复撤回幂等短路', async () => {
    await service.grantTraining(605, { policyVersion: CURRENT_POLICY, accept: true });
    const before = (await consentRows(605))[0]!;

    const revoked = await service.revokeTraining(605);
    expect(revoked.status).toBe('REVOKED');
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(await stlRows(605)).toEqual([
      { from_status: 'ABSENT', to_status: 'GRANTED', allowed: true },
      { from_status: 'GRANTED', to_status: 'REVOKED', allowed: true },
    ]);
    const after = await consentRows(605);
    expect(after).toHaveLength(1); // 原行原位
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]).toMatchObject({ status: 'REVOKED', policy_version: CURRENT_POLICY });

    const evt = await pool.query<{ payload: unknown }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1',
      [TRAINING_CONSENT_REVOKED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    const payload = evt.rows[0]?.payload as TrainingConsentRevokedPayload;
    expect(payload.user_id).toBe(605);
    expect(payload.revoked_at).toBe(revoked.revokedAt!.toISOString());

    // 重复撤回幂等：返回现值、无二次留痕/事件
    const again = await service.revokeTraining(605);
    expect(again.status).toBe('REVOKED');
    expect(again.revokedAt).toEqual(revoked.revokedAt);
    expect(await stlRows(605)).toHaveLength(2);
    expect(await outboxCount(TRAINING_CONSENT_REVOKED_TOPIC)).toBe(1);
  });

  it('撤回后同版本可重新授权（§10-5 后半）：REVOKED→GRANTED 新行，旧行保持 REVOKED，事件再发', async () => {
    const first = await service.grantTraining(606, { policyVersion: CURRENT_POLICY, accept: true });
    await service.revokeTraining(606);

    const reGrant = await service.grantTraining(606, {
      policyVersion: CURRENT_POLICY,
      accept: true,
    });
    expect(reGrant.status).toBe('GRANTED');
    expect(reGrant.grantedAt!.getTime()).toBeGreaterThanOrEqual(first.grantedAt!.getTime());

    const rows = await consentRows(606);
    expect(rows).toHaveLength(2); // 可再 GRANTED=新行
    expect(rows[0]).toMatchObject({ status: 'REVOKED' }); // 旧行原样保留
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ status: 'GRANTED', policy_version: CURRENT_POLICY });
    expect(await stlRows(606)).toEqual([
      { from_status: 'ABSENT', to_status: 'GRANTED', allowed: true },
      { from_status: 'GRANTED', to_status: 'REVOKED', allowed: true },
      { from_status: 'REVOKED', to_status: 'GRANTED', allowed: true },
    ]);
    expect(await outboxCount(TRAINING_CONSENT_GRANTED_TOPIC)).toBe(2);
    expect(await outboxCount(TRAINING_CONSENT_REVOKED_TOPIC)).toBe(1);

    // 现行状态=最新行：撤回/重授后查询面视角
    expect(await service.trainingConsentStatus(606)).toMatchObject({
      status: 'GRANTED',
      policyVersion: CURRENT_POLICY,
    });
  });

  it('未授权撤回幂等：无行 → {status:ABSENT} 无留痕无事件；授权查询面（§2 设置中心）ABSENT→GRANTED→REVOKED 全程可视', async () => {
    expect(await service.revokeTraining(607)).toEqual({ status: 'ABSENT' });
    expect(await stlRows(607)).toEqual([]);
    expect(await outboxCount(TRAINING_CONSENT_REVOKED_TOPIC)).toBe(0);

    expect(await service.trainingConsentStatus(607)).toEqual({ status: 'ABSENT' });
    const granted = await service.grantTraining(607, {
      policyVersion: CURRENT_POLICY,
      accept: true,
    });
    expect(await service.trainingConsentStatus(607)).toEqual({
      status: 'GRANTED',
      policyVersion: CURRENT_POLICY,
      grantedAt: granted.grantedAt,
    });
    const revoked = await service.revokeTraining(607);
    expect(await service.trainingConsentStatus(607)).toEqual({
      status: 'REVOKED',
      policyVersion: CURRENT_POLICY,
      grantedAt: granted.grantedAt,
      revokedAt: revoked.revokedAt,
    });
  });

  it('非法迁移拒绝+留痕（计划红线）：守卫对 ABSENT→REVOKED 写 allowed=false 后抛 409', async () => {
    await expect(
      guard.assertTransition(CONSENT_MACHINE, {
        entityId: 608,
        from: 'ABSENT',
        to: 'REVOKED',
        reason: 'spec: 越过授予直接撤回',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateIllegalTransition, httpStatus: 409 });
    const denied = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log
        WHERE entity_type = 'identity_consent' AND entity_id = 608`,
    );
    expect(denied.rows).toEqual([{ allowed: false }]);
  });

  it('跨版本授权（评审 Important-2）：GRANTED(v1)→accept(v2) 新行+事件+返回 v2、旧行不动；再 accept(v1) 幂等返回 v1 现值', async () => {
    // 升版=配置切换（重新部署）：以独立 service handle 携带 v2 有效版本，版本闸语义不变
    const upgraded = new ConsentService(app.get(PgPoolService), app.get(OutboxService), guard, {
      trainingPolicyVersion: NEXT_POLICY,
    } satisfies ConsentConfig);

    const v1 = await service.grantTraining(702, { policyVersion: CURRENT_POLICY, accept: true });
    const v2 = await upgraded.grantTraining(702, { policyVersion: NEXT_POLICY, accept: true });
    expect(v2.status).toBe('GRANTED');
    expect(v2.policyVersion).toBe(NEXT_POLICY); // 返回新版本（修复前被旧版幂等短路吞掉返回 v1）

    const rows = await consentRows(702);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'GRANTED', policy_version: CURRENT_POLICY }); // 旧行不动
    expect(rows[1]).toMatchObject({ status: 'GRANTED', policy_version: NEXT_POLICY });

    // 每个版本独立事件（R-03/D5 按版本链路不因升版断裂）
    const events = await pool.query<{ payload: TrainingConsentGrantedPayload }>(
      'SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id',
      [TRAINING_CONSENT_GRANTED_TOPIC],
    );
    expect(events.rows.map((r) => r.payload.policy_version)).toEqual([CURRENT_POLICY, NEXT_POLICY]);
    // v2 为版本实体首授：from=ABSENT（reason 携带 policy 消歧），两笔均守卫留痕
    expect(await stlRows(702)).toEqual([
      { from_status: 'ABSENT', to_status: 'GRANTED', allowed: true },
      { from_status: 'ABSENT', to_status: 'GRANTED', allowed: true },
    ]);

    // 再 accept(v1)：v1 版本域活跃行仍在 → 幂等返回 v1 现值（修复前按最新行短路会错回 v2）
    const againV1 = await service.grantTraining(702, {
      policyVersion: CURRENT_POLICY,
      accept: true,
    });
    expect(againV1.policyVersion).toBe(CURRENT_POLICY);
    expect(againV1.grantedAt).toEqual(v1.grantedAt);
    expect(await consentRows(702)).toHaveLength(2);
    expect(await outboxCount(TRAINING_CONSENT_GRANTED_TOPIC)).toBe(2);
  });

  it('跨版本后「当前同意」取最新 GRANTED 行（评审 Important-2）：状态查询返回 v2；撤回 v2 后回退展示 v1 活跃授权', async () => {
    const v1 = await service.grantTraining(703, { policyVersion: CURRENT_POLICY, accept: true });
    const upgraded = new ConsentService(app.get(PgPoolService), app.get(OutboxService), guard, {
      trainingPolicyVersion: NEXT_POLICY,
    } satisfies ConsentConfig);
    await upgraded.grantTraining(703, { policyVersion: NEXT_POLICY, accept: true });
    expect(await service.trainingConsentStatus(703)).toMatchObject({
      status: 'GRANTED',
      policyVersion: NEXT_POLICY,
    });

    // 撤回只动最新行（旧行不动=文档未定义跨版本撤销语义，不发明）：v1 仍活跃 → 视图回退展示 v1
    await upgraded.revokeTraining(703);
    expect(await service.trainingConsentStatus(703)).toMatchObject({
      status: 'GRANTED',
      policyVersion: CURRENT_POLICY,
      grantedAt: v1.grantedAt,
    });
  });

  it('并发败退幂等读回（评审 Important-1）：受控交错迫使 INSERT 命中 ux_consent_active 23505，SAVEPOINT 回退后同事务读回现值（25P02 不再冒出）', async () => {
    const client = await pool.connect();
    try {
      // 竞争者：未提交的活跃授权——对 service 事务不可见（预检必放行），但独占唯一索引等待位
      await client.query('BEGIN');
      const competitorAt = new Date();
      await client.query(
        `INSERT INTO identity.consents (user_id, scope, status, policy_version, granted_at)
         VALUES (704, 'training', 'GRANTED', $1, $2)`,
        [CURRENT_POLICY, competitorAt],
      );

      const pending = service.grantTraining(704, { policyVersion: CURRENT_POLICY, accept: true });
      // 确定性交错：service 的 INSERT 阻塞在锁上（预检已过）才放行竞争者——条件等待非固定睡眠
      await waitForBlockedInsert(pool, 'consents');
      await client.query('COMMIT');

      const result = await pending; // 修复前：此处抛 25P02（in failed transaction）→ 500 类错误
      expect(result.status).toBe('GRANTED');
      expect(result.policyVersion).toBe(CURRENT_POLICY);
      expect(result.grantedAt).toEqual(competitorAt); // 幂等读回=首访（竞争者）现值，非本方 now()
      expect(await consentRows(704)).toHaveLength(1);
      expect(await stlRows(704)).toHaveLength(1); // 守卫痕在 SAVEPOINT 之前，败退 INSERT 无痕
      expect(await outboxCount(TRAINING_CONSENT_GRANTED_TOPIC)).toBe(0); // 事件归属首访事务，败退方不发
    } finally {
      client.release();
    }
  });
});

/** 确定性交错原语：轮询 pg_stat_activity 等 service 的 INSERT 阻塞在锁上（最长 5s，条件等待） */
async function waitForBlockedInsert(pool: Pool, table: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const res = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE $1`,
      [`%INSERT INTO identity.${table}%`],
    );
    if ((res.rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`service 未在 5s 内阻塞到 identity.${table} 的 INSERT（交错前提不成立）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
