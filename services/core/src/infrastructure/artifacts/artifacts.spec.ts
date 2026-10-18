import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ARTIFACT_PURGED_TOPIC, ErrorCode, RECORDING_ARCHIVED_TOPIC } from '@ljr/shared';
import { ensureTestDatabase, truncateAll } from '../testing/db';
import { PgPoolService } from '../sql';
import { IDENTITY_CONFIG, type IdentityConfig } from '../../modules/identity/identity.config';
import { grantUserRoles, seedUserShell } from '../../modules/identity/lawyer-fixture';
import { IdentityTokenService } from '../../modules/identity/identity.token.service';
import { SchedulerService } from '../../modules/schedule/scheduler.service';
import { ARTIFACT_STORE, ArtifactStoreError, LocalFsArtifactStore } from './artifact-store';
import { ArtifactsJobExecutors } from './artifacts.executors';
import { ArtifactsModule } from './artifacts.module';
import { ArtifactsService } from './artifacts.service';
import { MockEvidenceChain } from './evidence-chain';

/**
 * I3 文件与存证存储（需 PG；M2-W1 T2——W1 可验段全量，I3 §10 验收四项+边界；评审修复环 I/M 增量）：
 *   ① putArtifact 幂等（hash 幂等键：同 bytes 二次调用返回既有行 deduplicated=true，存储单文件；
 *     跨 ref 通用面语义=M-6 characterization）+retentionUntil 日历有效性（M-5）；
 *   ② WORM 写保护（存储层断言：recordings 对象覆写被拒+删除被拒；同 ref 不同 bytes=新行新 hash 合法；
 *     原子写恢复 I-1：崩溃残留半截（前缀）重放同 bytes 经 tmp+rename 覆盖恢复）；
 *   ③ archiveRecording 全链（SHA-256 可验证+evidence_id 关联订单+RecordingArchived 出箱+重放幂等；
 *     跨 ref 归档=显式 409 Conflict I-2——防凭证关联错订单）；
 *   ④ RETENTION_PURGE 到期作业（=当天放行/=明天零动作/重跑零新事件/执行器自投下一周期；
 *     逐行隔离 I-3：毒对象单行失败不连坐、毒行不丢下轮重扫可见）；
 *   ⑤ 审批调取面（未审批 403/单签 403/双签 200/无凭证 404/CHECK 禁同人 DB 拒/非 admin 403）；
 *   ⑥ KIND_POLICY 分级管控（credential 仅 identity 域/recon_file 仅 payment 域；credentials 禁明文落盘）。
 * 驱动：测试存储根=os.tmpdir() 子目录（勿污染仓库 var/）；调度器不自启动，手动 tick。
 */

const sha256hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const testIdentityConfig = (): IdentityConfig => ({
  phoneDataKey: createHash('sha256').update('spec').digest(),
  phoneBlindPepper: 'spec-pepper',
  jwtSecret: 'spec-jwt-secret',
});

/** 递归列出存储根下全部文件（相对路径）——「存储目录单文件/对象已删」断言锚 */
const listFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  };
  walk(root);
  return out.sort();
};

/** 清空存储根文件（truncateAll 只清 DB——FS 侧测试隔离用例自扫） */
const clearStoreDir = (root: string): void => {
  for (const rel of listFiles(root)) unlinkSync(path.join(root, rel));
};

