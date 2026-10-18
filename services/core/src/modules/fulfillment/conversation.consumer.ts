/**
 * D5 事件消费端（M2-W1 T3；§6 消费面）：
 *   ① TrainingConsentRevoked（identity.consent.training.revoked，A2 生产——W2 契约定型）：
 *      source_msg_id 反查物理删除该用户语料热行（R-04）+ TrainingDataPurged 回执出箱（恒出箱
 *      ——重放零行 hot_count=0 仍回执，重投由 outbox at-least-once 收敛）。
 *   ② OneOnOnePaid（fulfillment.one_on_one.paid，D6 真生产=W3；W1 消费钉形+合成事件桩验证
 *      ——05 §6.1 W1 行「②补验」口径）：建 one_on_one 会话（UNIQUE(type,ref_id) 幂等）+
 *      OneOnOneConversationCreated 出箱（仅新建时——重放零新事件）。
 *
 * 事务形态：消费效果经 relay 认领事务的 uow（效果与 SENT 标记同事务——handler 成功即整体
 * 提交；崩溃窗口回滚后重投，幂等由 ensureConversation/物理删零行收敛）。enrollment.consumer
 * 的「守卫自持事务」变体在此取 relay-uow 形态（写面全在本域，无跨域服务调用）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ONE_ON_ONE_CONVERSATION_CREATED_TOPIC,
  ONE_ON_ONE_PAID_TOPIC,
  TRAINING_CONSENT_REVOKED_TOPIC,
  type OneOnOneConversationCreatedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { ConversationService } from './conversation.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** TrainingConsentRevoked handler：物理删热语料 + 回执（R-04；载荷缺 user_id 进重试轨道） */
export function createTrainingConsentRevokedHandler(
  conversations: ConversationService,
): OutboxHandler {
  const logger = new Logger('D5TrainingPurge');
  return async (event: RelayEvent, uow) => {
    if (event.topic !== TRAINING_CONSENT_REVOKED_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `训练撤回消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as { user_id?: unknown };
    if (!isPositiveInt(payload.user_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `TrainingConsentRevoked 载荷缺 user_id（进重试轨道，不静默丢弃）`,
      );
    }
    const userId = payload.user_id;
    const hot = await conversations.purgeTrainingCorpus(uow, userId);
    await conversations.recordTrainingPurged(uow, userId, hot); // 恒回执（重放零行 hot_count=0）
    logger.log(`训练语料撤回删除完成：user=${userId} hot=${hot} cold=0（I3 协作位=W2+）`);
  };
}

/** OneOnOnePaid handler：幂等建会话 + 新建时出箱 OneOnOneConversationCreated（W1 合成桩驱动） */
export function createOneOnOnePaidHandler(
  conversations: ConversationService,
  outbox: OutboxService,
): OutboxHandler {
  const logger = new Logger('D5OneOnOnePaid');
  return async (event: RelayEvent, uow) => {
    if (event.topic !== ONE_ON_ONE_PAID_TOPIC) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `1对1支付消费器收到未注册 topic：${event.topic}`,
      );
    }
    const payload = (event.payload ?? {}) as Partial<{
      order_id: number;
      user_id: number;
      lawyer_id: number;
    }>;
    if (
      !isPositiveInt(payload.order_id) ||
      !isPositiveInt(payload.user_id) ||
      !isPositiveInt(payload.lawyer_id)
    ) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `OneOnOnePaid 载荷缺 order_id/user_id/lawyer_id 最小集（进重试轨道，不静默丢弃）`,
      );
    }
    const conv = await conversations.ensureConversation('one_on_one', payload.order_id, { uow });
    if (conv.created) {
      await outbox.recordOutbox(uow, {
        type: ONE_ON_ONE_CONVERSATION_CREATED_TOPIC,
        payload: {
          conversation_id: conv.conversation_id,
          order_id: payload.order_id,
          user_id: payload.user_id,
          lawyer_id: payload.lawyer_id,
        } satisfies OneOnOneConversationCreatedPayload,
      });
      logger.log(
        `one_on_one 会话已建：conversation=${conv.conversation_id} order=${payload.order_id}`,
      );
    } else {
      logger.log(`one_on_one 会话在册（幂等重放）：order=${payload.order_id}`);
    }
  };
}

@Injectable()
export class ConversationConsumer implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelayService,
    private readonly conversations: ConversationService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.relay.registerHandler(
      TRAINING_CONSENT_REVOKED_TOPIC,
      createTrainingConsentRevokedHandler(this.conversations),
    );
    this.relay.registerHandler(
      ONE_ON_ONE_PAID_TOPIC,
      createOneOnOnePaidHandler(this.conversations, this.outbox),
    );
  }
}
