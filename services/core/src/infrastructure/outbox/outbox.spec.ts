import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { OutboxService } from './outbox.service';
import { ensureTestDatabase, truncateAll } from '../testing/db';

describe('OutboxService.recordOutbox（写入端，需 PG）', () => {
  let pool: Pool;
  let outbox: OutboxService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    outbox = new OutboxService();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('与业务写同事务提交：事件落库为 PENDING（架构 §5.1 outbox 契约列）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO demo.orders (title, amount, status) VALUES ('t', '10.00', 'DRAFT')`,
      );
      const rec = await outbox.recordOutbox(client, {
        type: 'demo.order.completed',
        payload: { orderId: 1, amount: '10.00' },
      });
      expect(rec.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(rec.topic).toBe('demo.order.completed');
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const rows = await pool.query<{
      topic: string;
      status: string;
      payload: { orderId: number };
      event_id: string;
    }>(`SELECT topic, status, payload, event_id::text AS event_id FROM platform.outbox`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.topic).toBe('demo.order.completed');
    expect(rows.rows[0]?.status).toBe('PENDING');
    expect(rows.rows[0]?.payload).toEqual({ orderId: 1, amount: '10.00' });
  });

  it('事务回滚则事件不出（同事务原子性 —— 业务失败不残留幽灵事件）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO demo.orders (title, amount, status) VALUES ('t2', '20.00', 'DRAFT')`,
      );
      await outbox.recordOutbox(client, { type: 'demo.order.completed', payload: { orderId: 2 } });
      await client.query('ROLLBACK'); // 模拟业务失败
    } finally {
      client.release();
    }

    const events = await pool.query(`SELECT count(*)::int AS n FROM platform.outbox`);
    expect(events.rows[0]?.n).toBe(0);
    const orders = await pool.query(`SELECT count(*)::int AS n FROM demo.orders`);
    expect(orders.rows[0]?.n).toBe(0);
  });

  it('显式 eventId 尊重调用方（消费侧幂等键的事实源）；payload 走 jsonb 原文', async () => {
    const eventId = randomUUID();
    await outbox.recordOutbox(pool, {
      type: 'demo.order.completed',
      payload: { note: '直接池写入' },
      eventId,
    });
    const rows = await pool.query<{ event_id: string; payload: { note: string } }>(
      `SELECT event_id::text AS event_id, payload FROM platform.outbox`,
    );
    expect(rows.rows[0]?.event_id).toBe(eventId);
    expect(rows.rows[0]?.payload.note).toBe('直接池写入');
  });

  it('金额字段以字符串往返（NUMERIC 禁 float 口径的写入口径）', async () => {
    await outbox.recordOutbox(pool, {
      type: 'demo.order.completed',
      payload: { amount: '199.00' },
    });
    const rows = await pool.query<{ payload: { amount: unknown } }>(
      `SELECT payload FROM platform.outbox`,
    );
    expect(rows.rows[0]?.payload.amount).toBe('199.00'); // 字符串进字符串出，未被 JSON 数字化
  });
});
