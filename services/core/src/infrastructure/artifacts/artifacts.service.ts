/**
 * I3 文件与存证服务（§2/§4/§5 + §6 事件 + §7 R-01~R-04；M2-W1 T2）——统一入口 PUT/GET_ARTIFACT
 * （内部接口）+录音归档链+到期处置+审批调取面。横切基座（⚠W1-4）：表落 platform schema（V36），
 * 代码在 src/infrastructure/artifacts/（outbox/state-machine 先例）；业务消费方（D5 冷存/W1 T3
 * 等）经本服务写入，禁直连基座表（DB 授权兜底，V2/V36 GRANT 口径）。
 *
 * 幂等键=hash_sha256（§5）：同 bytes（同哈希）重放返回既有行 deduplicated=true，**不重复写存储**
 * （ux_artifacts_hash DB 真兜底——并发双插第二路唯一冲突后回落既有行）。
 * object_key=内容寻址 <bucket>/<kind>/<hash 前两位>/<hash 全值>（同 hash 天然去重）。
 *
 * WORM 双保险（§9 禁止 WORM bucket 任何更新/删除路径）：存储层拒绝覆写/删除（artifact-store
 * 策略层）+本层内容寻址+幂等短路使覆写路径不可达（同 hash=同字节幂等；不同字节=不同 key 新对象）。
 *
 * 处置审计口径（简报改口径裁定）：处置动作不入 ops 域 audit-logs 直写（基座禁反向依赖业务域，
 * check-schema-refs 纪律）——审计承载=ArtifactPurged 逐行出箱（H9 消费=W2+），ops 直写留 W2
 * 评审裁量。匿名化口径：recording/export/recon_file 到期=「匿名化转统计」，**W1 形态=存储对象
 * 删除+行保留 purged_at+计数入事件**（匿名化细则 PRD 未定义不发明——细则落定后在此分叉分支）；
 * cold_message/credential 到期=物理删除存储对象+行标 purged_at（W1 两分支行为同形，语义注记分开）。
 *
 * 归档幂等的 ref 语义（评审 I-2）：putArtifact 通用面幂等键=hash 与 ref 无关（同 bytes 跨 ref
 * =deduplicated 返回既有行，characterization 钉住）；archiveRecording 是 ref 敏感链——在册行
 * ref_type/ref_id 与入参不一致时显式 409 Conflict（防 evidence_id 凭证经 dedup 蹭车关联到
 * 另一订单）。
 *
 * 到期处置逐行隔离（评审 I-3）：每行独立事务（withTransaction 一行一段），单行失败 warn 日志
 * +failed 计数后继续（不连坐整批）；毒行保持 purged_at NULL=下轮重扫可见。处置与 job DONE
 * 解耦：job DONE 只承载本轮调度完成，处置 at-least-once 由 purged_at 判重兜底（崩溃窗内
 * job 可能 DONE 而部分行未处置→下轮重扫收敛）。
 *
 * 事务形态：FS 写在 DB 事务内（本地 FS 零网络——RTC 适配器「事务内禁外呼」不适用；OSS 换装时
 * 改两段式：事务外先落对象、事务内落台账，孤儿对象由内容寻址幂等吸收；存储层 put 本身
 * tmp+rename 原子落位——评审 I-1）。
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  ARTIFACT_PURGED_TOPIC,
  RECORDING_ARCHIVED_TOPIC,
  type ArtifactPurgedPayload,
  type RecordingArchivedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../sql';
import { PgPoolService } from '../sql';
import { OutboxService } from '../outbox/outbox.service';
import { ARTIFACT_STORE, type ArtifactStore } from './artifact-store';
import { EVIDENCE_CHAIN, type EvidenceChain } from './evidence-chain';
import {
  DEFAULT_RETENTION_YEARS,
  KIND_BUCKET,
  KIND_REF_POLICY,
  isArtifactKind,
  isValidRetentionDate,
  type ArtifactKind,
} from './artifacts.types';

/** Asia/Shanghai 固定 +08:00（无夏令时；与 DB timezone 同口径） */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

