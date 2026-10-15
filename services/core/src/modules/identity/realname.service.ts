/**
 * A2 实名认证领域服务（docs/modules/A-身份与账号/A2 §2/§5/§7）。
 *
 * 关键流程（§2/§4 状态机 NONE→PENDING→VERIFIED/FAILED）：
 *   提交：形态防呆（400 INVALID_ID，不触达通道）→ 已 VERIFIED 幂等短路（幂等键=user）
 *         → 守卫 ?→PENDING → 通道适配器核验 → PENDING→VERIFIED（同事务落行+outbox）/
 *           PENDING→FAILED（仅 STL 留痕，可重提 FAILED→PENDING）
 *   查询：GET /realname/status 出 {status, verified_at}；isRealnameVerified=R-01 闸口
 *         内部查询面（W3 C3/F1 消费；「未实名支付被拦」=W3 联调桩 §10-1）
 *   受控解密（R-04，裁决 R-W2-5）：approval_id 指向完整双签审批 → 临时解密返回 + 审计留痕
 *
 * PII 红线（§9 禁止）：姓名/证件号明文只存在于请求入参与通道适配器入参；落库仅密文/摘要，
 * 日志只记 user_id/长度/摘要前缀，事件载荷仅 user_id。
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  REAL_NAME_VERIFIED_TOPIC,
  type RealNameVerifiedPayload,
} from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { IdentityCryptoService } from './identity.crypto';
import type { RealnameStatus } from './realname.machine';
import { REALNAME_MACHINE } from './realname.machine';
import { REALNAME_CONFIG, type RealnameConfig } from './realname.config';
import {
  assertRealnameIdNoFormat,
  assertRealnameName,
  REALNAME_PROVIDER,
  type RealnameProvider,
} from './realname.provider';

export interface RealnameSubmitInput {
  readonly name: string;
  readonly idNo: string;
}

export interface RealnameSubmitResult {
  readonly status: 'VERIFIED' | 'FAILED';
  /** VERIFIED 时返回；FAILED 可重提（§4） */
  readonly verifiedAt?: Date;
}

export interface RealnameStatusView {
  readonly status: RealnameStatus;
  /** 仅 VERIFIED 有值；R-05 对外出参不含任何实名信息本体 */
  readonly verifiedAt?: Date;
}

export interface DecryptInput {
  readonly userId: number;
  readonly reason: string;
  readonly approvalId: number;
}

interface RealnameRow {
  readonly verified_at: Date;
  readonly name_enc: Buffer | null;
  readonly id_no_enc: Buffer | null;
}

interface ApprovalRow {
  readonly user_id: string;
  readonly approved_by: string | null;
  readonly reviewed_by: string | null;
}

/** 并发提交窗口的约束败退（23505）→ 幂等读回现值（uk: real_name_infos.user_id 唯一） */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

@Injectable()
export class RealnameService {
  private readonly logger = new Logger(RealnameService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly crypto: IdentityCryptoService,
    @Inject(REALNAME_PROVIDER) private readonly provider: RealnameProvider,
    @Inject(REALNAME_CONFIG) private readonly config: RealnameConfig,
  ) {}