describe('I3 文件与存证存储（幂等/WORM/上链/到期/审批/分级，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let tmpDir: string;
  let store: LocalFsArtifactStore;
  let artifacts: ArtifactsService;
  let executors: ArtifactsJobExecutors;
  let scheduler: SchedulerService;
  let poolSvc: PgPoolService;
  let tokens: IdentityTokenService;
  let evidenceChain: MockEvidenceChain;

  const outboxPayloads = async (topic: string): Promise<Record<string, unknown>[]> => {
    const res = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM platform.outbox WHERE topic = $1 ORDER BY id`,
      [topic],
    );
    return res.rows.map((r) => r.payload);
  };

  /** DB 钟当日偏移（Asia/Shanghai）——到期边界用例（=当天/=明天）与 DB 判定同时钟，零时区漂移 */
  const dbDate = async (offsetDays = 0): Promise<string> => {
    const res = await pool.query<{ d: string }>(`SELECT (CURRENT_DATE + $1::int)::text AS d`, [
      offsetDays,
    ]);
    return res.rows[0]!.d;
  };

  const artifactRow = async (id: number) => {
    const res = await pool.query<{
      kind: string;
      ref_type: string;
      ref_id: string;
      bucket: string;
      object_key: string;
      hash_sha256: string;
      evidence_id: string | null;
      retention_until: string;
      purged_at: Date | null;
    }>(
      `SELECT kind, ref_type, ref_id, bucket, object_key, hash_sha256, evidence_id,
              retention_until::text AS retention_until, purged_at
         FROM platform.artifacts WHERE id = $1`,
      [id],
    );
    return res.rows[0];
  };

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ljr-artifacts-'));
    store = new LocalFsArtifactStore(tmpDir);
    const moduleRef = await Test.createTestingModule({ imports: [ArtifactsModule] })
      .overrideProvider(IDENTITY_CONFIG)
      .useValue(testIdentityConfig())
      .overrideProvider(ARTIFACT_STORE)
      .useValue(store)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // onModuleInit：RETENTION_PURGE 执行器注册
    artifacts = app.get(ArtifactsService);
    executors = app.get(ArtifactsJobExecutors);
    scheduler = app.get(SchedulerService);
    poolSvc = app.get(PgPoolService);
    tokens = app.get(IdentityTokenService);
    evidenceChain = app.get(MockEvidenceChain);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await truncateAll(pool);
    clearStoreDir(tmpDir);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  // ---------------------------------------------------------------- ① 幂等键=hash

  it('putArtifact 幂等：同 bytes 二次调用返回同 id+deduplicated=true，存储目录单文件、内容寻址键布局', async () => {
    const bytes = Buffer.from('recording-payload-A');
    const retention = await dbDate(30);
    const first = await artifacts.putArtifact({
      kind: 'recording',
      ref_type: 'one_on_one',
      ref_id: 501,
      bytes,
      retentionUntil: retention,
    });
    expect(first.deduplicated).toBe(false);

    const again = await artifacts.putArtifact({
      kind: 'recording',
      ref_type: 'one_on_one',
      ref_id: 501,
      bytes,
      retentionUntil: retention,
    });
    expect(again.artifact_id).toBe(first.artifact_id);
    expect(again.deduplicated).toBe(true);

    const h = sha256hex(bytes);
    expect(first.hash_sha256).toBe(h);
    expect(first.bucket).toBe('recordings');
    expect(first.object_key).toBe(`recordings/recording/${h.slice(0, 2)}/${h}`);

    // 台账单行 + 存储单文件（同 hash 不重复写存储）
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM platform.artifacts`);
    expect(n.rows[0]!.n).toBe(1);
    expect(listFiles(tmpDir)).toEqual([first.object_key]);
  });

  // ---------------------------------------------------------------- ② WORM（存储层断言）

  it('原子写恢复（I-1）：崩溃残留半截对象（入参真前缀）重放同 bytes 经 tmp+rename 覆盖恢复；非前缀异内容仍 WORM 拒', async () => {
    const bytes = Buffer.from('atomic-write-full-payload-0123456789');
    const h = sha256hex(bytes);
    const objectKey = `recordings/recording/${h.slice(0, 2)}/${h}`;
    const full = path.join(tmpDir, objectKey);

    // 模拟旧实现写中途崩溃残留：直接写半个 payload 到终路径（=入参真前缀）
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, bytes.subarray(0, 10));

    // 重放同 bytes：可恢复（rename 覆盖半截），读回完整字节、无 tmp 残留
    await store.put('recordings', objectKey, bytes);
    const recovered = await store.get('recordings', objectKey);
    expect(Buffer.compare(recovered, bytes)).toBe(0);
    expect(listFiles(tmpDir)).toEqual([objectKey]);

    // 非前缀异内容（违规覆写意图）→ WORM 拒不放松
    await expect(
      store.put('recordings', objectKey, Buffer.from('different-content')),
    ).rejects.toThrow(ArtifactStoreError);
  });

  it('WORM 写保护：recordings 对象覆写（同 key 不同内容）被拒、删除被拒；同 ref 不同 bytes=新行新 hash 合法', async () => {
    const retention = await dbDate(30);
    const a = await artifacts.putArtifact({
      kind: 'recording',
      ref_type: 'one_on_one',
      ref_id: 601,
      bytes: Buffer.from('take-1'),
      retentionUntil: retention,
    });
    // 同 kind+ref、不同 bytes：内容寻址=新 hash=新行（WORM 不妨碍新对象写入）
    const b = await artifacts.putArtifact({
      kind: 'recording',
      ref_type: 'one_on_one',
      ref_id: 601,
      bytes: Buffer.from('take-2'),
      retentionUntil: retention,
    });
    expect(b.deduplicated).toBe(false);
    expect(b.artifact_id).not.toBe(a.artifact_id);
    expect(b.hash_sha256).not.toBe(a.hash_sha256);

    // 覆写尝试（同 object_key 不同内容）→ 存储层拒绝
    await expect(
      store.put('recordings', a.object_key, Buffer.from('tampered-content')),
    ).rejects.toThrow(ArtifactStoreError);
    // 删除尝试 → 存储层拒绝
    await expect(store.delete('recordings', a.object_key)).rejects.toThrow(ArtifactStoreError);

    // 双保险零副作用：原对象字节原样（哈希仍可验证）
    const got = await artifacts.getArtifact(a.artifact_id);
    expect(sha256hex(got.bytes)).toBe(a.hash_sha256);
  });

  // ---------------------------------------------------------------- ③ 归档上链全链

  it('archiveRecording 全链：哈希可验证（重算=hash_sha256）+evidence_id 关联订单+RecordingArchived 出箱+重放幂等', async () => {
    const bytes = Buffer.from('call-audio-bytes-901');
    const archived = await artifacts.archiveRecording({ ref_id: 901, bytes });
    expect(archived.archived).toBe(true);
    expect(archived.evidence_id).toMatch(/^EV-\d{8}-\d+$/);

    // 哈希可验证：读回字节重算 SHA-256
    const got = await artifacts.getArtifact(archived.artifact_id);
    expect(sha256hex(got.bytes)).toBe(got.hash_sha256);

    // evidence_id 关联订单（§10：凭证与订单关联）
    const row = await artifactRow(archived.artifact_id);
    expect(row!.evidence_id).toBe(archived.evidence_id);
    expect(row!.ref_type).toBe('one_on_one');
    expect(Number(row!.ref_id)).toBe(901);
    expect(row!.bucket).toBe('recordings');

    // 留存默认 3 年（R-01：retention_until ≥3 年锚——落在 +2y~+3y1mo 窗内）
    expect(row!.retention_until > (await dbDate(2 * 365))).toBe(true);
    expect(row!.retention_until < (await dbDate(3 * 366 + 31))).toBe(true);

    // 出箱断言（@ljr/shared 契约逐字段；hash 表可查不入载荷）
    const events = await outboxPayloads(RECORDING_ARCHIVED_TOPIC);
    expect(events).toEqual([
      {
        artifact_id: archived.artifact_id,
        evidence_id: archived.evidence_id,
        ref_type: 'one_on_one',
        ref_id: 901,
      },
    ]);

    // 重放幂等：同 bytes 再归档 → 无新行无新事件（evidence_id 复用在册值）
    const replay = await artifacts.archiveRecording({ ref_id: 901, bytes });
    expect(replay.archived).toBe(false);
    expect(replay.artifact_id).toBe(archived.artifact_id);
    expect(replay.evidence_id).toBe(archived.evidence_id);
    expect(await outboxPayloads(RECORDING_ARCHIVED_TOPIC)).toHaveLength(1);
    expect(evidenceChain.calls).toHaveLength(1); // 上链适配器仅首归档调用一次
  });

  // ---------------------------------------------------------------- ③ 补充：跨 ref 幂等语义（characterization）+日历有效性

  it('跨 ref 幂等语义 characterization（I-2/M-6）：putArtifact 通用面同 bytes 跨 ref=deduplicated 返回既有行；archiveRecording 同 bytes 跨 ref=显式 409 Conflict', async () => {
    const bytes = Buffer.from('cross-ref-char-bytes');
    const retention = await dbDate(30);
    // 通用面：putArtifact 幂等键=hash（与 ref 无关）——同 bytes 跨 ref 返回既有行，语义不变
    const first = await artifacts.putArtifact({
      kind: 'recording',
      ref_type: 'one_on_one',
      ref_id: 801,
      bytes,
      retentionUntil: retention,
    });
    const crossRef = await artifacts.putArtifact({
      kind: 'recording',
      ref_type: 'room',
      ref_id: 999,
      bytes,
      retentionUntil: retention,
    });
    expect(crossRef.artifact_id).toBe(first.artifact_id);
    expect(crossRef.deduplicated).toBe(true);
    expect(Number((await artifactRow(first.artifact_id))!.ref_id)).toBe(801); // 台账仍首访 ref

    // 归档链（ref 敏感）：同 ref 归档成功后，同 bytes 跨 ref_id 再归档 → 显式冲突（凭证关联防错绑）
    const archived = await artifacts.archiveRecording({ ref_id: 801, bytes });
    expect(archived.archived).toBe(true);
    await expect(artifacts.archiveRecording({ ref_id: 802, bytes })).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });

    // 同 ref 重放=deduplicated（archived=false 无新事件）
    const replay = await artifacts.archiveRecording({ ref_id: 801, bytes });
    expect(replay.archived).toBe(false);
    expect(await outboxPayloads(RECORDING_ARCHIVED_TOPIC)).toHaveLength(1);
  });

  it('retentionUntil 日历有效性（M-5）：2026-02-30 等伪日历日→400 InvalidArgument', async () => {
    const input = (retentionUntil: string) =>
      artifacts.putArtifact({
        kind: 'export',
        ref_type: 'user',
        ref_id: 41,
        bytes: Buffer.from('cal-check'),
        retentionUntil,
      });
    await expect(input('2026-02-30')).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
    await expect(input('2027-02-29')).rejects.toMatchObject({ code: ErrorCode.InvalidArgument }); // 非闰
    await expect(input('2026-13-01')).rejects.toMatchObject({ code: ErrorCode.InvalidArgument }); // 伪月
  });

  // ---------------------------------------------------------------- ④ RETENTION_PURGE 到期作业

  it('到期作业：retention=当天→删除+purged_at+ArtifactPurged 出箱；=明天→零动作；重跑幂等零新事件', async () => {
    const today = await dbDate(0);
    const tomorrow = await dbDate(1);
    const expiredCold = await artifacts.putArtifact({
      kind: 'cold_message',
      ref_type: 'conversation',
      ref_id: 11,
      bytes: Buffer.from('cold-expired'),
      retentionUntil: today,
    });
    const expiredRec = await artifacts.putArtifact({
      kind: 'recording',
      ref_type: 'one_on_one',
      ref_id: 13,
      bytes: Buffer.from('rec-expired'),
      retentionUntil: today,
    });
    const liveCold = await artifacts.putArtifact({
      kind: 'cold_message',
      ref_type: 'conversation',
      ref_id: 12,
      bytes: Buffer.from('cold-live'),
      retentionUntil: tomorrow,
    });
    expect(listFiles(tmpDir)).toHaveLength(3);

    const purged = await artifacts.purgeDue();
    expect(purged.purged).toBe(2);

    // 到期行：purged_at 落值+存储对象删除+逐行事件（recording 走 purgeObject 特权路径——WORM 不拦法定处置）
    expect((await artifactRow(expiredCold.artifact_id))!.purged_at).not.toBeNull();
    expect((await artifactRow(expiredRec.artifact_id))!.purged_at).not.toBeNull();
    const files = listFiles(tmpDir);
    expect(files).toEqual([liveCold.object_key]);

    const events = await outboxPayloads(ARTIFACT_PURGED_TOPIC);
    expect(events).toEqual([
      { artifact_id: expiredCold.artifact_id, kind: 'cold_message' },
      { artifact_id: expiredRec.artifact_id, kind: 'recording' },
    ]);

    // 未到期行零动作（=明天不动：purged_at NULL+对象在+无事件）
    expect((await artifactRow(liveCold.artifact_id))!.purged_at).toBeNull();
    expect(await artifacts.getArtifact(liveCold.artifact_id)).toMatchObject({
      artifact_id: liveCold.artifact_id,
    });

    // 已处置对象读回 404（处置后不可再取）
    await expect(artifacts.getArtifact(expiredCold.artifact_id)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });

    // 重跑幂等：purged_at 判重 → 零新处置零新事件
    const rerun = await artifacts.purgeDue();
    expect(rerun.purged).toBe(0);
    expect(await outboxPayloads(ARTIFACT_PURGED_TOPIC)).toHaveLength(2);
  });

  it('到期处置逐行隔离（I-3）：毒对象（目录形态阻塞删除）单行失败不连坐——其余行照常处置、毒行不丢下轮重扫可见', async () => {
    const today = await dbDate(0);
    const normal = await artifacts.putArtifact({
      kind: 'cold_message',
      ref_type: 'conversation',
      ref_id: 31,
      bytes: Buffer.from('normal-expired'),
      retentionUntil: today,
    });
    // 毒行：SQL 直插（不经 putArtifact），object_key 终路径做成目录 → unlink 拒
    //（win32 EPERM / posix EISDIR，均非 ENOENT → 传播为单行失败）
    const poisonHash = sha256hex(Buffer.from('poison-object'));
    const poisonKey = `cold-messages/cold_message/${poisonHash.slice(0, 2)}/${poisonHash}`;
    await pool.query(
      `INSERT INTO platform.artifacts
         (kind, ref_type, ref_id, bucket, object_key, hash_sha256, retention_until)
       VALUES ('cold_message', 'conversation', 32, 'cold-messages', $1, $2, $3::date)`,
      [poisonKey, poisonHash, today],
    );
    const poisonId = Number(
      (
        await pool.query<{ id: string }>(
          `SELECT id FROM platform.artifacts WHERE hash_sha256 = $1`,
          [poisonHash],
        )
      ).rows[0]!.id,
    );
    mkdirSync(path.join(tmpDir, poisonKey), { recursive: true }); // 终路径=目录 → 删除被阻塞

    const result = await artifacts.purgeDue();
    expect(result.purged).toBe(1); // 正常行照常处置（不连坐）
    expect(result.failed).toBe(1); // 毒行失败显式计数

    // 正常行：purged_at+事件；毒行：purged_at NULL+无事件（独立事务回滚，行不丢）
    expect((await artifactRow(normal.artifact_id))!.purged_at).not.toBeNull();
    expect((await artifactRow(poisonId))!.purged_at).toBeNull();
    expect(await outboxPayloads(ARTIFACT_PURGED_TOPIC)).toEqual([
      { artifact_id: normal.artifact_id, kind: 'cold_message' },
    ]);

    // 毒行下轮重扫可见（仍在扫描面；修障后再跑即收敛）
    const again = await artifacts.purgeDue();
    expect(again.purged).toBe(0);
    expect(again.failed).toBe(1);
  });

  it('RETENTION_PURGE 执行器：due job 经 I2 tick 执行（自投下一周期+处置入账）；ensurePurgeScheduled 幂等', async () => {
    // 幂等注册：二调同键去重回首访
    const first = await executors.ensurePurgeScheduled();
    expect(first.jobId).toBeGreaterThan(0);
    const second = await executors.ensurePurgeScheduled();
    expect(second.jobId).toBe(first.jobId);

    // 到期行一粒（当日到期）
    const expired = await artifacts.putArtifact({
      kind: 'cold_message',
      ref_type: 'conversation',
      ref_id: 21,
      bytes: Buffer.from('purge-via-job'),
      retentionUntil: await dbDate(0),
    });

    // I2 通道执行：注册一条已到期 RETENTION_PURGE（API 注册，过去时刻）→ normal tick 抢占执行
    await poolSvc.withTransaction((uow) =>
      scheduler.registerJob(uow, {
        jobType: 'RETENTION_PURGE',
        refType: 'global',
        refId: Date.now(),
        dueAt: new Date(Date.now() - 1_000),
      }),
    );
    const ticked = await scheduler.tick('normal');
    expect(ticked.done).toBe(1);

    // 处置入账（执行器路径；I-3 起处置=逐行独立事务，与 job DONE 解耦）
    expect((await artifactRow(expired.artifact_id))!.purged_at).not.toBeNull();
    expect(await outboxPayloads(ARTIFACT_PURGED_TOPIC)).toEqual([
      { artifact_id: expired.artifact_id, kind: 'cold_message' },
    ]);

    // 执行器自投下一周期（24h 后，PENDING 在册——ensurePurgeScheduled 幂等可复见）
    const next = await scheduler.findPendingJobId(pool, 'RETENTION_PURGE');
    expect(next).not.toBeNull();
  });

  // ---------------------------------------------------------------- ⑤ 审批调取面（HTTP）

  it('审批调取面：未审批 403/单签 403/双签完整 200 {evidence_id,hash_sha256,object_key}/无凭证 404/非 admin 403', async () => {
    const adminId = await seedUserShell(pool, 'i3-approval-admin');
    await grantUserRoles(pool, adminId, ['admin']);
    const adminToken = await tokens.signAccessToken({
      userId: adminId,
      role: 'user',
      roles: ['user', 'admin'],
    });
    const userToken = await tokens.signAccessToken({
      userId: 7601,
      role: 'user',
      roles: ['user'],
    });

    const archived = await artifacts.archiveRecording({
      ref_id: 951,
      bytes: Buffer.from('approval-target-rec'),
    });
    const url = `/admin/artifacts/${archived.artifact_id}/evidence`;

    // 未审批 → 403 E_NOT_APPROVED（不泄露审批存在性，同码拒绝）
    const noApproval = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(noApproval.status).toBe(403);
    expect(noApproval.body.code).toBe(ErrorCode.NotApproved);

    // 单签（approved_by 有、reviewed_by 缺）→ 403 同码
    await pool.query(
      `INSERT INTO platform.artifact_access_approvals (artifact_id, reason, approved_by, approved_at)
       VALUES ($1, '工单 #1001 调取', 7001, now())`,
      [archived.artifact_id],
    );
    const singleSign = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(singleSign.status).toBe(403);
    expect(singleSign.body.code).toBe(ErrorCode.NotApproved);

    // 双签完整（不同人）→ 200，出参仅三键（§5 契约）
    await pool.query(
      `UPDATE platform.artifact_access_approvals
          SET reviewed_by = 7002, reviewed_at = now()
        WHERE artifact_id = $1`,
      [archived.artifact_id],
    );
    const ok = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['evidence_id', 'hash_sha256', 'object_key']);
    expect(ok.body.evidence_id).toBe(archived.evidence_id);
    expect(ok.body.hash_sha256).toBe(sha256hex(Buffer.from('approval-target-rec')));

    // 无 evidence_id 的 artifact（非 recording 归档链）→ 404
    const plain = await artifacts.putArtifact({
      kind: 'export',
      ref_type: 'user',
      ref_id: 7601,
      bytes: Buffer.from('export-package'),
      retentionUntil: await dbDate(30),
    });
    const noEvidence = await request(app.getHttpServer())
      .get(`/admin/artifacts/${plain.artifact_id}/evidence`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(noEvidence.status).toBe(404);
    expect(noEvidence.body.code).toBe(ErrorCode.NotFound);

    // 未知 artifact → 404；非 admin token → 403 E_ROLE_FORBIDDEN
    const missing = await request(app.getHttpServer())
      .get('/admin/artifacts/987654/evidence')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missing.status).toBe(404);
    const notAdmin = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${userToken}`);
    expect(notAdmin.status).toBe(403);
    expect(notAdmin.body.code).toBe(ErrorCode.RoleForbidden);
  });

  it('审批 CHECK 禁同人：approved_by=reviewed_by 直插被 DB 拒（双签不同人的物理兜底）', async () => {
    const archived = await artifacts.archiveRecording({
      ref_id: 952,
      bytes: Buffer.from('check-constraint-rec'),
    });
    await expect(
      pool.query(
        `INSERT INTO platform.artifact_access_approvals
           (artifact_id, reason, approved_by, approved_at, reviewed_by, reviewed_at)
         VALUES ($1, '同人双签注入', 7777, now(), 7777, now())`,
        [archived.artifact_id],
      ),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------- ⑥ KIND_POLICY 分级管控

  it('KIND_POLICY：credential+trade 域→403 E_KIND_POLICY；recon_file+identity 域→403；合法组合放行', async () => {
    const retention = await dbDate(30);
    const bytes = Buffer.from('credential-bytes');
    await expect(
      artifacts.putArtifact({
        kind: 'credential',
        ref_type: 'trade',
        ref_id: 1,
        bytes,
        retentionUntil: retention,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.KindPolicy });
    await expect(
      artifacts.putArtifact({
        kind: 'recon_file',
        ref_type: 'identity',
        ref_id: 2,
        bytes,
        retentionUntil: retention,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.KindPolicy });

    // 合法组合：credential→identity 域 / recon_file→payment 域 / 其余 kind 开放
    const cred = await artifacts.putArtifact({
      kind: 'credential',
      ref_type: 'identity',
      ref_id: 7,
      bytes,
      retentionUntil: retention,
    });
    expect(cred.bucket).toBe('credentials');
    const recon = await artifacts.putArtifact({
      kind: 'recon_file',
      ref_type: 'payment',
      ref_id: 3,
      bytes: Buffer.from('recon-csv'),
      retentionUntil: retention,
    });
    expect(recon.bucket).toBe('recon-files');
  });

  it('credentials bucket 写入即变换落盘（禁明文）+getArtifact 还原明文（W1 mock 变换，真加密=M5 前换装）', async () => {
    const bytes = Buffer.from('L4-credential-plaintext');
    const cred = await artifacts.putArtifact({
      kind: 'credential',
      ref_type: 'identity',
      ref_id: 8,
      bytes,
      retentionUntil: await dbDate(30),
    });
    // 哈希=明文内容指纹（上链/幂等锚不受变换影响）
    expect(cred.hash_sha256).toBe(sha256hex(bytes));

    // 落盘字节 ≠ 明文（禁明文落盘，R-04 L4 管控）——直读磁盘原文（store.get 语义=自动还原明文）
    const onDisk = readFileSync(path.join(tmpDir, cred.object_key));
    expect(Buffer.compare(onDisk, bytes)).not.toBe(0);

    // 读回还原明文（变换可逆）
    const got = await artifacts.getArtifact(cred.artifact_id);
    expect(Buffer.compare(Buffer.from(got.bytes), bytes)).toBe(0);
  });
});
