/**
 * Outbox 写入端（M0-4 锁定接口）：recordOutbox(uow, evt) —— 与业务写同事务。
 *
 * 事件类型即 topic（shared DomainEvent.type，如 demo.order.completed）；
 * eventId 默认 randomUUID()，可由调用方显式提供（消费侧幂等键的事实源）。
 * 表：platform.outbox（V2 迁移；relay 独立轮询 at-least-once 投递）。
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@ljr/shared';
import type { SqlExecutor } from '../sql';

/** 写入事件：DomainEvent + 可选 eventId（shared DomainEvent 的 M0-4 扩展位） */
export type OutboxEventInput = DomainEvent & { readonly eventId?: string };

export interface OutboxRecorded {
  readonly eventId: string;
  readonly topic: string;
}

@Injectable()
export class OutboxService {
  async recordOutbox(uow: SqlExecutor, evt: OutboxEventInput): Promise<OutboxRecorded> {
    const eventId = evt.eventId ?? randomUUID();
    await uow.query(
      `INSERT INTO platform.outbox (event_id, topic, payload, status)
       VALUES ($1::uuid, $2, $3::jsonb, 'PENDING')`,
      [eventId, evt.type, JSON.stringify(evt.payload ?? null)],
    );
    return { eventId, topic: evt.type };
  }
}