  /** POST /realname（幂等键=user）：形态防呆 → 幂等短路 → 守卫迁移 → 通道核验 */
  async submitRealname(userId: number, input: RealnameSubmitInput): Promise<RealnameSubmitResult> {
    // 形态层：400 INVALID_ID 即刻拒绝，不触达通道、不产生任何状态迁移（§5）
    const name = assertRealnameName(input.name);
    const idNo = assertRealnameIdNoFormat(input.idNo);

    const existing = await this.verifiedRowOf(this.pool, userId);
    if (existing) {
      return { status: 'VERIFIED', verifiedAt: existing.verified_at }; // 已 VERIFIED 再提交返回现值，不重复核验
    }

    return this.pool.withTransaction(async (uow) => {
      const current = await this.deriveState(uow, userId);
      if (current === 'VERIFIED') {
        const row = await this.verifiedRowOf(uow, userId);
        return { status: 'VERIFIED', verifiedAt: row?.verified_at };
      }
      await this.guard.assertTransition(REALNAME_MACHINE, {
        entityId: userId,
        from: current,
        to: 'PENDING',
        reason: 'realname.submit',
        uow,
      });

      // 通道调用（mock 同步即时；真通道 P95≤3s 时应移出事务改两阶段提交——prod 换装适配位）
      const verdict = await this.provider.verify({ name, idNo });

      if (verdict.passed) {
        await this.guard.assertTransition(REALNAME_MACHINE, {
          entityId: userId,
          from: 'PENDING',
          to: 'VERIFIED',
          reason: `realname.passed:${this.provider.kind}`,
          uow,
        });
        const inserted = await this.insertVerifiedRow(uow, userId, idNo, name, verdict.token);
        if (inserted.wonRace) {
          // 事件归属首访事务：并发败退方不再发（同一次核验单事件，消费侧 at-least-once 不背重复）
          await this.outbox.recordOutbox(uow, {
            type: REAL_NAME_VERIFIED_TOPIC,
            payload: { user_id: userId } satisfies RealNameVerifiedPayload,
          });
          // PII 红线：日志只记 user_id 与摘要前缀，姓名/证件号不落日志
          this.logger.log(
            `realname: 核验通过 user_id=${userId} provider=${this.provider.kind} token_digest=${sha256Hex(verdict.token).slice(0, 8)}…`,
          );
        }
        return { status: 'VERIFIED', verifiedAt: inserted.verifiedAt };
      }

      await this.guard.assertTransition(REALNAME_MACHINE, {
        entityId: userId,
        from: 'PENDING',
        to: 'FAILED',
        reason: 'realname.rejected_by_provider',
        uow,
      });
      this.logger.warn(
        `realname: 通道否决 user_id=${userId} provider=${this.provider.kind}（可重提）`,
      );
      return { status: 'FAILED' };
    });
  }

  /** GET /realname/status（本人；R-05 出参仅 status/verified_at） */
  async realnameStatus(userId: number): Promise<RealnameStatusView> {
    const row = await this.verifiedRowOf(this.pool, userId);
    if (row) return { status: 'VERIFIED', verifiedAt: row.verified_at };
    return { status: await this.deriveState(this.pool, userId) };
  }

  /** R-01 实名闸口内部查询面（W3 C3/F1 下单前调用；RealnameConsentModule 导出） */
  async isRealnameVerified(userId: number): Promise<boolean> {
    return (await this.verifiedRowOf(this.pool, userId)) !== undefined;
  }

  /**
   * 受控解密（R-04，§5 GET /admin/realname/decrypt）：approval_id 须指向「双签完整且与
   * user_id 一致」的审批行；否则 403 NOT_APPROVED（无/不完整/指向不符同码，不泄露审批存在性）。
   * 审计留痕=应用日志（自定形态，R-W2-5；H9=M4 建正式审计存储）。临时解密：不改变任何状态。
   */
  async decryptForCompliance(input: DecryptInput): Promise<{ name: string; idNo: string }> {
    const approval = await this.pool.query<ApprovalRow>(
      'SELECT user_id, approved_by, reviewed_by FROM identity.decrypt_approvals WHERE id = $1',
      [input.approvalId],
    );
    const row = approval.rows[0];
    if (
      row === undefined ||
      Number(row.user_id) !== input.userId ||
      row.approved_by === null ||
      row.reviewed_by === null
    ) {
      // 无/不完整/指向不符统一 403 同码：不泄露审批记录存在性（§5 NOT_APPROVED，裁决 R-W2-5）
      this.logger.warn(
        `realname.decrypt 拒绝：approval_id=${input.approvalId} 缺失/未双签/指向不符（请求方 user_id=${input.userId}）`,
      );
      throw new AppError(ErrorCode.NotApproved);
    }

    const target = await this.verifiedRowOf(this.pool, input.userId);
    if (!target) {
      throw new AppError(ErrorCode.NotFound, `用户 ${input.userId} 无实名记录可解密`);
    }
    if (!target.name_enc || !target.id_no_enc) {
      throw new AppError(
        ErrorCode.NotFound,
        '该实名记录未留存密文（R-04 密文最小化，仅摘要），无解密内容',
      );
    }
    const name = this.crypto.decryptIdentityField(target.name_enc, 'name_enc');
    const idNo = this.crypto.decryptIdentityField(target.id_no_enc, 'id_no_enc');
    // 「解密操作全审计」（§8）：日志留痕含审批三方与事由（事由=合规信息非 PII）；明文姓名/证件号禁入
    this.logger.log(
      `realname.decrypt 审计：approval_id=${input.approvalId} user_id=${input.userId} ` +
        `approved_by=${row.approved_by} reviewed_by=${row.reviewed_by} reason=${input.reason}`,
    );
    return { name, idNo };
  }

