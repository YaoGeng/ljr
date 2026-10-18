/**
 * A3a 律师资质审核领域服务（docs/modules/A-身份与账号/A3a §2/§4/§5/§7）。
 *
 * 关键流程（§4 状态机 DRAFT→SUBMITTED→IN_REVIEW→PASSED｜REJECTED，PASSED→SUSPENDED→PASSED）：
 *   提交（幂等键=user）：在审中再提交 → 409 ALREADY_SUBMITTED；REJECTED 重提/PASSED 后修改
 *         须构成「新材料版本」（§4 守卫：material_version 递增 + 材料指纹变化，同材料 → 409）；
 *         R-03 盲索引预检他人占用 → 409；守卫迁移 → 建行/原行迁移 + qualification_files
 *         新版本行（旧版本保留追溯）。
 *   审核动作（H1 契约归 A3a）：claim/approve/reject/suspend/resume 全部经守卫（非法迁移
 *         拒绝并留痕，§10-2）；approve 同事务发 LawyerAuditPassed{lawyer_user_id, firm_id}
 *         （A3b 进件前 firm_id=null，简报裁决）；suspend 发 LawyerSuspended{lawyer_user_id,
 *         reason}；恢复不发事件（§6 仅两个生产事件）。
 *   查询面：GET /lawyer/audit-status（本人视角）；isAuditPassed=R-01 内部闸口（W3 C3/
 *         接单大厅消费，本批查询面交付、列表联调=W3 桩 §10-1）；getPracticeCity=执业城市
 *         导出面（序 11.5 V33，C1 开团/C2 发布物化 city 的消费缝）。
 *
 * PII 红线（§9 禁止）：license_no 明文只存在于请求入参与列加密入参；落库仅密文+盲索引，
 * 日志只记 user_id/profile_id/版本号，事件载荷仅 lawyer_user_id/firm_id/reason。
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  LAWYER_AUDIT_PASSED_TOPIC,
  LAWYER_SUSPENDED_TOPIC,
  type LawyerAuditPassedPayload,
  type LawyerSuspendedPayload,
} from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { IdentityCryptoService } from './identity.crypto';
import type { LawyerAuditStatus } from './lawyer.machine';
import { LAWYER_AUDIT_MACHINE } from './lawyer.machine';
import type { LawyerAuditAction, QualificationFileInput } from './lawyer.http';
import {
  assertLicenseNo,
  parseFirmName,
  parsePracticeCity,
  parseQualificationFiles,
} from './lawyer.http';

export interface QualificationSubmitInput {
  readonly licenseNo: string;
  readonly firmName?: string;
  /** 执业城市（序 11.5 V33 维度列）：可选，缺省 '北京'（DEFAULT_PRACTICE_CITY/V33 DEFAULT 同源） */
  readonly city?: string;
  readonly files: readonly QualificationFileInput[];
}

export interface QualificationSubmitResult {
  readonly status: 'SUBMITTED';
  /** 本次提交构成的材料版本（服务端单调，qualification_files 同源） */
  readonly materialVersion: number;
}

export interface AuditActionInput {
  readonly action: LawyerAuditAction;
  readonly rejectReason?: string;
  readonly reason?: string;
}

export interface AuditStatusView {
  readonly status: LawyerAuditStatus;
  /** 仅 REJECTED 有值（§5 {status, reason?}） */
  readonly reason?: string;
}

/** 工作台队列条目（H1 GET /admin/lawyers；snake_case 出站口径，无 license 字段） */
export interface SubmissionQueueItem {
  /** lawyer_profiles.id（H1 审核/档案路由对象 {id}） */
  readonly id: number;
  readonly lawyer_user_id: number;
  readonly audit_status: LawyerAuditStatus;
  readonly firm_name: string | null;
  readonly material_version: number;
  /** 最近一次提交时刻 ISO（SLA 起算事实源；行必有=提交即落） */
  readonly submitted_at: string | null;
}

