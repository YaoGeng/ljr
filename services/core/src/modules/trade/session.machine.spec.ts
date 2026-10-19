import { describe, expect, it } from 'vitest';
import { SESSION_MACHINE, type SessionStatus, SESSION_TERMINAL_STATUSES } from './session.machine';

/**
 * C1 B2C 场次状态机（C1 §4 全迁移矩阵，简报「全迁移矩阵用例钉住」）：
 *   CREATED→FULL→CONFIRMED→OPEN→IN_SERVICE→FINISHED→HOLD→SETTLED（主链，D 域/F3 推进）；
 *   CREATED→FAILED（仅 ENROLL_DEADLINE 截止 job 判定，R-03 流标）；
 *   CANCELLED 受限入边=D4/M2 决策（M2-W2 T3 落位：非终态全集 5 态→CANCELLED；终态
 *   FINISHED/HOLD/SETTLED/FAILED/CANCELLED 无入边=409 NOT_CANCELLABLE 机器面依据）。
 * 全部迁移经 StateTransitionGuard+STL（entity_type='session'）——本件钉机器定义，
 * 守卫留痕归 DB spec（session.service.spec）。
 */
describe('C1 场次状态机（§4 全迁移矩阵，纯机器件）', () => {
  it('states=十态全集（§4 逐字），终态集=FAILED/CANCELLED/FINISHED/SETTLED（「不再需要占用锁」口径）', () => {
    expect(SESSION_MACHINE.def.states).toEqual([
      'CREATED',
      'FULL',
      'CONFIRMED',
      'OPEN',
      'IN_SERVICE',
      'FINISHED',
      'HOLD',
      'SETTLED',
      'FAILED',
      'CANCELLED',
    ]);
    expect(SESSION_MACHINE.def.entityType).toBe('session');
    expect([...SESSION_TERMINAL_STATUSES]).toEqual(['FAILED', 'CANCELLED', 'FINISHED', 'SETTLED']);
  });

  it('声明迁移恰 13 条：主链 7 边 + CREATED→FAILED + D4 受限入边 5 边（非终态全集→CANCELLED）', () => {
    const edges = SESSION_MACHINE.def.transitions.map((t) => `${t.from}→${t.to}`);
    expect(edges).toEqual([
      'CREATED→FULL',
      'FULL→CONFIRMED',
      'CONFIRMED→OPEN',
      'OPEN→IN_SERVICE',
      'IN_SERVICE→FINISHED',
      'FINISHED→HOLD',
      'HOLD→SETTLED',
      'CREATED→FAILED',
      'CREATED→CANCELLED',
      'FULL→CANCELLED',
      'CONFIRMED→CANCELLED',
      'OPEN→CANCELLED',
      'IN_SERVICE→CANCELLED',
    ]);
  });

  it('全迁移矩阵：13 条声明边放行，其余 10×10 全组合（含自环与终态出边）一律拒绝', () => {
    const states = SESSION_MACHINE.def.states;
    const expected = new Set<string>([
      'CREATED→FULL',
      'FULL→CONFIRMED',
      'CONFIRMED→OPEN',
      'OPEN→IN_SERVICE',
      'IN_SERVICE→FINISHED',
      'FINISHED→HOLD',
      'HOLD→SETTLED',
      'CREATED→FAILED',
      'CREATED→CANCELLED',
      'FULL→CANCELLED',
      'CONFIRMED→CANCELLED',
      'OPEN→CANCELLED',
      'IN_SERVICE→CANCELLED',
    ]);
    for (const from of states as readonly SessionStatus[]) {
      for (const to of states as readonly SessionStatus[]) {
        const key = `${from}→${to}`;
        if (expected.has(key)) {
          expect(SESSION_MACHINE.canTransition(from, to)).toBe(true);
          expect(() => SESSION_MACHINE.assertTransition(from, to)).not.toThrow();
        } else {
          expect(SESSION_MACHINE.canTransition(from, to)).toBe(false);
          expect(() => SESSION_MACHINE.assertTransition(from, to)).toThrow('非法状态迁移');
        }
      }
    }
  });

  it('机终态（SETTLED/FAILED/CANCELLED）无出边；FINISHED 唯一出边 HOLD（锁终态≠机终态：FINISHED 起不再需要占用锁，状态仍向 HOLD/SETTLED 推进）', () => {
    for (const terminal of ['SETTLED', 'FAILED', 'CANCELLED'] as const) {
      for (const to of SESSION_MACHINE.def.states) {
        expect(SESSION_MACHINE.canTransition(terminal, to)).toBe(false);
      }
    }
    for (const to of SESSION_MACHINE.def.states) {
      expect(SESSION_MACHINE.canTransition('FINISHED', to)).toBe(to === 'HOLD');
    }
  });
});
