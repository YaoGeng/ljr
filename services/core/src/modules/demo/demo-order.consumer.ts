/**
 * demo 事件消费者（M0-4 验收脚手架）：消费 demo.order.completed，幂等键防重复消费。
 *
 * Review Focus #4 —— at-least-once ≠ 恰好一次：
 *   relay 崩溃窗口内同一事件可能重复投递（甚至跨进程/重启），进程内 Map（shared withIdempotency）
 *   不可靠，防重必须由 DB 唯一约束承担：demo.consumed_events.event_id PK，
 *   重复投递 INSERT ... ON CONFLICT 插 0 行 → 短路跳过，效果（completed_note）只发生一次。
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { SqlExecutor } from '../../infrastructure/sql';
import type { RelayEvent } from '../../infrastructure/outbox/outbox-relay.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';

export const DEMO_ORDER_COMPLETED_TOPIC = 'demo.order.completed';

export interface DemoOrderCompletedPayload {
  readonly orderId: number;
  readonly amount?: string;
  readonly title?: string;
}

/** 独立可测的消费者逻辑（demo-order-completed 的幂等消费） */
export async function demoOrderCompletedHandler(
  event: RelayEvent,
  uow: SqlExecutor,
): Promise<void> {
  // 幂等键：event_id（uuid，消费幂等的事实源）——插 0 行即已消费过，直接短路
  const claim = await uow.query(
    `INSERT INTO demo.consumed_events (event_id, topic)
     VALUES ($1::uuid, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.eventId, event.topic],
  );
  if ((claim.rowCount ?? 0) === 0) return; // 重复投递：效果不重复发生

  const payload = (event.payload ?? {}) as DemoOrderCompletedPayload;
  await uow.query(
    `UPDATE demo.orders
        SET completed_note = $2, updated_at = now()
      WHERE id = $1 AND completed_note IS NULL`,
    [payload.orderId, `consumed:${event.eventId}`],
  );
}

@Injectable()
export class DemoOrderConsumer implements OnModuleInit {
  constructor(private readonly relay: OutboxRelayService) {}

  onModuleInit(): void {
    this.relay.registerHandler(DEMO_ORDER_COMPLETED_TOPIC, demoOrderCompletedHandler);
  }
}