/** 资质档案视图（H1 GET /admin/lawyers/{id}/profile 的 A3a 聚合源；无 license 字段） */
export interface QualificationProfileView {
  readonly id: number;
  readonly lawyer_user_id: number;
  readonly audit_status: LawyerAuditStatus;
  readonly firm_name: string | null;
  /** A3b 进件回填的律所 id（trade/pricing 域裸引用；进件前 null） */
  readonly firm_id: number | null;
  /** 执业城市登记面（序 11.5 V33）：「执业城市登记面随审核带出」最小实现 */
  readonly city: string;
  readonly material_version: number;
  readonly submitted_at: string | null;
  readonly audited_at: string | null;
  /** W3 T10 G-A 接线后：admin 面新行必落；存量 NULL 行不回填（历史不可变） */
  readonly auditor_id: number | null;
  readonly reject_reason?: string | null;
}

interface QueueRow {
  readonly id: string;
  readonly user_id: string;
  readonly audit_status: LawyerAuditStatus;
  readonly firm_name: string | null;
  readonly material_version: number;
  readonly submitted_at: Date | null;
}

interface ViewRow {
  readonly id: string;
  readonly user_id: string;
  readonly firm_id: string | null;
  readonly firm_name: string | null;
  readonly city: string;
  readonly audit_status: LawyerAuditStatus;
  readonly material_version: number;
  readonly submitted_at: Date | null;
  readonly audited_at: Date | null;
  readonly auditor_id: string | null;
  readonly reject_reason: string | null;
}

interface LawyerProfileRow {
  readonly id: string;
  readonly user_id: string;
  readonly firm_id: string | null;
  readonly audit_status: LawyerAuditStatus;
  readonly material_version: number;
  readonly material_fingerprint: string;
}

/** 审核动作 → 目标状态（§4 矩阵的入参面映射；前置缺失由守卫拒绝并留痕） */
const ACTION_TO_STATUS: Record<LawyerAuditAction, LawyerAuditStatus> = {
  claim: 'IN_REVIEW',
  approve: 'PASSED',
  reject: 'REJECTED',
  suspend: 'SUSPENDED',
  resume: 'PASSED',
};

/** 并发窗口唯一约束败退（23505）：user 唯一/盲索引唯一的竞窗兜底入口（显式复检，不吞错） */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/** 执业城市缺省值（序 11.5 V33：与 lawyer_profiles.city 列 DEFAULT 同源；⚠W3-10 城市码=中文名称字符串） */
const DEFAULT_PRACTICE_CITY = '北京';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER;
}

/**
 * 材料集内容指纹（§4 新材料版本守卫）：规范化后 sha256 hex64——同材料重提不构成新版本。
 * Important-1（T3 评审）：license 组件只以盲索引（HMAC-SHA256+pepper，复用 T1 体系）参与
 * ——无钥 sha256 的 canonical 一旦嵌入明文 license_no，DB 泄露后同行明文 firm_name/files
 * 即构成强格式证号的离线猜测预言机。licenseBlind 入参=盲索引派生值，禁传明文。
 */
