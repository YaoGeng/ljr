import 'reflect-metadata';
import { AppError, ErrorCode } from '@ljr/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { ensureTestDatabase, truncateAll } from '../../infrastructure/testing/db';
import { DemoModule } from './demo.module';
import { DemoOrderService } from './demo-order.service';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { DEMO_ORDER_COMPLETED_TOPIC } from './demo-order.consumer';

/**
 * demo 模块 e2e（M0-4 验收）：一张表 + 两态状态机 + 一个事件，
 * 走通 写 → 守卫 → outbox → relay → 幂等消费。
 *
 * DI 说明：不 override 连接——PgPoolService 按 env（与 scripts/db/lib.mjs 同口径）连同一个
 * portable PG，测试池负责清场；App 自建池由 app.close() 生命周期自行回收。
 */
describe('demo 模块 e2e（写→守卫→outbox→relay→幂等消费，需 PG）', () => {
  let pool: Pool;
  let app: INestApplication;
  let demoService: DemoOrderService;
  let relay: OutboxRelayService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [DemoModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // 触发 onModuleInit：demo 消费者注册到 relay
    demoService = app.get(DemoOrderService);
    relay = app.get(OutboxRelayService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });
  afterEach(async () => {
    await truncateAll(pool);
  });

  it('全链路：createOrder → completeOrder（守卫+幂等台账+outbox 同事务）→ relay 消费（幂等回写）', async () => {
    // 写
    const order = await demoService.createOrder({ title: '劳动仲裁咨询', amount: '199.00' });
    expect(order.status).toBe('DRAFT');

    // 守卫 + outbox 同事务
    const done = await demoService.completeOrder(order.id, `demo/order-${order.id}/completed`);
    expect(done.status).toBe('DONE');
    expect(done.eventId).toMatch(/^[0-9a-f-]{36}$/);

    // 落库断言：订单终态、放行留痕一行、金额字符串往返
    const ord = await pool.query<{ status: string; amount: string }>(
      `SELECT status, amount::text AS amount FROM demo.orders WHERE id = $1`,
      [order.id],
    );
    expect(ord.rows[0]?.status).toBe('DONE');
    expect(ord.rows[0]?.amount).toBe('199.00');
    const log = await pool.query<{ allowed: boolean; from_status: string; to_status: string }>(
      `SELECT allowed, from_status, to_status FROM platform.state_transition_log WHERE entity_id = $1 AND entity_type = 'demo_order'`,
      [order.id],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ allowed: true, from_status: 'DRAFT', to_status: 'DONE' });

    // outbox 待投递
    const evt = await pool.query<{ event_id: string; status: string }>(
      `SELECT event_id::text AS event_id, status FROM platform.outbox WHERE topic = $1`,
      [DEMO_ORDER_COMPLETED_TOPIC],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0]?.status).toBe('PENDING');
    expect(evt.rows[0]?.event_id).toBe(done.eventId);

    // relay 投递 + demo 消费者幂等回写
    const tick = await relay.tick();
    expect(tick.dispatched).toBe(1);
    const consumed = await pool.query<{ event_id: string; completed_note: string | null }>(
      `SELECT c.event_id::text AS event_id, o.completed_note
         FROM demo.consumed_events c JOIN demo.orders o ON o.id = $1`,
      [order.id],
    );
    expect(consumed.rows).toHaveLength(1);
    expect(consumed.rows[0]?.event_id).toBe(done.eventId);
    expect(consumed.rows[0]?.completed_note).toBe(`consumed:${done.eventId}`);
    const sent = await pool.query<{ status: string }>(
      `SELECT status FROM platform.outbox WHERE topic = $1`,
      [DEMO_ORDER_COMPLETED_TOPIC],
    );
    expect(sent.rows[0]?.status).toBe('SENT');
  });

  it('非法迁移被守卫拒绝：DONE 后再 DONE→DONE 抛 AppError 且落拒绝留痕、不产生新事件', async () => {
    const order = await demoService.createOrder({ title: '重复完成', amount: '10.00' });
    await demoService.completeOrder(order.id, `demo/order-${order.id}/completed-a`);

    let err: unknown;
    try {
      await demoService.completeOrder(order.id, `demo/order-${order.id}/completed-b`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ErrorCode.StateIllegalTransition);
    expect((err as AppError).httpStatus).toBe(409);

    const logs = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log WHERE entity_id = $1 ORDER BY id`,
      [order.id],
    );
    expect(logs.rows.map((r) => r.allowed)).toEqual([true, false]); // 1 放行 + 1 拒绝

    const events = await pool.query(`SELECT count(*)::int AS n FROM platform.outbox`);
    expect(events.rows[0]?.n).toBe(1); // 只剩首笔完成事件，非法尝试未发新事件

    // 第二个幂等键的台账随事务回滚（失败尝试不烧键）
    const ledger = await pool.query(`SELECT count(*)::int AS n FROM demo.order_actions`);
    expect(ledger.rows[0]?.n).toBe(1);
  });

  it('同键并发幂等：两笔并发 completeOrder 同键，fn 语义上只执行一次——一笔放行留痕、一个事件、双方拿到同一结果', async () => {
    const order = await demoService.createOrder({ title: '并发幂等', amount: '20.00' });
    const key = `demo/order-${order.id}/completed`;

    const [a, b] = await Promise.all([
      demoService.completeOrder(order.id, key),
      demoService.completeOrder(order.id, key),
    ]);
    expect(a).toEqual(b);

    const allowedLogs = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.state_transition_log WHERE entity_id = $1 AND allowed = true`,
      [order.id],
    );
    expect(allowedLogs.rows[0]?.n).toBe(1);

    const events = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [DEMO_ORDER_COMPLETED_TOPIC],
    );
    expect(events.rows[0]?.n).toBe(1);

    const ledger = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM demo.order_actions`,
    );
    expect(ledger.rows[0]?.n).toBe(1);
  });

  it('同键顺序重放：第二次调用直接返回首访结果，不再发事件/留痕', async () => {
    const order = await demoService.createOrder({ title: '顺序重放', amount: '30.00' });
    const key = `demo/order-${order.id}/completed`;
    const first = await demoService.completeOrder(order.id, key);
    const second = await demoService.completeOrder(order.id, key);
    expect(second).toEqual(first);

    const events = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE topic = $1`,
      [DEMO_ORDER_COMPLETED_TOPIC],
    );
    expect(events.rows[0]?.n).toBe(1);
  });

  it('非法幂等键：AppError(IdempotencyKeyInvalid, 400)，不触库不留痕', async () => {
    const order = await demoService.createOrder({ title: '坏键', amount: '40.00' });
    await expect(demoService.completeOrder(order.id, 'not-a-key')).rejects.toMatchObject({
      code: ErrorCode.IdempotencyKeyInvalid,
      httpStatus: 400,
    });
    const ledger = await pool.query(`SELECT count(*)::int AS n FROM demo.order_actions`);
    expect(ledger.rows[0]?.n).toBe(0);
  });

  it('非法金额：AppError(MoneyInvalidFormat, 422)（NUMERIC(12,2) 两位小数）', async () => {
    await expect(
      demoService.createOrder({ title: '坏金额', amount: '19.9' }),
    ).rejects.toMatchObject({
      code: ErrorCode.MoneyInvalidFormat,
    });
    const orders = await pool.query(`SELECT count(*)::int AS n FROM demo.orders`);
    expect(orders.rows[0]?.n).toBe(0);
  });

  it('订单不存在：AppError(NotFound, 404)，事务回滚不烧幂等键', async () => {
    await expect(
      demoService.completeOrder(999_999, 'demo/order-999999/completed'),
    ).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    const ledger = await pool.query(`SELECT count(*)::int AS n FROM demo.order_actions`);
    expect(ledger.rows[0]?.n).toBe(0);
  });

  it('relay 重复投递同一完成事件：消费侧幂等（completed_note 不被二次覆盖）', async () => {
    const order = await demoService.createOrder({ title: '重投递', amount: '50.00' });
    const done = await demoService.completeOrder(order.id, `demo/order-${order.id}/completed`);
    await relay.tick(); // 首次消费

    // 模拟 at-least-once 重投递（效果已落库、标记丢失的崩溃窗口）
    await pool.query(
      `UPDATE platform.outbox SET status = 'PENDING', sent_at = NULL WHERE event_id = $1::uuid`,
      [done.eventId],
    );
    await relay.tick(); // 二次投递

    const consumed = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM demo.consumed_events`,
    );
    expect(consumed.rows[0]?.n).toBe(1);
    const ord = await pool.query<{ completed_note: string }>(
      `SELECT completed_note FROM demo.orders WHERE id = $1`,
      [order.id],
    );
    expect(ord.rows[0]?.completed_note).toBe(`consumed:${done.eventId}`);
  });
});
