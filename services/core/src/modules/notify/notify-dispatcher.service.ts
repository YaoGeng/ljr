/**
 * 通知下发服务（I1 §4 关键流程：事件消费 → 模板渲染 → 偏好过滤 → 通道下发 → 回执更新；失败重试 3 次）。
 *
 * 两段式驱动（重试需要时间维度的间隔，单事务内同步重试无意义）：
 *   1) 登记：业务模块事务内直调本服务（C6 registerForEvent / DISPATCH_NOTIFY §5）把触达请求幂等落表
 *      （INSERT ... ON CONFLICT (idempotency_key) DO NOTHING——R-03 同键一次触达，DB 唯一约束兜底）；
 *   2) 下发：processPending() 拾取 QUEUED 逐条处理；单条内 SELECT ... FOR UPDATE 行锁 + 条件更新，
 *      并发 worker 争用同行使输方读到 0 行（gone）短路——效果与 SKIP LOCKED 抢占等价且不会双发；
 *      渲染 → 偏好过滤 → 通道适配 → 守卫迁移状态（QUEUED→SENT/SKIPPED/FAILED）→
 *      NotificationDispatched 与回执同事务落 outbox（§6 →H4 触达率）。
 *   失败重试：通道失败 retry_count+1 仍 QUEUED，由 worker 下一轮重试；失败计数超上限
 *   （默认 3 次重试，⚠决策位=模块文档 §4 默认值）→ FAILED 终态。计数口径同 platform.outbox。
 *
 * 通知路径（N-1 终审收口）：业务模块事务内直调 NotifyDispatcherService；话题式事件扇出消费者
 * （占位 topic 全仓零生产方）已移除，待 I1 契约定型后 M2 按新契约重建。
 */
import { Injectable, Optional } from '@nestjs/common';
import { AppError, ErrorCode, isValidIdempotencyKey } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import type { SqlExecutor } from '../../infrastructure/sql';
import { PgPoolService } from '../../infrastructure/sql';
import { notifyConfigFromEnv, type NotifyConfig } from './notify.config';
import { NotifyChannelRegistry, type NotifyChannel } from './notify.channels';
import { NOTIFICATION_MACHINE, type NotificationStatus } from './notify.machine';
import { NotifyPrefsService } from './notify-prefs.service';
import {
  NotifyTemplateService,
  renderTemplate,
  type NotifyTemplate,
} from './notify-template.service';

/** I1 生产事件（§6）：NotificationDispatched{id, template_code, status} → H4 触达率 */
export const NOTIFY_DISPATCHED_TOPIC = 'notify.notification.dispatched';

/** §5 内部 DISPATCH_NOTIFY 契约 {user_id, template_code, params, idempotency_key} */
export interface NotifyDispatchInput {
  readonly userId: number;
  readonly templateCode: string;
  readonly params?: Record<string, unknown>;
  readonly idempotencyKey: string;
}

export interface NotifyDispatchAccepted {
  readonly notificationId: number;
  readonly status: NotificationStatus;
  /** true=同幂等键的重复请求，返回首访登记（R-03：一次触达） */
  readonly deduplicated: boolean;
}

export interface DispatchTickResult {
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly retried: number;
  /** 拾取时已非 QUEUED（被并发 worker 迁移），本轮跳过 */
  readonly gone: number;
}

export interface InboxItem {
  readonly id: number;
  readonly templateCode: string;
  readonly channel: NotifyChannel;
  readonly status: NotificationStatus;
  readonly params: Record<string, unknown>;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
}

interface QueuedRow {
  readonly id: string;
  readonly user_id: string;
  readonly channel: NotifyChannel;
  readonly template_code: string;
  readonly params: Record<string, unknown> | null;
  readonly retry_count: number;
}