export function materialFingerprintOf(
  licenseBlind: string,
  firmName: string | undefined,
  files: readonly QualificationFileInput[],
): string {
  const canonical = JSON.stringify({
    license_blind: licenseBlind,
    firm_name: firmName ?? null,
    // 对象逐个序列化后排序：有序且无分隔符歧义（kind/ref 含 `|` 不致错位）
    files: files.map((f) => JSON.stringify({ kind: f.kind, ref: f.ref })).sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

@Injectable()
export class LawyerQualificationService {
  private readonly logger = new Logger(LawyerQualificationService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly crypto: IdentityCryptoService,
  ) {}

  /**
   * POST /lawyer/qualification（幂等键=user）：在审冲突 → §4 版本守卫 → R-03 盲索引预检 →
   * 守卫迁移 → 建行（DRAFT）或原行迁移（REJECTED/PASSED 侧）+ 材料新版本行。
   */
  async submitQualification(
    userId: number,
    input: QualificationSubmitInput,
  ): Promise<QualificationSubmitResult> {
    // 形态防呆（REST 与服务层共用同一事实源，lawyer.http）：不产生任何状态迁移
    const licenseNo = assertLicenseNo(input.licenseNo);
    const firmName = parseFirmName(input.firmName);
    const city = parsePracticeCity(input.city); // 序 11.5：缺省/空白归 absent（落 DEFAULT 北京）
    const files = parseQualificationFiles(input.files);
    // 盲索引先行（Important-1）：指纹的 license 组件=盲索引派生值，明文不出本函数入参生命周期
    const licenseBlind = this.crypto.blindIndex(licenseNo);
    const fingerprint = materialFingerprintOf(licenseBlind, firmName, files);

    return this.pool.withTransaction(async (uow) => {
      const current = await this.profileOfUserForUpdate(uow, userId);
      if (
        current &&
        (current.audit_status === 'SUBMITTED' || current.audit_status === 'IN_REVIEW')
      ) {
        // §5 409 ALREADY_SUBMITTED：在审中重复提交（幂等键=user 的冲突面）
        throw new AppError(
          ErrorCode.AlreadySubmitted,
          `资质审核已在流程中（${current.audit_status}），请等待审核结论`,
        );
      }
      if (
        current &&
        (current.audit_status === 'REJECTED' || current.audit_status === 'PASSED') &&
        current.material_fingerprint === fingerprint
      ) {
        // §4 守卫：重提/修改需新材料版本——同材料不构成新版本
        throw new AppError(ErrorCode.Conflict, '材料未变更，不构成新材料版本（重提须更新材料）');
      }

      // R-03 盲索引预检：他人已占用 → 409（明文不落库，等值检索只走 HMAC）
      const holder = await this.profileIdByLicense(uow, licenseBlind);
      if (holder !== undefined && Number(holder) !== Number(current?.id ?? -1)) {
        throw new AppError(ErrorCode.LicenseNoTaken, '执业证号已被其他账号使用（R-03）');
      }

      const from: LawyerAuditStatus = current ? current.audit_status : 'DRAFT';
      const version = (current?.material_version ?? 0) + 1;
      await this.guard.assertTransition(LAWYER_AUDIT_MACHINE, {
        entityId: userId,
        from,
        to: 'SUBMITTED',
        reason: `lawyer.qualification.${current === undefined ? 'submit' : from === 'REJECTED' ? 'resubmit' : 'revision'}:v${version}`,
        uow,
      });

      const licenseEnc = this.crypto.encryptIdentityField(licenseNo);
      await uow.query('SAVEPOINT lawyer_profile_submit');
      let profileId: number;
      try {
        if (current === undefined) {
          const inserted = await uow.query<{ id: string }>(
            `INSERT INTO identity.lawyer_profiles
               (user_id, license_no_enc, license_no_blind_idx, firm_name,
                material_version, material_fingerprint, audit_status, submitted_at, city)
             VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED', now(), $7)
             RETURNING id`,
            [
              userId,
              licenseEnc,
              licenseBlind,
              firmName ?? null,
              version,
              fingerprint,
              city ?? DEFAULT_PRACTICE_CITY,
            ],
          );
          profileId = Number(inserted.rows[0]!.id);
        } else {
          const updated = await uow.query<{ id: string }>(
            `UPDATE identity.lawyer_profiles SET
               license_no_enc = $1, license_no_blind_idx = $2, firm_name = $3,
               material_version = $4, material_fingerprint = $5, audit_status = 'SUBMITTED',
               submitted_at = now(), audited_at = NULL, auditor_id = NULL, reject_reason = NULL,
               city = COALESCE($6, city)
             WHERE id = $7 AND audit_status = $8
             RETURNING id`,
            [
              licenseEnc,
              licenseBlind,
              firmName ?? null,
              version,
              fingerprint,
              city ?? null, // 序 11.5：重提携带则更新、未携带保留原值（null=不改动）
              current.id,
              current.audit_status,
            ],
          );
          if (updated.rows.length === 0) {
            throw new AppError(
              ErrorCode.StateStaleEntity,
              `用户 ${userId} 的资质档案状态已被并发迁移`,
            );
          }
          profileId = Number(updated.rows[0]!.id);
        }
        await uow.query('RELEASE SAVEPOINT lawyer_profile_submit');
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // 并发唯一竞窗（user 唯一/盲索引唯一）：显式复检定位语义——不吞错、不盲重试。
        // 23505 后事务 abort，先 ROLLBACK TO SAVEPOINT 解除，再以新快照复检：
        // 同号被他人抢注 → 409 E_LICENSE_NO_TAKEN；同账号并发首提 → 409 ALREADY_SUBMITTED。
        await uow.query('ROLLBACK TO SAVEPOINT lawyer_profile_submit');
        const winner = await this.profileOfUser(uow, userId);
        if (
          winner &&
          (winner.audit_status === 'SUBMITTED' || winner.audit_status === 'IN_REVIEW')
        ) {
          throw new AppError(
            ErrorCode.AlreadySubmitted,
            '资质审核已在流程中（并发提交，以在先提交为准）',
          );
        }
        const licenseHolder = await this.profileIdByLicense(uow, licenseBlind);
        if (licenseHolder !== undefined && Number(licenseHolder) !== Number(winner?.id ?? -1)) {
          throw new AppError(
            ErrorCode.LicenseNoTaken,
            '执业证号已被其他账号使用（R-03，并发窗口）',
          );
        }
        throw new AppError(
          ErrorCode.InternalError,
          '资质提交唯一约束败退但复检未定位到现值（不应触达）',
        );
      }

      await this.insertQualificationFiles(uow, profileId, version, files);
      // PII 红线：日志只记 id/版本/件数，license_no 不落日志
      this.logger.log(
        `lawyer.qualification: 提交 user_id=${userId} profile_id=${profileId} version=${version} files=${files.length}`,
      );
      return { status: 'SUBMITTED', materialVersion: version };
    });
  }

  /**
   * 审核动作（自管事务形态，既有调用兼容）：auditorId 传 admin claims userId 时回填
   * auditor_id（⚠W3-8/G-A R-W2-G 绑定项）；服务级内部调用不传保持 NULL（历史行为）。
   * H1 ops 控制器（同一 HTTP 面）走 auditWithExecutor 与 ops 域审计表同事务缝合。
   */
  async audit(
    profileId: number,
    input: AuditActionInput,
    auditorId?: number,
  ): Promise<{ status: LawyerAuditStatus }> {
    return this.pool.withTransaction((uow) =>
      this.auditWithExecutor(uow, profileId, input, auditorId ?? null),
    );
  }

  /**
   * 审核动作（外部事务形态，W3 T10 H1 缝合点）：{id}=lawyer_profiles.id；全动作经守卫
   * （前置缺失=非法迁移拒绝并留痕）；approve/suspend 同事务发领域事件；每个动作都回填
   * auditor_id（auditorId=null=服务级内部调用，历史上恒 NULL 的兼容形态；存量 NULL 行
   * 不回填——历史不可变，新行必落）。
   */
  async auditWithExecutor(
    uow: SqlExecutor,
    profileId: number,
    input: AuditActionInput,
    auditorId: number | null,
  ): Promise<{ status: LawyerAuditStatus }> {
    if (auditorId !== null && !isPositiveInt(auditorId)) {
      throw new AppError(ErrorCode.InvalidArgument, 'auditor_id 必须为正整数或 null');
    }
    // action 专属必填项在事务外先校验（reject_reason/suspend reason；parseAuditActionBody 同规则）
    if (input.action === 'reject' && (!input.rejectReason || input.rejectReason.trim() === '')) {
      throw new AppError(ErrorCode.InvalidArgument, '拒绝必须携带 reject_reason');
    }
    if (input.action === 'suspend' && (!input.reason || input.reason.trim() === '')) {
      throw new AppError(ErrorCode.InvalidArgument, '停用必须携带 reason');
    }
    const to = ACTION_TO_STATUS[input.action];

    {
      const row = await this.profileByIdForUpdate(uow, profileId);
      if (row === undefined) {
        throw new AppError(ErrorCode.NotFound, `律师资质档案 ${profileId} 不存在`);
      }
      const userId = Number(row.user_id);
      await this.guard.assertTransition(LAWYER_AUDIT_MACHINE, {
        entityId: userId,
        from: row.audit_status,
        to,
        reason: `lawyer.audit.${input.action}`,
        uow,
      });

      const updates: Record<LawyerAuditAction, { set: string; values: unknown[] }> = {
        claim: { set: `audit_status = 'IN_REVIEW', auditor_id = $3`, values: [auditorId] },
        approve: {
          set: `audit_status = 'PASSED', audited_at = now(), auditor_id = $3`,
          values: [auditorId],
        },
        reject: {
          set: `audit_status = 'REJECTED', audited_at = now(), auditor_id = $3, reject_reason = $4`,
          values: [auditorId, input.rejectReason],
        },
        suspend: { set: `audit_status = 'SUSPENDED', auditor_id = $3`, values: [auditorId] },
        resume: { set: `audit_status = 'PASSED', auditor_id = $3`, values: [auditorId] },
      };
      const plan = updates[input.action];
      const updated = await uow.query<{ id: string }>(
        `UPDATE identity.lawyer_profiles SET ${plan.set}
          WHERE id = $1 AND audit_status = $2 RETURNING id`,
        [profileId, row.audit_status, ...plan.values],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `资质档案 ${profileId} 状态已被并发迁移`);
      }

      if (input.action === 'approve') {
        await this.outbox.recordOutbox(uow, {
          type: LAWYER_AUDIT_PASSED_TOPIC,
          payload: {
            lawyer_user_id: userId,
            firm_id: row.firm_id === null ? null : Number(row.firm_id), // A3b 进件前 null（简报裁决）
          } satisfies LawyerAuditPassedPayload,
        });
      }
      if (input.action === 'suspend') {
        await this.outbox.recordOutbox(uow, {
          type: LAWYER_SUSPENDED_TOPIC,
          payload: {
            lawyer_user_id: userId,
            reason: input.reason!,
          } satisfies LawyerSuspendedPayload,
        });
      }
      this.logger.log(
        `lawyer.audit: ${input.action} profile_id=${profileId} user_id=${userId} ${row.audit_status}→${to}`,
      );
      return { status: to };
    }
  }

  /** GET /lawyer/audit-status（本人视角）：无档案=DRAFT；REJECTED 附拒绝事由（§5 {status, reason?}） */
  async auditStatus(userId: number): Promise<AuditStatusView> {
    const found = await this.pool.query<{
      audit_status: LawyerAuditStatus;
      reject_reason: string | null;
    }>('SELECT audit_status, reject_reason FROM identity.lawyer_profiles WHERE user_id = $1', [
      userId,
    ]);
    const row = found.rows[0];
    if (row === undefined) return { status: 'DRAFT' };
    if (row.audit_status === 'REJECTED') {
      return { status: 'REJECTED', ...(row.reject_reason ? { reason: row.reject_reason } : {}) };
    }
    return { status: row.audit_status };
  }

  /** R-01 内部查询面（W3 C3 场次列表/接单大厅消费；本批交付查询面，列表联调=W3 桩 §10-1） */
  async isAuditPassed(lawyerUserId: number): Promise<boolean> {
    const found = await this.pool.query(
      `SELECT 1 FROM identity.lawyer_profiles WHERE user_id = $1 AND audit_status = 'PASSED'`,
      [lawyerUserId],
    );
    return found.rows.length > 0;
  }

  /**
   * 执业城市导出面（序 11.5 V33）：C1 开团/C2 发布物化 city 的唯一取数缝（禁 trade 直查
   * identity 表——跨模块取数走导出服务）。PASSED 返回 city（含缺省北京）；非 PASSED/无行
   * 返回 null（消费方兜底缺省）。与 isAuditPassed 同模块同形态导出。
   */
  async getPracticeCity(lawyerUserId: number): Promise<string | null> {
    const found = await this.pool.query<{ city: string }>(
      `SELECT city FROM identity.lawyer_profiles WHERE user_id = $1 AND audit_status = 'PASSED'`,
      [lawyerUserId],
    );
    return found.rows[0]?.city ?? null;
  }

  /**
   * 律所 id 导出面（M2-W1 T1 纯读加法，getPracticeCity 同形态）：D1 RoomClosed 聚合的
   * firm_id 取数缝（trade closeAnchorOf 消费——禁跨模块直查 identity 表）。档案 firm_id
   * 绑定=A3b 进件后回填（W3 前多 null）；无档案/未绑定返回 null，消费方显式失败不静默。
   */
  async getFirmId(lawyerUserId: number): Promise<number | null> {
    const found = await this.pool.query<{ firm_id: string | null }>(
      `SELECT firm_id FROM identity.lawyer_profiles WHERE user_id = $1`,
      [lawyerUserId],
    );
    const v = found.rows[0]?.firm_id;
    return v === null || v === undefined ? null : Number(v);
  }

  // ===========================================================================
  // H1 导出面（W3 T10）：工作台队列 / 档案视图（只读；H1 禁 join identity 表——架构 §3.2，
  // 经本服务面取数）。出参一律无 license 字段（PII 红线 §9）。
  // ===========================================================================

  /**
   * 入驻审核工作台队列（H1 GET /admin/lawyers 数据源）：statuses 缺省=审核队列
   * （SUBMITTED|IN_REVIEW）；提交时间 ASC（最久在审在前=SLA 剩余最小排序语义，H1 R-01 看板），
   * id ASC 稳定次序；分页（page 从 1 起，pageSize 上限 100）。
   */
  async listSubmissions(filter: {
    readonly statuses?: readonly LawyerAuditStatus[];
    readonly page?: number;
    readonly pageSize?: number;
  }): Promise<{ items: SubmissionQueueItem[]; total: number }> {
    const VALID: readonly LawyerAuditStatus[] = [
      'SUBMITTED',
      'IN_REVIEW',
      'PASSED',
      'REJECTED',
      'SUSPENDED',
    ];
    const statuses = filter.statuses ?? ['SUBMITTED', 'IN_REVIEW'];
    if (statuses.length === 0) {
      throw new AppError(ErrorCode.InvalidArgument, 'statuses 不能为空（缺省=审核队列）');
    }
    for (const s of statuses) {
      if (!VALID.includes(s)) {
        throw new AppError(ErrorCode.InvalidArgument, `status 非法：${String(s)}`);
      }
    }
    const page = filter.page ?? 1;
    const pageSize = Math.min(filter.pageSize ?? 20, 100);
    if (!isPositiveInt(page) || !isPositiveInt(filter.pageSize ?? 1)) {
      throw new AppError(ErrorCode.InvalidArgument, 'page/pageSize 必须为正整数');
    }

    const found = await this.pool.query<QueueRow>(
      `SELECT id, user_id, audit_status, firm_name, material_version, submitted_at
         FROM identity.lawyer_profiles
        WHERE audit_status = ANY($1::varchar[])
        ORDER BY submitted_at ASC NULLS LAST, id ASC
        LIMIT $2 OFFSET $3`,
      [statuses, pageSize, (page - 1) * pageSize],
    );
    const counted = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM identity.lawyer_profiles WHERE audit_status = ANY($1::varchar[])`,
      [statuses],
    );
    return {
      items: found.rows.map((r) => ({
        id: Number(r.id),
        lawyer_user_id: Number(r.user_id),
        audit_status: r.audit_status,
        firm_name: r.firm_name,
        material_version: r.material_version,
        submitted_at: r.submitted_at === null ? null : new Date(r.submitted_at).toISOString(),
      })),
      total: Number(counted.rows[0]?.n ?? 0),
    };
  }

  /**
   * 资质档案视图（H1 GET /admin/lawyers/{id}/profile 的 A3a 聚合源；{id}=lawyer_profiles.id）。
   * 只读导出：状态/用户/律所（firm_name/firm_id）/材料版本/提交与审核时刻/auditor_id；
   * 无 license 字段（PII 红线）；未知 id → undefined（H1 侧映射 404）。
   */
  async profileViewById(profileId: number): Promise<QualificationProfileView | undefined> {
    if (!isPositiveInt(profileId)) {
      throw new AppError(ErrorCode.InvalidArgument, 'lawyer_profiles.id 必须为正整数');
    }
    const found = await this.pool.query<ViewRow>(
      `SELECT id, user_id, firm_id, firm_name, city, audit_status, material_version,
              submitted_at, audited_at, auditor_id, reject_reason
         FROM identity.lawyer_profiles WHERE id = $1`,
      [profileId],
    );
    const r = found.rows[0];
    if (r === undefined) return undefined;
    return {
      id: Number(r.id),
      lawyer_user_id: Number(r.user_id),
      audit_status: r.audit_status,
      firm_name: r.firm_name,
      firm_id: r.firm_id === null ? null : Number(r.firm_id),
      city: r.city, // 序 11.5：执业城市登记面随审核带出（V33 NOT NULL 列，行必有）
      material_version: r.material_version,
      submitted_at: r.submitted_at === null ? null : new Date(r.submitted_at).toISOString(),
      audited_at: r.audited_at === null ? null : new Date(r.audited_at).toISOString(),
      auditor_id: r.auditor_id === null ? null : Number(r.auditor_id),
      ...(r.reject_reason === null ? {} : { reject_reason: r.reject_reason }),
    };
  }

  // ---------- 内部查询 ----------

  /** 本人档案（行锁：提交/审核串行化同一账号的状态判定） */
  private async profileOfUserForUpdate(
    uow: SqlExecutor,
    userId: number,
  ): Promise<LawyerProfileRow | undefined> {
    const found = await uow.query<LawyerProfileRow>(
      `SELECT id, user_id, firm_id, audit_status, material_version, material_fingerprint
         FROM identity.lawyer_profiles WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    return found.rows[0];
  }

  /** 本人档案（无锁读：查询面/竞窗复检） */
  private async profileOfUser(
    uow: SqlExecutor,
    userId: number,
  ): Promise<LawyerProfileRow | undefined> {
    const found = await uow.query<LawyerProfileRow>(
      `SELECT id, user_id, firm_id, audit_status, material_version, material_fingerprint
         FROM identity.lawyer_profiles WHERE user_id = $1`,
      [userId],
    );
    return found.rows[0];
  }

  private async profileByIdForUpdate(
    uow: SqlExecutor,
    profileId: number,
  ): Promise<LawyerProfileRow | undefined> {
    const found = await uow.query<LawyerProfileRow>(
      `SELECT id, user_id, firm_id, audit_status, material_version, material_fingerprint
         FROM identity.lawyer_profiles WHERE id = $1 FOR UPDATE`,
      [profileId],
    );
    return found.rows[0];
  }

  /** R-03 盲索引等值检索（无锁：唯一性由 ux_lawyer_profiles_license 兜底，竞窗显式复检） */
  private async profileIdByLicense(
    uow: SqlExecutor,
    licenseBlind: string,
  ): Promise<string | undefined> {
    const found = await uow.query<{ id: string }>(
      'SELECT id FROM identity.lawyer_profiles WHERE license_no_blind_idx = $1',
      [licenseBlind],
    );
    return found.rows[0]?.id;
  }

  /** 材料新版本行（旧版本保留追溯；单语句原子插入，ref 仅引用文本 R-W2-7） */
  private async insertQualificationFiles(
    uow: SqlExecutor,
    profileId: number,
    version: number,
    files: readonly QualificationFileInput[],
  ): Promise<void> {
    await uow.query(
      `INSERT INTO identity.qualification_files (lawyer_id, material_version, file_ref, kind)
       SELECT $1, $2, f.ref, f.kind FROM unnest($3::text[], $4::text[]) AS f(ref, kind)`,
      [profileId, version, files.map((f) => f.ref), files.map((f) => f.kind)],
    );
  }
}
