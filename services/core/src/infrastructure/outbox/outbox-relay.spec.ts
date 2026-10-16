import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { OutboxService } from './outbox.service';
import { OutboxRelayService, type RelayEvent } from './outbox-relay.service';
import { demoOrderCompletedHandler } from '../../modules/demo/demo-order.consumer';
import { ensureTestDatabase, truncateAll } from '../testing/db';

describe('OutboxRelayService（at-least-once 投递，需 PG）', () => {
  let pool: Pool;
  let record: OutboxService;
  let relay: OutboxRelayService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    record = new OutboxService();
    relay = new OutboxRelayService(pool, { maxRetry: 2, backoffMs: () => 0 });
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

  async function seedEvent(topic: string, payload: unknown): Promise<number> {
    const rec = await record.recordOutbox(pool, { type: topic, payload });
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM platform.outbox WHERE event_id = $1::uuid`,
      [rec.eventId],
    );
    return Number(row.rows[0]?.id);
  }

  it('成功才标记 SENT：handler 成功后 status=SENT、sent_at 非空', async () => {
    const id = await seedEvent('test.topic.ok', { n: 1 });
    let calls = 0;
    relay.registerHandler('test.topic.ok', async () => {
      calls += 1;
    });

    const tick = await relay.tick();
    expect(tick.dispatched).toBe(1);
    expect(calls).toBe(1);

    const row = await pool.query<{ status: string; sent_at: string | null }>(
      `SELECT status, sent_at FROM platform.outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('SENT');
    expect(row.rows[0]?.sent_at).not.toBeNull();
  });

  it('失败重试：retry_count 递增、last_error 记录、保持 PENDING；下次成功才 SENT', async () => {
    const id = await seedEvent('test.topic.flaky', { n: 2 });
    let attempts = 0;
    relay.registerHandler('test.topic.flaky', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('第一次炸了');
    });

    const t1 = await relay.tick();
    expect(t1.dispatched).toBe(0);
    expect(t1.retried).toBe(1);
    const row = await pool.query<{
      status: string;
      retry_count: number;
      last_error: string | null;
    }>(`SELECT status, retry_count, last_error FROM platform.outbox WHERE id = $1`, [id]);
    expect(row.rows[0]?.status).toBe('PENDING');
    expect(row.rows[0]?.retry_count).toBe(1);
    expect(row.rows[0]?.last_error).toContain('第一次炸了');

    const t2 = await relay.tick(); // 第二次投递成功
    expect(t2.dispatched).toBe(1);
    const rowSent = await pool.query<{ status: string; retry_count: number }>(
      `SELECT status, retry_count FROM platform.outbox WHERE id = $1`,
      [id],
    );
    expect(rowSent.rows[0]?.status).toBe('SENT');
    expect(rowSent.rows[0]?.retry_count).toBe(1); // 成功不再累计
  });

  it('重试超上限入死信：status=DEAD + outbox_dead_letter 落一行（retry_count=1+maxRetry 次尝试后）', async () => {
    const id = await seedEvent('test.topic.poison', { n: 3 });
    relay.registerHandler('test.topic.poison', async () => {
      throw new Error('永久性失败');
    });

    await relay.tick(); // 尝试 1 → retry_count=1
    await relay.tick(); // 尝试 2 → retry_count=2（=maxRetry，仍重试）
    const t3 = await relay.tick(); // 尝试 3 → 超限，死信
    expect(t3.dead).toBe(1);

    const row = await pool.query<{ status: string; retry_count: number }>(
      `SELECT status, retry_count FROM platform.outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('DEAD');
    expect(row.rows[0]?.retry_count).toBe(3);

    const dl = await pool.query<{
      outbox_id: number;
      topic: string;
      last_error: string | null;
      retry_count: number;
    }>(
      `SELECT outbox_id, topic, last_error, retry_count FROM platform.outbox_dead_letter WHERE outbox_id = $1`,
      [id],
    );
    expect(dl.rows).toHaveLength(1);
    expect(dl.rows[0]?.topic).toBe('test.topic.poison');
    expect(dl.rows[0]?.last_error).toContain('永久性失败');
    expect(dl.rows[0]?.retry_count).toBe(3);

    // 死信后不再拾取
    const t4 = await relay.tick();
    expect(t4.dispatched + t4.retried + t4.dead).toBe(0);
  });

  it('未注册 handler 的 topic 视为失败（进入重试轨道，不静默丢事件）', async () => {
    await seedEvent('test.topic.no-handler', { n: 4 });
    const t1 = await relay.tick();
    expect(t1.retried).toBe(1);
    const row = await pool.query<{ last_error: string }>(
      `SELECT last_error FROM platform.outbox WHERE topic = 'test.topic.no-handler'`,
    );
    expect(row.rows[0]?.last_error).toContain('no handler');
  });

  it('同 topic 多 handler 扇出（A3b 消费 LawyerAuditPassed 与 A1 授角色并存的前提）：两个 handler 依次执行；后者失败整体回滚重投，重投时两者都重跑（at-least-once）', async () => {
    const id = await seedEvent('test.topic.fanout', { n: 6 });
    const calls: string[] = [];
    let a3bFailedOnce = false;
    relay.registerHandler('test.topic.fanout', async () => {
      calls.push('a1');
    });
    relay.registerHandler('test.topic.fanout', async () => {
      calls.push('a3b');
      if (!a3bFailedOnce) {
        a3bFailedOnce = true;
        throw new Error('第二 handler 首跑失败');
      }
    });

    const t1 = await relay.tick();
    expect(t1.retried).toBe(1); // 第二 handler 失败 → 整体回滚进重试轨道
    expect(calls).toEqual(['a1', 'a3b']); // 两者都已执行（但随事务回滚）

    const t2 = await relay.tick();
    expect(t2.dispatched).toBe(1); // 重投成功
    expect(calls).toEqual(['a1', 'a3b', 'a1', 'a3b']); // 重投两 handler 都重跑（消费方须自带幂等）
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM platform.outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('SENT');
  });

  it('退避生效：next_retry_at 被推后，未到期不拾取', async () => {
    const slowRelay = new OutboxRelayService(pool, {
      maxRetry: 5,
      backoffMs: (_retryCount) => 60_000,
    });
    const id = await seedEvent('test.topic.backoff', { n: 5 });
    slowRelay.registerHandler('test.topic.backoff', async () => {
      throw new Error('等退避');
    });

    await slowRelay.tick();
    const after = await pool.query<{ next_retry_at: string }>(
      `SELECT next_retry_at FROM platform.outbox WHERE id = $1`,
      [id],
    );
    expect(new Date(after.rows[0]?.next_retry_at ?? 0).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );

    const t2 = await slowRelay.tick(); // 60s 退避内 → 不拾取
    expect(t2.dispatched + t2.retried + t2.dead).toBe(0);
  });

  it('批次上限：一次 tick 至多处理 batch 条', async () => {
    const bounded = new OutboxRelayService(pool, { batch: 2, maxRetry: 1, backoffMs: () => 0 });
    bounded.registerHandler('test.topic.batch', async () => undefined);
    await seedEvent('test.topic.batch', { n: 1 });
    await seedEvent('test.topic.batch', { n: 2 });
    await seedEvent('test.topic.batch', { n: 3 });

    const t1 = await bounded.tick();
    expect(t1.dispatched).toBe(2);
    const t2 = await bounded.tick();
    expect(t2.dispatched).toBe(1);
  });

  describe('重复投递不被当恰好一次（Review Focus #4：demo 消费者幂等键防重）', () => {
    it('同一事件投递两次：handler 进程被调两次，但 DB 防重使效果只发生一次', async () => {
      // 业务事实：一张 DRAFT 订单
      const order = await pool.query<{ id: string }>(
        `INSERT INTO demo.orders (title, amount, status) VALUES ('幂等消费验证', '30.00', 'DONE') RETURNING id`,
      );
      const orderId = Number(order.rows[0]?.id);

      // 事件 + demo 消费者（consumed_events.event_id 唯一承担幂等键）
      const eventId = randomUUID();
      await record.recordOutbox(pool, {
        type: 'demo.order.completed',
        payload: { orderId, amount: '30.00' },
        eventId,
      });
      let handlerInvocations = 0;
      relay.registerHandler('demo.order.completed', async (event: RelayEvent, uow) => {
        handlerInvocations += 1;
        await demoOrderCompletedHandler(event, uow);
      });

      await relay.tick(); // 第一次投递：消费 + SENT
      expect(handlerInvocations).toBe(1);

      // 模拟 at-least-once 的重复投递：SENT 复位 PENDING（如 relay 在效果落库后、标记前崩溃）
      await pool.query(
        `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE event_id = $1::uuid`,
        [eventId],
      );
      await relay.tick(); // 第二次投递
      expect(handlerInvocations).toBe(2); // handler 确实被再次调用（at-least-once）

      // 但防重生效：consumed_events 仅一行，completed_note 未被二次覆盖
      const consumed = await pool.query<{ event_id: string }>(
        `SELECT event_id::text AS event_id FROM demo.consumed_events`,
      );
      expect(consumed.rows).toHaveLength(1);
      expect(consumed.rows[0]?.event_id).toBe(eventId);
      const ord = await pool.query<{ completed_note: string | null; status: string }>(
        `SELECT completed_note, status FROM demo.orders WHERE id = $1`,
        [orderId],
      );
      expect(ord.rows[0]?.completed_note).toBe(`consumed:${eventId}`);
      expect(ord.rows[0]?.status).toBe('DONE');
    });
  });
});