  /** VERIFIED 行（现值事实源：user_id 唯一，一账号至多一条） */
  private async verifiedRowOf(exec: SqlExecutor, userId: number): Promise<RealnameRow | undefined> {
    const found = await exec.query<RealnameRow>(
      `SELECT verified_at, name_enc, id_no_enc FROM identity.real_name_infos WHERE user_id = $1`,
      [userId],
    );
    return found.rows[0];
  }

  /**
   * 现行状态推导（real_name_infos 无状态列，§3 原文）：VERIFIED=行存在；其余态的持久化形态
   * 是 STL（经守卫写入），取该实体最近一条放行迁移的 to_status；无任何记录=NONE。
   */
  private async deriveState(exec: SqlExecutor, userId: number): Promise<RealnameStatus> {
    const last = await exec.query<{ to_status: RealnameStatus }>(
      `SELECT to_status FROM platform.state_transition_log
        WHERE entity_type = $1 AND entity_id = $2 AND allowed = true
        ORDER BY id DESC LIMIT 1`,
      [REALNAME_MACHINE.def.entityType, userId],
    );
    return last.rows[0]?.to_status ?? 'NONE';
  }

  /** 核验通过落行结果：verifiedAt 恒为首访现值；wonRace=false=并发败退（首访事务已落行并发事件） */
  private async insertVerifiedRow(
    uow: SqlExecutor,
    userId: number,
    idNo: string,
    name: string,
    token: string,
  ): Promise<{ verifiedAt: Date; wonRace: boolean }> {
    const digest = sha256Hex(token);
    await uow.query('SAVEPOINT realname_verified_insert');
    try {
      const inserted = await uow.query<{ verified_at: Date }>(
        `INSERT INTO identity.real_name_infos (user_id, verify_provider, verify_token_digest, name_enc, id_no_enc, verified_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING verified_at`,
        [
          userId,
          this.provider.kind,
          digest,
          this.config.retainIdentityText ? this.crypto.encryptIdentityField(name) : null,
          this.config.retainIdentityText ? this.crypto.encryptIdentityField(idNo) : null,
        ],
      );
      await uow.query('RELEASE SAVEPOINT realname_verified_insert');
      return { verifiedAt: inserted.rows[0]!.verified_at, wonRace: true };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // 并发双提交：user 唯一约束败退。23505 后事务已 abort，同 uow 直接读回必 25P02
      // （Important-1：原实现的「幂等读回」是死代码）——先 ROLLBACK TO SAVEPOINT 解除 abort 态，
      // 再同事务读回首访现值；事务继续提交（仅 STL 多一行同向守卫留痕），事件由首访事务发。
      await uow.query('ROLLBACK TO SAVEPOINT realname_verified_insert');
      const row = await this.verifiedRowOf(uow, userId);
      if (!row) {
        throw new AppError(ErrorCode.InternalError, '实名并发败退后无现值行（不应触达）');
      }
      return { verifiedAt: row.verified_at, wonRace: false };
    }
  }
}

/** verify_token_digest：sha256 hex64（凭据原文即弃，R-04） */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
