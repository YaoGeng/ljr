/**
 * Outbox 写入端（M0-4 锁定接口）：recordOutbox(uow, evt) —— 与业务写同事务。
 *
 * 事件类型即 topic（shared DomainEvent.type，如 demo.order.completed）；
 * eventId 默认 randomUUID()，可由调用方显式提供（消费侧幂等键的事实源）。
 * 表：platform.outbox（V2 迁移；relay 独立轮询 at-least-once 投递）。
 *
 * 只读查询面（M2-W2 T2 修复环 Minor-5）：listEventsByPayload——「业务经基座服务访问」白名单
 * 注释纪律的执行面（业务模块禁直连 outbox 表）。消费方：D3 presence 序列重放（fulfillment
 * 域判定以 D5 的 PresenceJoined/Left 事件留痕为序列事实源——attendances 蓝图逐列无序列列）；
 * F4 缺席分成完成门重放（M2-W2 T6 修复环 I-3：AttendanceAdjudicated 留痕=判定事实源，
 * benefits 侧不跨域读 fulfillment attendances）。形态刻意最小（topic 集合+单载荷字段过滤），
 * 不承载业务词汇。
 * 换装注记：若 V2+ 引入 outbox 归档/清理，事件留痕不再全量在表——presence 序列需同步引入
 * 持久化换装（attendances 序列列或独立留痕），届时本面随消费方一并评估（W3+）。
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

/** 只读事件行（id 升序承载序列序；payload 原样——业务字段解释归调用方） */
export interface OutboxEventRow {
  readonly topic: string;
  readonly payload: Record<string, unknown> | null;
}

/** 只读事件分组行（M2-W2 T6 修复环 I-3：按 payload 锚分组的候选枚举面） */
export interface OutboxEventGroupRow {
  /** payload 锚字段值（文本——调用方自行数值化） */
  readonly value: string;
  /** 组内最后事件时刻（静默窗锚） */
  readonly lastAt: Date;
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

  /**
   * 按类型集合+单载荷字段等值过滤的只读事件查询（id 升序=事件写入序）；maxEventId=上界
   * （消费判定形态的快照语义：只看某判定事件之前已提交的序列），缺省无上界。
   * 经调用方事务的 exec 读（与业务判定同事务一致性）；不修改任何行。
   */
  async listEventsByPayload(
    exec: SqlExecutor,
    topics: readonly string[],
    payloadKey: string,
    payloadValue: string,
    maxEventId?: number,
  ): Promise<readonly OutboxEventRow[]> {
    if (topics.length === 0) return [];
    const bounded = Number.isInteger(maxEventId) && (maxEventId as number) > 0;
    const res = await exec.query<{
      topic: string;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT topic, payload FROM platform.outbox
        WHERE topic = ANY($1::varchar[])
          AND payload->>$2 = $3
          ${bounded ? 'AND id < $4' : ''}
        ORDER BY id`,
      bounded ? [topics, payloadKey, payloadValue, maxEventId] : [topics, payloadKey, payloadValue],
    );
    return res.rows;
  }

  /**
   * 按类型集合+单载荷锚字段的**分组枚举**（M2-W2 T6 修复环 I-3）：返回锚值+组内最后事件
   * 时刻，且只保留「组内最后事件早于 now()−quietMs」的组（调用方的静默窗语义——如 F4
   * 悬空分成检出=判定流静默 48h 的场次候选）。limit=组数上限（防大表扫面失控）。与
   * listEventsByPayload 同纪律：经调用方事务的 exec 只读，不承载业务词汇。
   */
  async listEventGroupsBefore(
    exec: SqlExecutor,
    topics: readonly string[],
    payloadKey: string,
    quietMs: number,
    limit = 200,
  ): Promise<readonly OutboxEventGroupRow[]> {
    if (topics.length === 0) return [];
    const res = await exec.query<{ value: string; last_at: Date }>(
      `SELECT payload->>$2 AS value, max(created_at) AS last_at
         FROM platform.outbox
        WHERE topic = ANY($1::varchar[]) AND payload ? $2
        GROUP BY payload->>$2
       HAVING max(created_at) < now() - ($3::bigint * interval '1 millisecond')
        ORDER BY min(id)
        LIMIT $4`,
      [topics, payloadKey, quietMs, limit],
    );
    return res.rows.map((r) => ({ value: r.value, lastAt: new Date(r.last_at) }));
  }
}
