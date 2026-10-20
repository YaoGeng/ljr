/**
 * E1 管线事件消费端（M2-W3 T4；§6 消费面：MessageSent（D5））：
 *   过滤（room 型 + sender_role=user 才跑——risk_flag 任意，BLOCKED 本就不出箱；W3-5 口径
 *   =room 型全部用户消息，不区分 mention）→ fulfillment 导出面回查消息内容
 *   （ConversationService.readMessageForAgent——A.4 清单，跨域=接口）→ DraftService.runPipeline。
 *
 * 降级纪律（W3-7）：
 *   - 载荷漂移（会话/消息不可读——消息已冷存/会话缺失等）=warn 跳过**不抛**（不烧 relay
 *     重试轨道；历史消息本就无需草稿）；
 *   - 管线段失败=runPipeline 内部降级（agent_degraded 帧+降级态，不抛错）——本消费端零
 *     上抛面，用户下一条消息自然重跑；
 *   - 载荷形状非法（缺 conversation_id/seq）=抛 AppError 进重试轨道（契约破坏显性化，
 *     不静默丢弃——D5 消费先例同款）。
 *
 * 事务形态：本消费端不占用 relay 认领事务（uow 仅签名占位）——管线落库走 DraftService
 * 自持事务（气泡帧在事务提交后推，先持久后推送顺序；见 draft.service 头注）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AppError, ErrorCode, MESSAGE_SENT_TOPIC } from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { ConversationService } from '../fulfillment/conversation.service';
import { DraftService } from './draft.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** MessageSent handler：过滤+回查+管线（W3-5/W3-7 口径见类注） */
export function createDraftMessageSentHandler(
  drafts: DraftService,
  conversations: ConversationService,
): OutboxHandler {
  const logger = new Logger('E1DraftPipeline');
  return async (event: RelayEvent, _uow) => {
    if (event.topic !== MESSAGE_SENT_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `E1 草稿消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as { conversation_id?: unknown; seq?: unknown };
    if (!isPositiveInt(payload.conversation_id) || !isPositiveInt(payload.seq)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `MessageSent 载荷缺 conversation_id/seq 最小集（进重试轨道，不静默丢弃）`,
      );
    }
    // 回查（A.4 导出面——E1 消费回查唯一入口；content=原文只在进程内传递，禁入载荷/日志）
    const message = await conversations.readMessageForAgent(payload.conversation_id, payload.seq);
    if (!message) {
      logger.warn(
        `载荷漂移：消息不可读（conversation=${payload.conversation_id} seq=${payload.seq}）——跳过不抛`,
      );
      return;
    }
    // 过滤（W3-5）：room 型用户消息才跑草稿管线；system/agent/律师消息零管线
    if (message.type !== 'room' || message.sender_role !== 'user') return;
    const outcome = await drafts.runPipeline({
      conversationId: payload.conversation_id,
      roomId: message.ref_id,
      seq: payload.seq,
      targetUserId: message.sender_id,
      content: message.content,
    });
    if (outcome === 'degraded') {
      logger.warn(
        `管线降级（不阻塞手打；下一条用户消息自然重跑）：conversation=${payload.conversation_id} seq=${payload.seq}`,
      );
    }
  };
}

@Injectable()
export class DraftConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly drafts: DraftService,
    private readonly conversations: ConversationService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(
      MESSAGE_SENT_TOPIC,
      createDraftMessageSentHandler(this.drafts, this.conversations),
    );
  }
}
