import 'reflect-metadata';
import { AppError, ErrorCode } from '@ljr/shared';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createStateMachine } from './state-machine';
import type { DemoOrderStatus } from '../../modules/demo/demo-order.machine';
import { DEMO_ORDER_MACHINE } from '../../modules/demo/demo-order.machine';
import { StateTransitionGuardService } from './state-transition-guard.service';
import { StateTransitionLogService } from './state-transition-log.service';
import { PgPoolService } from '../sql';
import { ensureTestDatabase, truncateAll } from '../testing/db';
import type { Pool } from 'pg';

describe('createStateMachine（纯校验，锁定接口）', () => {
  type TrafficLight = 'RED' | 'GREEN';
  const machine = createStateMachine<TrafficLight>({
    entityType: 'traffic_light',
    states: ['RED', 'GREEN'],
    transitions: [
      { from: 'RED', to: 'GREEN' },
      { from: 'GREEN', to: 'RED' },
    ],
  });

  it('canTransition：仅声明的迁移为真', () => {
    expect(machine.canTransition('RED', 'GREEN')).toBe(true);
    expect(machine.canTransition('GREEN', 'RED')).toBe(true);
    expect(machine.canTransition('RED', 'RED')).toBe(false);
  });

  it('assertTransition：合法迁移放行（不抛）', () => {
    expect(() => machine.assertTransition('RED', 'GREEN')).not.toThrow();
  });

  it('assertTransition：非法迁移抛 AppError(StateIllegalTransition, 409)', () => {
    let err: unknown;
    try {
      machine.assertTransition('RED', 'RED');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.code).toBe(ErrorCode.StateIllegalTransition);
    expect(appErr.httpStatus).toBe(409);
    expect(appErr.message).toContain('traffic_light');
    expect(appErr.message).toContain('RED');
  });

  it('def 防呆：transition 引用未声明状态 → 构造即抛', () => {
    expect(() =>
      createStateMachine({
        entityType: 'bad',
        states: ['A'],
        transitions: [{ from: 'A', to: 'B' }],
      }),
    ).toThrow(AppError);
  });

  it('def 防呆：重复迁移声明 → 构造即抛', () => {
    expect(() =>
      createStateMachine({
        entityType: 'dup',
        states: ['A', 'B'],
        transitions: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'B' },
        ],
      }),
    ).toThrow(AppError);
  });
});

describe('StateTransitionGuardService（守卫 + state_transition_log 留痕，需 PG）', () => {
  let pool: Pool;
  let svc: StateTransitionGuardService;

  beforeAll(async () => {
    pool = await ensureTestDatabase();
    const poolSvc = new PgPoolService(pool);
    svc = new StateTransitionGuardService(new StateTransitionLogService(), poolSvc);
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

  it('合法迁移：同 uow 事务写 allowed=true 留痕一行', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await svc.assertTransition(DEMO_ORDER_MACHINE, {
        entityId: 1,
        from: 'DRAFT',
        to: 'DONE',
        uow: client,
      });
      const inTx = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.state_transition_log`,
      );
      expect(inTx.rows[0]?.count).toBe('1');
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const after = await pool.query<{
      allowed: boolean;
      from_status: string | null;
      to_status: string;
    }>(`SELECT allowed, from_status, to_status FROM platform.state_transition_log`);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.allowed).toBe(true);
    expect(after.rows[0]?.from_status).toBe('DRAFT');
    expect(after.rows[0]?.to_status).toBe('DONE');
  });

  it('合法迁移随业务事务回滚：留痕一并消失（同事务语义）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await svc.assertTransition(DEMO_ORDER_MACHINE, {
        entityId: 2,
        from: 'DRAFT',
        to: 'DONE',
        uow: client,
      });
      await client.query('ROLLBACK'); // 业务失败回滚
    } finally {
      client.release();
    }
    const rows = await pool.query(`SELECT count(*) FROM platform.state_transition_log`);
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it('非法迁移：抛 AppError 且 state_transition_log 落一行 allowed=false（独立事务，业务回滚不吞拒绝审计）', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 业务事务内请求非法迁移 DRAFT 已到 DONE 后再 DONE → DONE
      await svc.assertTransition(DEMO_ORDER_MACHINE, {
        entityId: 3,
        from: 'DRAFT',
        to: 'DONE',
        uow: client,
      });
      let err: unknown;
      try {
        await svc.assertTransition(DEMO_ORDER_MACHINE, {
          entityId: 3,
          from: 'DONE',
          to: 'DONE',
          uow: client,
          reason: '重复完成',
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(ErrorCode.StateIllegalTransition);
      await client.query('ROLLBACK'); // 业务侧回滚
    } finally {
      client.release();
    }

    // 回滚后：放行留痕消失，拒绝留痕仍在（独立连接写入）
    const rows = await pool.query<{ allowed: boolean; reason: string | null }>(
      `SELECT allowed, reason FROM platform.state_transition_log WHERE entity_id = 3`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.allowed).toBe(false);
    expect(rows.rows[0]?.reason).toBe('重复完成');
  });

  it('重复迁移（重放）：实体已到 DONE 后再 DONE→DONE 被拒，留痕 1 放行 + 1 拒绝（真正的同键并发幂等在 demo e2e 用唯一索引验证）', async () => {
    // 守卫级口径：第一笔 DRAFT→DONE 放行；重放的第二笔从 DONE 出发即非法 → 拒绝留痕。
    // （同键并发的持久幂等由 demo.order_actions 唯一索引承担，见 demo e2e spec。）
    const runFirst = svc.assertTransition(DEMO_ORDER_MACHINE, {
      entityId: 7,
      from: 'DRAFT',
      to: 'DONE',
    });
    const runSecond = (async () => {
      await runFirst;
      let err: unknown;
      try {
        await svc.assertTransition(DEMO_ORDER_MACHINE, { entityId: 7, from: 'DONE', to: 'DONE' });
      } catch (e) {
        err = e;
      }
      return err;
    })();
    await runFirst;
    const secondErr = await runSecond;
    expect(secondErr).toBeInstanceOf(AppError);

    const rows = await pool.query<{ allowed: boolean }>(
      `SELECT allowed FROM platform.state_transition_log WHERE entity_id = 7 ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.allowed).toBe(true);
    expect(rows.rows[1]?.allowed).toBe(false);
  });

  it('守卫接收 demo 状态机的具名状态（类型口径）', async () => {
    const status: DemoOrderStatus = 'DRAFT';
    await expect(
      svc.assertTransition(DEMO_ORDER_MACHINE, { entityId: 9, from: status, to: 'DONE' }),
    ).resolves.toBeUndefined();
  });
});
