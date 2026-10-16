/**
 * A3b 事件消费端（§6 消费）：LawyerAuditPassed（A3a 真事件——A3a 生产者已落位，非合成事件）。
 * 与 A1 授角色同 topic 双 handler：relay 扇出承接（outbox-relay M1-W3 T3 扩展；任一 handler
 * 失败整体回滚重投，重投全 handler 重跑——两侧消费均幂等：A1 PK 兜底，本侧 UNIQUE(firm_id,
 * channel) 短路）。
 *
 * 载荷口径（A1 consumer 先例 + Task 3 简报）：firm_id 显式 null=律所未定，记日志跳过不崩溃
 * （返回即 SENT，重投无意义——进件流程只能由带 firm 的事件启动）；firm_id 缺键/非正整数=
 * 抛错进重试轨道（载荷漂移显性化，不静默丢弃）。事务形态：startOnboarding 自持事务（handler
 * 不用 relay 认领事务的 uow）——崩溃窗口内已提交而 SENT 未标 → 重投由幂等短路（credit.consumer
 * 先例，at-least-once 语义内）。
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  ErrorCode,
  LAWYER_AUDIT_PASSED_TOPIC,
  type LawyerAuditPassedPayload,
} from '@ljr/shared';
import type { OutboxHandler, RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { FirmMerchantService } from './firm-merchant.service';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 独立可测的进件启动 handler */
export function createFirmOnboardingHandler(service: FirmMerchantService): OutboxHandler {
  const logger = new Logger('FirmOnboarding');
  return async (event: RelayEvent): Promise<void> => {
    if (event.topic !== LAWYER_AUDIT_PASSED_TOPIC) {
      // 注册表只按本 topic 注册，不应触达；防御性抛错进重试轨道（不静默）
      throw new AppError(ErrorCode.InvalidArgument, `进件消费者收到未注册 topic：${event.topic}`);
    }
    const payload = (event.payload ?? {}) as Partial<LawyerAuditPassedPayload>;
    if (!isPositiveInt(payload.lawyer_user_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `事件 ${event.topic} 载荷缺 lawyer_user_id（进重试轨道，不静默丢弃）`,
      );
    }
    if (payload.firm_id === null) {
      // A3a 裁决：律所未定的资质通过不启动进件（无 firm 可进）——记日志跳过不崩溃（A1 先例口径）
      logger.log(
        `律所进件事件跳过：firm_id=null（律所未定，lawyer_user_id=${payload.lawyer_user_id}，event_id=${event.eventId}）`,
      );
      return;
    }
    if (!isPositiveInt(payload.firm_id)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `事件 ${event.topic} 载荷缺 firm_id 或非法（进重试轨道，不静默丢弃）`,
      );
    }
    const out = await service.startOnboarding({ firm_id: payload.firm_id });
    if (!out.started) {
      logger.log(
        `律所进件已存在，幂等短路：firm_id=${payload.firm_id}（event_id=${event.eventId}）`,
      );
    }
  };
}

@Injectable()
export class FirmMerchantConsumer implements OnModuleInit {
  private readonly logger = new Logger(FirmMerchantConsumer.name);

  constructor(
    private readonly relay: OutboxRelayService,
    private readonly merchants: FirmMerchantService,
  ) {}

  onModuleInit(): void {
    // 同 topic 多 handler：A1 授角色（identity.consumer）与本进件启动并存，relay 扇出承接
    this.relay.registerHandler(
      LAWYER_AUDIT_PASSED_TOPIC,
      createFirmOnboardingHandler(this.merchants),
    );
  }
}