@Injectable()
export class NotifyDispatcherService {
  private readonly config: NotifyConfig;

  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
    private readonly templates: NotifyTemplateService,
    private readonly prefs: NotifyPrefsService,
    private readonly registry: NotifyChannelRegistry,
    @Optional() config?: NotifyConfig,
  ) {
    this.config = config ?? notifyConfigFromEnv();
  }

  /** §5 内部 DISPATCH_NOTIFY：幂等登记为 QUEUED，实际下发由 processPending 驱动 */
  async dispatch(input: NotifyDispatchInput): Promise<NotifyDispatchAccepted> {
    if (!isValidIdempotencyKey(input.idempotencyKey)) {
      throw new AppError(
        ErrorCode.IdempotencyKeyInvalid,
        `非法幂等键：${JSON.stringify(input.idempotencyKey)}（规范 domain/entity/event）`,
      );
    }
    return this.pool.withTransaction((uow) =>
      this.registerQueued(uow, {
        userId: input.userId,
        templateCode: input.templateCode,
        params: input.params ?? {},
        idempotencyKey: input.idempotencyKey,
      }),
    );
  }

  /** 业务模块事务内登记入口（C6 改价等经 uow 同事务调用；幂等键由调用方按 shared 规范给定） */
  async registerForEvent(
    uow: SqlExecutor,
    req: {
      readonly userId: number;
      readonly templateCode: string;
      readonly params?: Record<string, unknown>;
      readonly idempotencyKey: string;
    },
  ): Promise<NotifyDispatchAccepted> {
    return this.registerQueued(uow, {
      userId: req.userId,
      templateCode: req.templateCode,
      params: req.params ?? {},
      idempotencyKey: req.idempotencyKey,
    });
  }

  /**
   * 单轮下发驱动（测试/worker 手动驱动，语义同 relay.tick）：拾取 QUEUED 逐条处理。
   * 一轮内每条至多尝试一次；失败退避由调用节奏决定（worker interval）。
   */
  async processPending(limit = 100): Promise<DispatchTickResult> {
    const picked = await this.pool.query<{ id: string }>(
      `SELECT id FROM notify.notifications WHERE status = 'QUEUED' ORDER BY id LIMIT $1`,
      [limit],
    );
    const result = { sent: 0, skipped: 0, failed: 0, retried: 0, gone: 0 };
    for (const row of picked.rows) {
      const outcome = await this.processOne(Number(row.id));
      result[outcome] += 1;
    }
    return result;
  }

  /** 站内信列表（§5 GET /notifications/mine）：本用户的 INBOX 已发通知 */
  async listInbox(userId: number, limit = 50): Promise<InboxItem[]> {
    const res = await this.pool.query<{
      id: string;
      template_code: string;
      channel: NotifyChannel;
      status: NotificationStatus;
      params: Record<string, unknown> | null;
      sent_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, template_code, channel, status, params, sent_at, created_at
         FROM notify.notifications
        WHERE user_id = $1 AND channel = 'INBOX' AND status = 'SENT'
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      templateCode: r.template_code,
      channel: r.channel,
      status: r.status,
      params: r.params ?? {},
      sentAt: r.sent_at,
      createdAt: r.created_at,
    }));
  }

  /**
   * 幂等登记（消费与内部接口共用）：模板 channel 落行，UNIQUE(idempotency_key) 兜底——
   * 重复键插 0 行 → 读回首访行短路（效果只发生一次）。
   */
  private async registerQueued(
    uow: SqlExecutor,
    req: {
      readonly userId: number;
      readonly templateCode: string;
      readonly params: Record<string, unknown>;
      readonly idempotencyKey: string;
    },
  ): Promise<NotifyDispatchAccepted> {
    const template = await this.templates.findByCode(uow, req.templateCode);
    const claim = await uow.query<{ id: string }>(
      `INSERT INTO notify.notifications (user_id, channel, template_code, params, idempotency_key)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        req.userId,
        template.channel,
        req.templateCode,
        JSON.stringify(req.params),
        req.idempotencyKey,
      ],
    );
    if ((claim.rowCount ?? 0) > 0) {
      return { notificationId: Number(claim.rows[0]?.id), status: 'QUEUED', deduplicated: false };
    }
    const prev = await uow.query<{ id: string; status: NotificationStatus }>(
      `SELECT id, status FROM notify.notifications WHERE idempotency_key = $1`,
      [req.idempotencyKey],
    );
    const first = prev.rows[0];
    if (!first) {
      throw new AppError(ErrorCode.InternalError, '通知幂等台账缺首访结果（不应触达）');
    }
    return { notificationId: Number(first.id), status: first.status, deduplicated: true };
  }

  /** 单条下发：渲染 → 偏好 → 通道 → 回执；全部状态推进经守卫（状态禁裸写） */
  private async processOne(
    id: number,
  ): Promise<'sent' | 'skipped' | 'failed' | 'retried' | 'gone'> {
    return this.pool.withTransaction(async (uow) => {
      // 行锁读 + 条件更新兜底并发（同 demo 口径）；行已非 QUEUED = 被并发迁移，跳过
      const current = await uow.query<QueuedRow>(
        `SELECT id, user_id, channel, template_code, params, retry_count
           FROM notify.notifications
          WHERE id = $1 AND status = 'QUEUED'
          FOR UPDATE`,
        [id],
      );
      const row = current.rows[0];
      if (!row) return 'gone';

      const params = row.params ?? {};

      // 1) 模板渲染（模板缺失属确定性错误：不重试，直接 FAILED 终态；
      //    其余异常（连接抖动等）原样上抛 → 事务回滚，本轮不计入，下轮重拾取）
      let template: NotifyTemplate | null = null;
      try {
        template = await this.templates.findByCode(uow, row.template_code);
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== ErrorCode.NotFound) throw e;
      }
      if (!template) {
        await this.terminal(uow, row, 'FAILED', `模板缺失：${row.template_code}`, row.retry_count);
        return 'failed';
      }

      // 2) 偏好过滤（§4 第 3 步）：关闭的非关键类 → SKIPPED
      if (!(await this.prefs.isDeliverable(Number(row.user_id), row.template_code))) {
        await this.terminal(uow, row, 'SKIPPED');
        return 'skipped';
      }

      // 3) 通道下发（at-least-once：发送成功后提交失败窗口内可能重发，状态守卫防重复回执）
      const adapter = this.registry.get(template.channel);
      try {
        await adapter.send({
          userId: Number(row.user_id),
          templateCode: row.template_code,
          content: renderTemplate(template.content, params),
          params,
        });
      } catch (e) {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        const newRetry = row.retry_count + 1;
        if (newRetry > this.config.dispatchMaxRetries) {
          await this.terminal(uow, row, 'FAILED', message, newRetry);
          return 'failed';
        }
        await uow.query(
          `UPDATE notify.notifications SET retry_count = $2, last_error = $3
            WHERE id = $1 AND status = 'QUEUED'`,
          [Number(row.id), newRetry, message],
        );
        return 'retried';
      }

      await this.terminal(uow, row, 'SENT');
      return 'sent';
    });
  }

  /** 终态迁移（守卫 + 条件更新 + 回执同事务）：QUEUED → SENT/SKIPPED/FAILED */
  private async terminal(
    uow: SqlExecutor,
    row: QueuedRow,
    to: Exclude<NotificationStatus, 'QUEUED'>,
    lastError?: string,
    retryCount?: number,
  ): Promise<void> {
    const notificationId = Number(row.id);
    await this.guard.assertTransition(NOTIFICATION_MACHINE, {
      entityId: notificationId,
      from: 'QUEUED',
      to,
      reason:
        to === 'SENT'
          ? 'dispatch_sent'
          : to === 'SKIPPED'
            ? 'dispatch_skipped_prefs'
            : 'dispatch_failed',
      uow,
    });
    const updated = await uow.query<{ id: string }>(
      `UPDATE notify.notifications
          SET status = $2::varchar,
              retry_count = COALESCE($3, retry_count),
              last_error = $4,
              sent_at = CASE WHEN $2::varchar = 'SENT' THEN now() ELSE sent_at END
        WHERE id = $1 AND status = 'QUEUED'
        RETURNING id`,
      [notificationId, to, retryCount ?? null, lastError ?? null],
    );
    if ((updated.rowCount ?? 0) === 0) {
      throw new AppError(ErrorCode.StateStaleEntity, `通知 ${notificationId} 已被并发迁移`);
    }
    // §6：NotificationDispatched 与回执更新同事务（业务回滚则事件不出）
    await this.outbox.recordOutbox(uow, {
      type: NOTIFY_DISPATCHED_TOPIC,
      payload: { id: notificationId, template_code: row.template_code, status: to },
    });
  }
}
