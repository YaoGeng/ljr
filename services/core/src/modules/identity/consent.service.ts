/**
 * A2 同意管理领域服务（docs/modules/A-身份与账号/A2 §2/§5/§7，R-02/R-03）。
 *
 * 关键流程（§4 状态机 ABSENT→GRANTED→REVOKED，可再 GRANTED=新行）：
 *   授权：policy_version ≠ 当前有效值（R-W2-6 config）→ 409 VERSION_MISMATCH（守卫前拒绝）；
 *         accept=false → 不写任何行/不留痕（R-02 拒绝路径，{status:'ABSENT'}）
 *         → 守卫 ?→GRANTED → INSERT 新行（活跃部分唯一索引 ux_consent_active 兜底并发，
 *         败退方幂等读回现值）→ TrainingConsentGranted 同事务 outbox
 *   撤回：现行状态=同 user+scope 最新行；无行/已 REVOKED 幂等短路；GRANTED → 守卫
 *         GRANTED→REVOKED → 原行原位 UPDATE（不另起行）→ TrainingConsentRevoked
 *
 * scope 边界：本批写入面仅 training；realname 同意记录=real_name_infos 行本身，
 * recording 房间级映射=D5 consent_records（M2）——两 scope 本批无写入方。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  TRAINING_CONSENT_GRANTED_TOPIC,
  TRAINING_CONSENT_REVOKED_TOPIC,
  type TrainingConsentGrantedPayload,
  type TrainingConsentRevokedPayload,
} from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { CONSENT_CONFIG, type ConsentConfig } from './consent.config';
import type { ConsentScope, ConsentStatus } from './consent.machine';
import { CONSENT_MACHINE } from './consent.machine';

const TRAINING_SCOPE: ConsentScope = 'training';

export interface TrainingGrantInput {
  readonly policyVersion: string;
  readonly accept: boolean;
}

export interface TrainingGrantResult {
  readonly status: ConsentStatus;
  readonly policyVersion: string;
  readonly grantedAt?: Date;
}

export interface TrainingRevokeResult {
  readonly status: ConsentStatus;
  readonly revokedAt?: Date;
}

export interface TrainingConsentView {
  readonly status: ConsentStatus;
  readonly policyVersion?: string;
  readonly grantedAt?: Date;
  readonly revokedAt?: Date;
}

interface ConsentRow {
  readonly id: string;
  readonly status: 'GRANTED' | 'REVOKED';
  readonly policy_version: string;
  readonly granted_at: Date | null;
  readonly revoked_at: Date | null;
}

/** 授权并发窗口的活跃态唯一败退（23505, ux_consent_active）→ 幂等读回现值 */
function isActiveUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    @Inject(CONSENT_CONFIG) private readonly config: ConsentConfig,
  ) {}

  /**
   * POST /consents/training（幂等键=user+policy_version）：版本闸（R-W2-6）→ 拒绝路径
   * （R-02：不写行不留痕不降级）→ 守卫迁移 → 新行 + 事件（同版本已 GRANTED 幂等返回现值）。
   */
  async grantTraining(userId: number, input: TrainingGrantInput): Promise<TrainingGrantResult> {
    if (typeof input.policyVersion !== 'string' || input.policyVersion === '') {
      throw new AppError(ErrorCode.InvalidArgument, 'policy_version 必须为非空字符串');
    }
    if (input.policyVersion !== this.config.trainingPolicyVersion) {
      // 版本闸在守卫前：错版本请求不产生任何状态迁移留痕（§5 409 VERSION_MISMATCH）
      throw new AppError(
        ErrorCode.VersionMismatch,
        `policy_version ${input.policyVersion} 与当前有效版本不一致（当前=${this.config.trainingPolicyVersion}）`,
      );
    }
    if (input.accept !== true) {
      // R-02 拒绝路径：拒绝授权不落行/不留痕/不降级——未授权即 ABSENT，其余功能不受影响
      return { status: 'ABSENT', policyVersion: input.policyVersion };
    }

    return this.pool.withTransaction(async (uow) => {
      const current = await this.latestRow(uow, userId);
      const currentStatus: ConsentStatus = current?.status ?? 'ABSENT';
      if (current !== undefined && current.status === 'GRANTED') {
        // 同 (user, scope) 已 GRANTED：唯一有效版本下必同版本 → 返回现值（幂等，§3 注）
        return {
          status: 'GRANTED',
          policyVersion: current.policy_version,
          grantedAt: current.granted_at ?? undefined,
        };
      }
      await this.guard.assertTransition(CONSENT_MACHINE, {
        entityId: userId,
        from: currentStatus,
        to: 'GRANTED',
        reason: `consent.grant:${TRAINING_SCOPE}:policy=${input.policyVersion}`,
        uow,
      });
      let grantedAt: Date;
      try {
        const inserted = await uow.query<{ granted_at: Date }>(
          `INSERT INTO identity.consents (user_id, scope, status, policy_version, granted_at)
           VALUES ($1, $2, 'GRANTED', $3, now()) RETURNING granted_at`,
          [userId, TRAINING_SCOPE, input.policyVersion],
        );
        grantedAt = inserted.rows[0]!.granted_at;
      } catch (e) {
        if (!isActiveUniqueViolation(e)) throw e;
        // 并发双授权：活跃唯一索引败退方幂等读回首访现值
        const active = await this.activeRow(uow, userId);
        if (!active || active.granted_at === null) {
          throw new AppError(ErrorCode.InternalError, '授权并发败退后无活跃行（不应触达）');
        }
        return { status: 'GRANTED', policyVersion: active.policy_version, grantedAt: active.granted_at };
      }
      await this.outbox.recordOutbox(uow, {
        type: TRAINING_CONSENT_GRANTED_TOPIC,
        payload: {
          user_id: userId,
          policy_version: input.policyVersion,
        } satisfies TrainingConsentGrantedPayload,
      });
      this.logger.log(`consent: training 授权 user_id=${userId} policy=${input.policyVersion}`);
      return { status: 'GRANTED', policyVersion: input.policyVersion, grantedAt };
    });
  }

  /** POST /consents/training/revoke：原行原位迁移；无授权幂等（R-03 撤回链路起点） */
  async revokeTraining(userId: number): Promise<TrainingRevokeResult> {
    return this.pool.withTransaction(async (uow) => {
      const current = await this.latestRow(uow, userId);
      if (current === undefined) {
        // 无授权：幂等短路（ABSENT），不留痕、不发事件
        return { status: 'ABSENT' };
      }
      if (current.status === 'REVOKED') {
        // 已撤回：幂等返回现值，不重复迁移留痕、不重复发事件
        return { status: 'REVOKED', revokedAt: current.revoked_at ?? undefined };
      }
      await this.guard.assertTransition(CONSENT_MACHINE, {
        entityId: userId,
        from: 'GRANTED',
        to: 'REVOKED',
        reason: `consent.revoke:${TRAINING_SCOPE}`,
        uow,
      });
      const updated = await uow.query<{ id: string; revoked_at: Date }>(
        `UPDATE identity.consents SET status = 'REVOKED', revoked_at = now()
          WHERE id = $1 AND status = 'GRANTED' RETURNING id, revoked_at`,
        [current.id],
      );
      if (updated.rows.length === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `用户 ${userId} 的授权已被并发迁移`);
      }
      const revokedAt = updated.rows[0]!.revoked_at;
      await this.outbox.recordOutbox(uow, {
        type: TRAINING_CONSENT_REVOKED_TOPIC,
        payload: {
          user_id: userId,
          revoked_at: revokedAt.toISOString(),
        } satisfies TrainingConsentRevokedPayload,
      });
      this.logger.log(
        `consent: training 撤回 user_id=${userId}（D5/I3 删除执行随之，R-03）revoked_at=${revokedAt.toISOString()}`,
      );
      return { status: 'REVOKED', revokedAt };
    });
  }

  /** GET /consents/training：设置中心授权状态查询（§2 做项，§5 契约表缺口——报告回写项） */
  async trainingConsentStatus(userId: number): Promise<TrainingConsentView> {
    const row = await this.latestRow(this.pool, userId);
    if (!row) return { status: 'ABSENT' };
    return {
      status: row.status,
      policyVersion: row.policy_version,
      grantedAt: row.granted_at ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
    };
  }

  /** 同 user+scope 最新行（现行状态事实源；无行=ABSENT） */
  private async latestRow(uow: SqlExecutor, userId: number): Promise<ConsentRow | undefined> {
    const found = await uow.query<ConsentRow>(
      `SELECT id, status, policy_version, granted_at, revoked_at FROM identity.consents
        WHERE user_id = $1 AND scope = $2 ORDER BY id DESC LIMIT 1`,
      [userId, TRAINING_SCOPE],
    );
    return found.rows[0];
  }

  /** 活跃行（并发败退后的幂等读回） */
  private async activeRow(uow: SqlExecutor, userId: number): Promise<ConsentRow | undefined> {
    const found = await uow.query<ConsentRow>(
      `SELECT id, status, policy_version, granted_at, revoked_at FROM identity.consents
        WHERE user_id = $1 AND scope = $2 AND status = 'GRANTED' LIMIT 1`,
      [userId, TRAINING_SCOPE],
    );
    return found.rows[0];
  }
}
