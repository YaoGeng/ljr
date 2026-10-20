/**
 * D2 提醒服务（M2-W1 T4；docs/modules/D-履约/D2-提醒服务.md §1/§2/§4/§6/§7）——归属 notify
 * 模块（架构 §3.2：notify 职责=「提醒编排」，消费 schedule/fulfillment/trade 导出面）。
 *
 * ⚠W1-5 裁定：**不建 notification_jobs 表**——schedule_jobs 是唯一事实源（ADR-0003）；
 * sent 回执=notify.notifications 行 + ReminderDispatched 事件（D2 §3「与 I1 共表或分离由
 * 实现定」的实现裁量）。W1 判重口径=按 (user, kind, session) 查 notifications 既有行
 * （幂等键 remind/s{session}-u{user}/{kind}——registerForEvent 的 ON CONFLICT 回读承载）；
 * W2 评审可升级为显式回执表（头注声明，换装缝=本文件 dispatchSessionReminder 的判重段）。
 *
 * REMIND×4 编排（§4）：recheck=场次可提醒（trade sessionRemindable 导出面——终态/不存在/
 * 已截止未成团 → job CANCELLED 无操作，R-03 幽灵提醒禁令的 recheck 半边；修环 I-1 收紧
 * 的耦合声明见 reminder.executors 头注）→ execute=①取 PAID enrollment
 * 付款人清单（trade 导出窄面 listPaidEnrollmentUsers，纯加法）②逐人发 I1 通知（notify 既有
 * 分发面，D7 默认=站内信 INBOX）③进行中房间（fulfillment rooms OPEN/IN_SERVICE）经 D5
 * postInternalMessage 发 @Agent 名义房间消息（非法律意见声明，D2 §2/§11 口径）④逐人出箱
 * ReminderDispatched{ref_type:'enrollment', ref_id, user_id, kind}（A.1 契约逐字：用户锚=
 * 报名维度，场次信息在 kind+session 上下文，载荷不冗余）。
 *
 * 模板（⚠头注声明）：话术事实源=模板中心（I1 §9 禁硬编码），但 SESSION_REMIND 模板 W1 未
 * 随迁移 seed——执行时**自愈缺省**（缺失则落 DEFAULT_* 常量行，ON CONFLICT 幂等），
 * H7 模板化=W2+（届时话术治理迁 H7，本常量退役）。重放时模板已在册，自愈零动作。
 *
 * 房间消息幂等门控（W1 口径，头注声明）：房间消息仅在本轮**有新发通知**时投递——
 * 首访批次（dispatched>0）发，重放批次（全员判重命中，dispatched=0）不发；与 (user,kind,
 * session) 判重同锚。边界：零 PAID enrollment 的场次零房间消息（无提醒对象）；重放补晚到
 * 用户的房间消息可能重复（ops 重放/晚到支付边角，W2 评审随回执表一并收口）。
 *
 * 交接注记（W2）：
 *   - RescheduleConfirmed（改期重投）消费位预留（C5=W2 落位，D2 §6 消费面）；
 *   - SessionCancelled 作废路径=D4/W2（W1 取消面只有流标 failOnDeadline——已补同事务作废钩）；
 *   - confirm-arrival API 显式推迟（W1 无 attendances 表=D3/W2、enrollments 列冻结——无持久化
 *     锚，禁建假 API；与 D3 attendance 同批落位）。
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  REMINDER_DISPATCHED_TOPIC,
  type ReminderDispatchedPayload,
} from '@ljr/shared';
import type { SqlExecutor } from '../../infrastructure/sql';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ConversationService } from '../fulfillment/conversation.service';
import { RoomService } from '../fulfillment/room.service';
import { EnrollmentService } from '../trade/enrollment.service';
import { SessionService } from '../trade/session.service';
import { NotifyDispatcherService } from './notify-dispatcher.service';
import { NotifyTemplateService } from './notify-template.service';

/** REMIND 四档词汇（I2 jobType 子集；D2 §3 kind 枚举同字面） */
export const REMINDER_KINDS = ['REMIND_24H', 'REMIND_1H', 'REMIND_10MIN', 'REMIND_1MIN'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** I1 模板中心 code（自愈缺省见类注「模板」段；H7 模板化=W2+） */
export const SESSION_REMIND_TEMPLATE_CODE = 'SESSION_REMIND';

/** 缺省话术（模板中心无行时的自愈 seed 文案；{key} 占位符经 renderTemplate 渲染） */
export const DEFAULT_SESSION_REMIND_TEMPLATE_CONTENT =
  '场次提醒：您报名的场次将于 {slot_start} 开始（{kind_label}）。请提前进入房间；确认到场与申请改期请前往「我的报名」操作。';

/** @Agent 名义房间消息的非法律意见声明（D2 §2「@Agent 名义非法律意见」逐字承载） */
const AGENT_DISCLAIMER = '本提醒由 Agent 助手发送，不构成法律意见。';

/** 四档中文档位标签（通知 params/房间消息共用） */
const KIND_LABELS: Readonly<Record<ReminderKind, string>> = {
  REMIND_24H: '24 小时前',
  REMIND_1H: '1 小时前',
  REMIND_10MIN: '10 分钟前',
  REMIND_1MIN: '即将开始',
};

/** REMIND_x 执行器返回值（序列化进 schedule_job_log.detail，I2 §4） */
export interface ReminderDispatchResult {
  readonly session_id: number;
  readonly kind: ReminderKind;
  /** 该场次 PAID 报名人数（分发对象清单规模） */
  readonly recipients: number;
  /** 本轮新发通知数（判重命中不计——幂等重放口径的观测量） */
  readonly dispatched: number;
  /** true=进行中房间存在且本轮有新发（房间消息已投） */
  readonly room_message: boolean;
}

/** REMIND_GRACE_END 执行器返回值 */
export interface RoomReminderResult {
  readonly room_id: number;
  readonly posted: boolean;
}

/** 幂等键（shared 三段规范 domain/entity/event）：entity 段承载 (user,kind,session) 判重三元组 */
function remindNotificationKey(sessionId: number, userId: number, kind: ReminderKind): string {
  return `remind/s${sessionId}-u${userId}/${kind.toLowerCase()}`;
}

@Injectable()
export class ReminderDispatchService {
  private readonly logger = new Logger(ReminderDispatchService.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly templates: NotifyTemplateService,
    private readonly dispatcher: NotifyDispatcherService,
    // 跨模块消费全部走导出服务（禁跨 schema join，架构 §3.2 红线）
    private readonly sessions: SessionService,
    private readonly enrollments: EnrollmentService,
    private readonly rooms: RoomService,
    private readonly conversations: ConversationService,
  ) {}

  // ===========================================================================
  // REMIND×4 编排（§4：job 事实源驱动；效果与 job DONE 同事务——ctx.uow 承载）
  // ===========================================================================

  /**
   * 四档提醒分发：PAID 清单逐人 I1 通知（判重=notifications 幂等键回读）+ 逐人出箱
   * ReminderDispatched + 进行中房间 @Agent 消息（有新发门控，见类注）。无 PAID 报名=
   * 零通知零事件正常返回（job DONE 非错误）。
   */
  async dispatchSessionReminder(
    uow: SqlExecutor,
    sessionId: number,
    kind: ReminderKind,
  ): Promise<ReminderDispatchResult> {
    // 场次信息（slot_start 快照；稳定列池连接直读，recheck 已确认非终态）
    const detail = await this.sessions.getDetail(sessionId);
    await this.ensureSessionRemindTemplate(uow);

    const paid = await this.enrollments.listPaidEnrollmentUsers(uow, sessionId);
    const params = {
      session_id: sessionId,
      kind,
      slot_start: detail.slot_start,
      kind_label: KIND_LABELS[kind],
    };

    let dispatched = 0;
    for (const item of paid) {
      const accepted = await this.dispatcher.registerForEvent(uow, {
        userId: item.user_id,
        templateCode: SESSION_REMIND_TEMPLATE_CODE,
        params,
        idempotencyKey: remindNotificationKey(sessionId, item.user_id, kind),
      });
      if (accepted.deduplicated) continue; // (user,kind,session) 已发：不重发不出事件（判重生效）
      dispatched += 1;
      await this.outbox.recordOutbox(uow, {
        type: REMINDER_DISPATCHED_TOPIC,
        payload: {
          ref_type: 'enrollment',
          ref_id: item.enrollment_id,
          user_id: item.user_id,
          kind,
        } satisfies ReminderDispatchedPayload,
      });
    }

    // 房间消息（§4「D5 房间消息（进行中房间）」）：仅本轮有新发时投递（幂等门控，类注）
    let roomMessage = false;
    if (dispatched > 0) {
      const roomId = await this.rooms.activeRoomIdOfSession(uow, sessionId);
      if (roomId !== null) {
        await this.postAgentRoomMessage(
          uow,
          roomId,
          `【@Agent】场次提醒：本场次将于 ${detail.slot_start} 开始（${KIND_LABELS[kind]}），请进入房间等候并确认到场。${AGENT_DISCLAIMER}`,
        );
        roomMessage = true;
      }
    }
    if (dispatched > 0) {
      this.logger.log(
        `REMIND 分发：session=${sessionId} kind=${kind} recipients=${paid.length} dispatched=${dispatched} room_message=${roomMessage}`,
      );
    }
    return {
      session_id: sessionId,
      kind,
      recipients: paid.length,
      dispatched,
      room_message: roomMessage,
    };
  }

  // ===========================================================================
  // 房间内同步提醒（§2：宽限开始/结束前 1min——@Agent 名义非法律意见）
  // ===========================================================================

  /**
   * 宽限开始消息（RoomOpened 事件消费承载；graceEndIso=事件载荷 grace_end 透传）。
   * dedupKey（M2-W3 T5 可选）=消费方事件锚形态键（room-opened:{event_id}）——relay
   * at-least-once 重投窗的系统消息判重收口（V50 message_receipts 回执面）。
   */
  async postGraceStartedReminder(
    uow: SqlExecutor,
    roomId: number,
    graceEndIso: string,
    dedupKey?: string,
  ): Promise<RoomReminderResult> {
    await this.postAgentRoomMessage(
      uow,
      roomId,
      `【@Agent】房间已开放，宽限期已开始（至 ${graceEndIso}），请尽快进入房间。${AGENT_DISCLAIMER}`,
      dedupKey,
    );
    return { room_id: roomId, posted: true };
  }

  /** 宽限结束前 1min 消息（REMIND_GRACE_END 执行器承载；due=grace_end−1min 由 D1 预写锚定） */
  async postGraceEndReminder(uow: SqlExecutor, roomId: number): Promise<RoomReminderResult> {
    await this.postAgentRoomMessage(
      uow,
      roomId,
      `【@Agent】宽限期将于 1 分钟后结束，尚未到场的成员请尽快进入房间。${AGENT_DISCLAIMER}`,
    );
    return { room_id: roomId, posted: true };
  }

  // ===========================================================================
  // 内部件
  // ===========================================================================

  /**
   * 会话确保+@Agent 名义内部消息（postInternalMessage 头注声明的许可面之一：D2 房间内提醒；
   * uow 形态=效果与 job DONE/relay SENT 同事务）。开房同事务已建 room 会话——ensure 幂等回读。
   * dedupKey（M2-W3 T5 可选）透传 postInternalMessage 判重（消费路径事件锚形态键）。
   */
  private async postAgentRoomMessage(
    uow: SqlExecutor,
    roomId: number,
    content: string,
    dedupKey?: string,
  ): Promise<void> {
    const conv = await this.conversations.ensureConversation('room', roomId, { uow });
    await this.conversations.postInternalMessage({
      conversationId: conv.conversation_id,
      senderRole: 'agent',
      content,
      mention: 'agent',
      uow,
      dedupKey,
    });
  }

  /** 模板自愈（类注「模板」段）：在册即返；缺失落缺省常量行（ON CONFLICT 幂等，重放零动作） */
  private async ensureSessionRemindTemplate(uow: SqlExecutor): Promise<void> {
    try {
      await this.templates.findByCode(uow, SESSION_REMIND_TEMPLATE_CODE);
      return;
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== ErrorCode.NotFound) throw e;
    }
    await uow.query(
      `INSERT INTO notify.notification_templates (code, channel, content, version, critical)
       VALUES ($1, 'INBOX', $2, 1, false)
       ON CONFLICT (code) DO NOTHING`,
      [SESSION_REMIND_TEMPLATE_CODE, DEFAULT_SESSION_REMIND_TEMPLATE_CONTENT],
    );
  }
}