const sha256hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 默认留存到期日（上海日 +3 年，R-01；⚠04§8-2 法务确认并行中） */
function defaultRetentionUntil(now = new Date()): string {
  const d = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  d.setUTCFullYear(d.getUTCFullYear() + DEFAULT_RETENTION_YEARS);
  return d.toISOString().slice(0, 10);
}

function assertPositiveInt(raw: number, field: string): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new AppError(ErrorCode.InvalidArgument, `${field} 须为正整数，收到：${String(raw)}`);
  }
  return raw;
}

/** PUT_ARTIFACT 入参（§5 内部接口；uow 可选=与调用方业务同事务） */
export interface PutArtifactInput {
  readonly kind: string;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly bytes: Uint8Array;
  /** 留存到期日 'YYYY-MM-DD'（缺省场景走 archiveRecording 的 3 年默认） */
  readonly retentionUntil: string;
}

export interface PutArtifactResult {
  readonly artifact_id: number;
  readonly hash_sha256: string;
  readonly bucket: string;
  readonly object_key: string;
  /** true=同 hash 已在册，返回既有行未重复写存储（§5 幂等键=hash） */
  readonly deduplicated: boolean;
}

export interface ArchiveRecordingInput {
  /** 1对1 订单 id（§4：凭证与订单关联） */
  readonly ref_id: number;
  readonly bytes: Uint8Array;
}

export interface ArchiveRecordingResult {
  readonly archived: boolean;
  readonly artifact_id: number;
  readonly evidence_id: string;
  readonly deduplicated: boolean;
}

export interface ArtifactView {
  readonly artifact_id: number;
  readonly kind: ArtifactKind;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly bucket: string;
  readonly object_key: string;
  readonly hash_sha256: string;
  readonly evidence_id: string | null;
  readonly retention_until: string;
  readonly purged_at: Date | null;
  readonly created_at: Date;
  readonly bytes: Uint8Array;
}

/** GET /admin/artifacts/{id}/evidence 出参（§5 契约三元组） */
export interface ArtifactEvidenceView {
  readonly evidence_id: string;
  readonly hash_sha256: string;
  readonly object_key: string;
}

interface ArtifactRow {
  readonly id: string;
  readonly kind: string;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly bucket: string;
  readonly object_key: string;
  readonly hash_sha256: string;
  readonly evidence_id: string | null;
  readonly retention_until: string;
  readonly purged_at: Date | null;
  readonly created_at: Date;
}

@Injectable()
export class ArtifactsService {
  private readonly logger = new Logger(ArtifactsService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    @Inject(ARTIFACT_STORE) private readonly store: ArtifactStore,
    @Inject(EVIDENCE_CHAIN) private readonly evidence: EvidenceChain,
  ) {}

  // ===========================================================================
  // PUT_ARTIFACT 统一入口（§5 内部接口；幂等键=hash；403 KIND_POLICY 分级管控）
  // ===========================================================================

