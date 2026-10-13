/**
 * demo 订单服务（M0-4 验收脚手架）：横切基座的参考用法。
 *
 * completeOrder 演示完整守卫模式（架构 §4.1「所有状态迁移经守卫与 state_transition_log 落库」）：
 *   BEGIN
 *     幂等台账 INSERT ... ON CONFLICT DO NOTHING（同键并发/重试在唯一约束上败退为读首访结果）
 *     SELECT ... FOR UPDATE（行锁读当前状态）
 *     guard.assertTransition（合法→同事务放行留痕；非法→独立留痕+抛 AppError）
 *     UPDATE ... WHERE status = 'DRAFT'（条件更新兜底乐观并发，0 行=StateStaleEntity）
 *     recordOutbox（事件与业务同事务）
 *     台账回填首访结果
 *   COMMIT / 异常 ROLLBACK（台账随之回滚，失败尝试不烧幂等键）
 */
import { Injectable } from '@nestjs/common';
import { AppError, ErrorCode, assertMoney, isValidIdempotencyKey } from '@ljr/shared';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { PgPoolService } from '../../infrastructure/sql';
import { StateTransitionGuardService } from '../../infrastructure/state-machine/state-transition-guard.service';
import { DEMO_ORDER_MACHINE, type DemoOrderStatus } from './demo-order.machine';
import { DEMO_ORDER_COMPLETED_TOPIC } from './demo-order.consumer';

export interface DemoOrderCreated {
  readonly id: number;
  readonly status: DemoOrderStatus;
}

export interface DemoOrderActionResult {
  readonly orderId: number;
  readonly status: 'DONE';
  readonly eventId: string;
}

@Injectable()
export class DemoOrderService {
  constructor(
    private readonly pool: PgPoolService,
    private readonly outbox: OutboxService,
    private readonly guard: StateTransitionGuardService,
  ) {}

  async createOrder(input: { title: string; amount: string }): Promise<DemoOrderCreated> {
    assertMoney(input.amount); // NUMERIC(12,2) 两位小数字符串（架构 §1.3 禁 float）
    return this.pool.withTransaction(async (uow) => {
      const res = await uow.query<{ id: string; status: DemoOrderStatus }>(
        `INSERT INTO demo.orders (title, amount, status) VALUES ($1, $2::numeric, 'DRAFT') RETURNING id, status`,
        [input.title, input.amount],
      );
      const row = res.rows[0];
      if (!row) throw new AppError(ErrorCode.InternalError, 'demo 订单插入失败');
      return { id: Number(row.id), status: row.status };
    });
  }

  async completeOrder(orderId: number, idempotencyKey: string): Promise<DemoOrderActionResult> {
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new AppError(
        ErrorCode.IdempotencyKeyInvalid,
        `非法幂等键：${JSON.stringify(idempotencyKey)}（规范 domain/entity/event）`,
      );
    }

    return this.pool.withTransaction(async (uow) => {
      // 1) 持久幂等：唯一约束承担（同键并发第二笔在提交点败退，转为读取首访结果）
      const claim = await uow.query(
        `INSERT INTO demo.order_actions (idempotency_key, order_id, action, result)
         VALUES ($1, $2, 'COMPLETE', 'null'::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [idempotencyKey, orderId],
      );
      if ((claim.rowCount ?? 0) === 0) {
        const prev = await uow.query<{ result: DemoOrderActionResult }>(
          `SELECT result FROM demo.order_actions WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        const first = prev.rows[0]?.result;
        if (!first) throw new AppError(ErrorCode.InternalError, '幂等台账缺首访结果（不应触达）');
        return first; // 短路：返回首访结果
      }

      // 2) 行锁读当前状态
      const current = await uow.query<{ status: DemoOrderStatus; amount: string; title: string }>(
        `SELECT status, amount::text AS amount, title FROM demo.orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = current.rows[0];
      if (!order) {
        throw new AppError(ErrorCode.NotFound, `demo 订单 ${orderId} 不存在`);
      }

      // 3) 守卫：非法迁移在独立事务留拒绝痕后抛 AppError（本事务随后回滚）
      await this.guard.assertTransition(DEMO_ORDER_MACHINE, {
        entityId: orderId,
        from: order.status,
        to: 'DONE',
        reason: 'complete',
        uow,
      });

      // 4) 条件更新兜底乐观并发（行锁下 0 行即并发竞态，双保险）
      const updated = await uow.query<{ id: string }>(
        `UPDATE demo.orders SET status = 'DONE', updated_at = now()
          WHERE id = $1 AND status = 'DRAFT' RETURNING id`,
        [orderId],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new AppError(ErrorCode.StateStaleEntity, `demo 订单 ${orderId} 已被并发迁移`);
      }

      // 5) 领域事件同事务（业务回滚则事件不出）
      const evt = await this.outbox.recordOutbox(uow, {
        type: DEMO_ORDER_COMPLETED_TOPIC,
        payload: { orderId, title: order.title, amount: order.amount },
      });

      // 6) 回填首访结果（同事务）
      const result: DemoOrderActionResult = { orderId, status: 'DONE', eventId: evt.eventId };
      await uow.query(
        `UPDATE demo.order_actions SET result = $2::jsonb WHERE idempotency_key = $1`,
        [idempotencyKey, JSON.stringify(result)],
      );
      return result;
    });
  }
}
