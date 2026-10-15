/**
 * 身份事件消费者（A1 §6 消费）：
 *   - LawyerAuditPassed（A3a 生产，本批 Task 3 前以合成事件钉契约）：授予 lawyer role——
 *     user_roles PK 幂等（ON CONFLICT DO NOTHING），at-least-once 重投零副作用；
 *     firm_id 随契约定型但 A1 不落表（律所归属属 trade/pricing 域）。
 *   - AccountDeletionExecuted（A4=M4 生产）：users.status → DELETING，经状态机守卫+留痕
 *     （禁裸写）；已 DELETING 幂等短路（重投仍 SENT，无重复留痕）。
 *
 * 角色提升只在本模块「消费」不「生产」（§9 禁止：本模块不做角色提升逻辑的生产方）。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  ACCOUNT_DELETION_EXECUTED_TOPIC,
  AccountDeletionExecutedPayload,
  LAWYER_AUDIT_PASSED_TOPIC,
  LawyerAuditPassedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import type { UserStatus } from './identity.machine';
import { USER_MACHINE } from './identity.machine';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 独立可测的消费者逻辑（两个 topic 共用，按 topic 分流） */
export function createIdentityUserHandler(guard: StateTransitionGuardService): OutboxHandler {
  return async (event: RelayEvent, uow: SqlExecutor): Promise<void> => {
    if (event.topic === LAWYER_AUDIT_PASSED_TOPIC) {
      const payload = (event.payload ?? {}) as Partial<LawyerAuditPassedPayload>;
      if (!isPositiveInt(payload.lawyer_user_id) || !isPositiveInt(payload.firm_id)) {
        throw new AppError(
          ErrorCode.InvalidArgument,
          `事件 ${event.topic} 载荷缺 lawyer_user_id/firm_id（进重试轨道，不静默丢弃）`,
        );
      }
      // 幂等授予：PK(user_id, role) 兜底，重投插 0 行即短路
      await uow.query(
        "INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'lawyer') ON CONFLICT DO NOTHING",
        [payload.lawyer_user_id],
      );
      return;
    }

    // ACCOUNT_DELETION_EXECUTED_TOPIC
    const payload = (event.payload ?? {}) as Partial<AccountDeletionExecutedPayload>;
    if (!isPositiveInt(payload.user_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `事件 ${event.topic} 载荷缺 user_id（进重试轨道，不静默丢弃）`,
      );
    }
    const current = await uow.query<{ status: UserStatus }>(
      'SELECT status FROM identity.users WHERE id = $1 FOR UPDATE',
      [payload.user_id],
    );
    const user = current.rows[0];
    if (!user) {
      throw new AppError(
        ErrorCode.NotFound,
        `注销事件指向的用户 ${payload.user_id} 不存在（进重试轨道）`,
      );
    }
    if (user.status === 'DELETING') return; // at-least-once 重投：幂等短路
    await guard.assertTransition(USER_MACHINE, {
      entityId: payload.user_id,
      from: user.status,
      to: 'DELETING',
      reason: 'account.deletion.executed',
      uow,
    });
    const updated = await uow.query(
      "UPDATE identity.users SET status = 'DELETING' WHERE id = $1 AND status = $2 RETURNING id",
      [payload.user_id, user.status],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `用户 ${payload.user_id} 状态已被并发迁移`);
    }
  };
}

@Injectable()
export class IdentityUserConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly guard: StateTransitionGuardService,
  ) {}

  onModuleInit(): void {
    const handler = createIdentityUserHandler(this.guard);
    this.relay.registerHandler(LAWYER_AUDIT_PASSED_TOPIC, handler);
    this.relay.registerHandler(ACCOUNT_DELETION_EXECUTED_TOPIC, handler);
  }
}