  /**
   * 写入存档：入参校验（kind 值域/留存形态/ref_id）→ KIND_POLICY 分级管控 → 哈希+内容寻址键
   * → 幂等短路（同 hash 在册返回既有行，不重复写存储）→ FS 落对象 → 台账行（唯一冲突回落既有行）。
   */
  async putArtifact(
    input: PutArtifactInput,
    opts?: { readonly uow?: SqlExecutor },
  ): Promise<PutArtifactResult> {
    const run = async (exec: SqlExecutor): Promise<PutArtifactResult> => {
      if (!isArtifactKind(input.kind)) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `kind 须为五值之一（recording|export|credential|cold_message|recon_file），收到：${input.kind}`,
        );
      }
      assertPositiveInt(input.ref_id, 'ref_id');
      if (input.bytes.length === 0) {
        throw new AppError(ErrorCode.InvalidArgument, 'bytes 不得为空');
      }
      if (!isValidRetentionDate(input.retentionUntil)) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `retentionUntil 须为 'YYYY-MM-DD' 且为真实日历日（2026-02-30 等伪日拒收），收到：${input.retentionUntil}`,
        );
      }
      // KIND_POLICY（R-04 L4 差异化管控）：kind 与 ref_type 组合违策略 → 403（W1 最小策略表）
      const allowed = KIND_REF_POLICY[input.kind];
      if (allowed !== null && !allowed.includes(input.ref_type)) {
        throw new AppError(
          ErrorCode.KindPolicy,
          `kind=${input.kind} 仅允许引用域 [${allowed.join('|')}]，收到 ref_type=${input.ref_type}`,
        );
      }

      const hash = sha256hex(input.bytes);
      const bucket = KIND_BUCKET[input.kind];
      const objectKey = `${bucket}/${input.kind}/${hash.slice(0, 2)}/${hash}`;

      // 幂等短路：同 hash 在册 → 返回既有行（不重复写存储，§5 幂等键=hash）
      const existing = await exec.query<{ id: string; bucket: string; object_key: string }>(
        `SELECT id, bucket, object_key FROM platform.artifacts WHERE hash_sha256 = $1`,
        [hash],
      );
      const prev = existing.rows[0];
      if (prev) {
        return {
          artifact_id: Number(prev.id),
          hash_sha256: hash,
          bucket: prev.bucket,
          object_key: prev.object_key,
          deduplicated: true,
        };
      }

      await this.store.put(bucket, objectKey, input.bytes); // WORM/加密策略在存储层执行
      const inserted = await exec.query<{ id: string }>(
        `INSERT INTO platform.artifacts
           (kind, ref_type, ref_id, bucket, object_key, hash_sha256, retention_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date)
         ON CONFLICT (hash_sha256) DO NOTHING
         RETURNING id`,
        [input.kind, input.ref_type, input.ref_id, bucket, objectKey, hash, input.retentionUntil],
      );
      const row = inserted.rows[0];
      if (row) {
        return {
          artifact_id: Number(row.id),
          hash_sha256: hash,
          bucket,
          object_key: objectKey,
          deduplicated: false,
        };
      }
      // 并发竞态败退：唯一冲突后回落既有行（与短路路径同形）。理论不可达分支显式失败不裸取
      //（评审 M-1：冲突后无行=行被并发物理删除等数据漂移，E_INTERNAL 显性化）
      const raced = await exec.query<{ id: string }>(
        `SELECT id FROM platform.artifacts WHERE hash_sha256 = $1`,
        [hash],
      );
      const racedRow = raced.rows[0];
      if (!racedRow) {
        throw new AppError(
          ErrorCode.InternalError,
          `artifacts 唯一冲突后回落无行（hash=${hash}）——并发窗口内行消失，数据漂移显性化`,
        );
      }
      return {
        artifact_id: Number(racedRow.id),
        hash_sha256: hash,
        bucket,
        object_key: objectKey,
        deduplicated: true,
      };
    };
    return opts?.uow ? run(opts.uow) : this.pool.withTransaction(run);
  }

  // ===========================================================================
  // GET_ARTIFACT（§5 内部接口；审批面独立——本方法不做审批校验）
  // ===========================================================================

  /** 读回存档（含字节；credentials 域由存储层反变换还原明文）。已处置（purged_at 非空）→404 */
  async getArtifact(artifactId: number): Promise<ArtifactView> {
    const id = assertPositiveInt(artifactId, 'artifact_id');
    const found = await this.pool.query<ArtifactRow>(
      `SELECT id, kind, ref_type, ref_id, bucket, object_key, hash_sha256, evidence_id,
              retention_until::text AS retention_until, purged_at, created_at
         FROM platform.artifacts WHERE id = $1`,
      [id],
    );
    const row = found.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `存档 ${id} 不存在`);
    }
    if (row.purged_at !== null) {
      throw new AppError(ErrorCode.NotFound, `存档 ${id} 已到期处置（purged_at 落值），不可读取`);
    }
    const bytes = await this.store.get(row.bucket, row.object_key);
    return {
      artifact_id: id,
      kind: row.kind as ArtifactKind,
      ref_type: row.ref_type,
      ref_id: Number(row.ref_id),
      bucket: row.bucket,
      object_key: row.object_key,
      hash_sha256: row.hash_sha256,
      evidence_id: row.evidence_id,
      retention_until: row.retention_until,
      purged_at: row.purged_at,
      created_at: row.created_at,
      bytes,
    };
  }

  // ===========================================================================
  // 录音归档链（§4 关键流程：拉取→WORM bucket→哈希→上链→台账（evidence_id）→关联 1对1 订单）
  // ===========================================================================

  /**
   * 归档 1对1 录音：putArtifact(kind=recording)→SHA-256 真算（putArtifact 内承载）→上链适配器
   * （mock=W1）→回写 evidence_id→RecordingArchived 出箱（同事务）。幂等：同 bytes **同 ref**
   * 重放且 evidence_id 已在册 → 无新上链无新事件（archived=false）；在册行 ref 与入参不一致
   * → 显式 409 Conflict（评审 I-2——通用面 dedup 蹭车会把凭证关联到错误订单，防错绑）。
   */
  async archiveRecording(input: ArchiveRecordingInput): Promise<ArchiveRecordingResult> {
    const refId = assertPositiveInt(input.ref_id, 'ref_id');
    return this.pool.withTransaction(async (uow) => {
      const put = await this.putArtifact(
        {
          kind: 'recording',
          ref_type: 'one_on_one',
          ref_id: refId,
          bytes: input.bytes,
          retentionUntil: defaultRetentionUntil(),
        },
        { uow },
      );
      const current = await uow.query<{
        evidence_id: string | null;
        ref_type: string;
        ref_id: string;
      }>(`SELECT evidence_id, ref_type, ref_id FROM platform.artifacts WHERE id = $1`, [
        put.artifact_id,
      ]);
      const row = current.rows[0];
      if (!row || row.ref_type !== 'one_on_one' || Number(row.ref_id) !== refId) {
        // 归档链 ref 敏感：同哈希行已在册但引用不符（dedup 蹭车）→ 显式冲突不静默错绑
        throw new AppError(
          ErrorCode.Conflict,
          `同哈希存档已在册但引用不符（在册 ${row ? `${row.ref_type}#${row.ref_id}` : '（行缺失）'}，` +
            `本次归档 one_on_one#${refId}）——存证凭证不可跨订单蹭车关联`,
        );
      }
      // 幂等短路：既有行已有凭证（前次归档）→ 返回在册值，不重复上链不重复出箱
      const existingEvidence = row.evidence_id;
      if (existingEvidence !== null) {
        return {
          archived: false,
          artifact_id: put.artifact_id,
          evidence_id: existingEvidence,
          deduplicated: true,
        };
      }

      const { evidence_id } = await this.evidence.notarize({
        hash: put.hash_sha256,
        ref_type: 'one_on_one',
        ref_id: refId,
      });
      await uow.query(`UPDATE platform.artifacts SET evidence_id = $2 WHERE id = $1`, [
        put.artifact_id,
        evidence_id,
      ]);
      await this.outbox.recordOutbox(uow, {
        type: RECORDING_ARCHIVED_TOPIC,
        payload: {
          artifact_id: put.artifact_id,
          evidence_id,
          ref_type: 'one_on_one',
          ref_id: refId,
        } satisfies RecordingArchivedPayload,
      });
      return {
        archived: true,
        artifact_id: put.artifact_id,
        evidence_id,
        deduplicated: put.deduplicated,
      };
    });
  }

  // ===========================================================================
  // 到期处置（RETENTION_PURGE 执行器内核 / 直调入口；§4：日扫→删除/匿名化→审计）
  // ===========================================================================

  /**
   * 一轮到期处置（评审 I-3：逐行独立事务+单行隔离）：扫 retention_until<=当日（DB 钟）且未处置行
   * → 逐行 withTransaction 一段：purged_at 判重守卫（UPDATE ... WHERE purged_at IS NULL——并发
   * 双跑第二路零事件，处置幂等）→ 存储对象删除（recordings 经 purgeObject 特权路径，WORM 不拦
   * 法定处置）→ ArtifactPurged 逐行出箱（审计承载，H9 消费=W2+）。单行失败（对象删除阻塞等）
   * → warn 日志+failed 计数后继续（不连坐整批）；失败行保持 purged_at NULL=下轮重扫可见。
   * 边界：retention_until=当天→放行；=明天→不在扫描面零动作。
   */
  async purgeDue(): Promise<{ readonly purged: number; readonly failed: number }> {
    const due = await this.pool.query<{
      id: string;
      kind: string;
      bucket: string;
      object_key: string;
    }>(
      `SELECT id, kind, bucket, object_key FROM platform.artifacts
        WHERE retention_until <= CURRENT_DATE AND purged_at IS NULL
        ORDER BY id`,
    );
    let purged = 0;
    let failed = 0;
    for (const row of due.rows) {
      try {
        await this.pool.withTransaction(async (uow) => {
          // 先落 purged_at 再删对象：对象删除失败→本行事务回滚复原（下轮重入）；出箱失败回滚后
          // 已删对象由 purgeObject 幂等吸收（缺失=no-op），收敛不丢账
          const marked = await uow.query<{ id: string }>(
            `UPDATE platform.artifacts SET purged_at = now()
              WHERE id = $1 AND purged_at IS NULL RETURNING id`,
            [row.id],
          );
          if (marked.rows.length === 0) return; // 并发已处置：判重短路零事件
          await this.store.purgeObject(row.bucket, row.object_key);
          await this.outbox.recordOutbox(uow, {
            type: ARTIFACT_PURGED_TOPIC,
            payload: {
              artifact_id: Number(row.id),
              kind: row.kind as ArtifactPurgedPayload['kind'],
            } satisfies ArtifactPurgedPayload,
          });
        });
        purged += 1;
      } catch (e) {
        // 单行隔离（评审 I-3）：失败不连坐整批；行未处置（事务已回滚）→下轮重扫可见不丢失
        failed += 1;
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.logger.warn(
          `RETENTION_PURGE 单行处置失败（跳过不连坐，下轮重扫）：artifact ${row.id} ${message}`,
        );
      }
    }
    return { purged, failed };
  }

  // ===========================================================================
  // 审批调取面（§5 GET /admin/artifacts/{id}/evidence；R-02 仅合规审批调取）
  // ===========================================================================

  /**
   * 存证凭证调取（admin 面）：双签完整（approved_by+reviewed_by 非空——V36 CHECK 禁同人=
   * 双签不同人的物理兜底）才放行 {evidence_id, hash_sha256, object_key}；未审批/单签→403
   * NOT_APPROVED（同码拒绝不泄露审批存在性，A2 受控解密先例）；无 evidence_id（非录音归档链
   * 产物）/未知 id→404。审批行创建面=H9（W2+），本批只消费。
   */
  async evidenceFor(artifactId: number): Promise<ArtifactEvidenceView> {
    const id = assertPositiveInt(artifactId, 'artifact_id');
    const found = await this.pool.query<{
      evidence_id: string | null;
      hash_sha256: string;
      object_key: string;
    }>(`SELECT evidence_id, hash_sha256, object_key FROM platform.artifacts WHERE id = $1`, [id]);
    const row = found.rows[0];
    if (!row) {
      throw new AppError(ErrorCode.NotFound, `存档 ${id} 不存在`);
    }
    if (row.evidence_id === null) {
      throw new AppError(ErrorCode.NotFound, `存档 ${id} 无存证凭证（非录音归档链产物）`);
    }
    const approval = await this.pool.query<{ id: string }>(
      `SELECT id FROM platform.artifact_access_approvals
        WHERE artifact_id = $1 AND approved_by IS NOT NULL AND reviewed_by IS NOT NULL
        LIMIT 1`,
      [id],
    );
    if (approval.rows.length === 0) {
      this.logger.warn(
        `artifact.evidence 拒绝：artifact_id=${id} 无完整双签审批（未审批/单签同码，R-02）`,
      );
      throw new AppError(ErrorCode.NotApproved);
    }
    return {
      evidence_id: row.evidence_id,
      hash_sha256: row.hash_sha256,
      object_key: row.object_key,
    };
  }
}
