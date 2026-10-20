import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import { ONE_ON_ONE_MACHINE, ONE_ON_ONE_MACHINE_TERMINAL_STATUSES } from './one-on-one.machine';

/**
 * D6 1对1 订单状态机（§4 迁移矩阵 + M2-W3 T2 冻结口径）：主链
 * CREATED→PAID→ACCEPTED→IN_SERVICE→FINISHED→SETTLING→SETTLED；实结分支
 * SETTLING→REFUND_PARTIAL→SETTLED / SETTLING→DIFF_PENDING→SETTLED；超时
 * PAID→LAWYER_TIMEOUT→REFUNDED；取消三档 PAID/ACCEPTED/IN_SERVICE→CANCELLED→
 * REFUNDED|PARTIAL_REFUNDED。全部迁移经 StateTransitionGuard+STL
 * （entity_type='one_on_one_order'）——本件钉机器定义，守卫留痕归 DB spec。
 */
describe('D6 1对1 订单状态机（§4 迁移矩阵，纯机器件）', () => {
  it('states=十三态全集（V47 ck 同源），终态集五值', () => {
    expect(ONE_ON_ONE_MACHINE.def.states).toEqual([
      'CREATED',
      'PAID',
      'ACCEPTED',
      'IN_SERVICE',
      'FINISHED',
      'SETTLING',
      'SETTLED',
      'LAWYER_TIMEOUT',
      'REFUNDED',
      'CANCELLED',
      'PARTIAL_REFUNDED',
      'REFUND_PARTIAL',
      'DIFF_PENDING',
    ]);
    expect(ONE_ON_ONE_MACHINE.def.entityType).toBe('one_on_one_order');
    expect([...ONE_ON_ONE_MACHINE_TERMINAL_STATUSES]).toEqual([
      'SETTLED',
      'LAWYER_TIMEOUT',
      'REFUNDED',
      'CANCELLED',
      'PARTIAL_REFUNDED',
    ]);
  });

  it('声明迁移恰 17 条（§4 逐边：主链 6 + 实结分支 4 + 超时 2 + 取消 5）', () => {
    const edges = ONE_ON_ONE_MACHINE.def.transitions.map((t) => `${t.from}→${t.to}`);
    expect(edges).toEqual([
      // 主链
      'CREATED→PAID',
      'PAID→ACCEPTED',
      'ACCEPTED→IN_SERVICE',
      'IN_SERVICE→FINISHED',
      'FINISHED→SETTLING',
      'SETTLING→SETTLED',
      // 实结分支（多退/少补）
      'SETTLING→REFUND_PARTIAL',
      'REFUND_PARTIAL→SETTLED',
      'SETTLING→DIFF_PENDING',
      'DIFF_PENDING→SETTLED',
      // 接单超时
      'PAID→LAWYER_TIMEOUT',
      'LAWYER_TIMEOUT→REFUNDED',
      // 取消三档
      'PAID→CANCELLED',
      'ACCEPTED→CANCELLED',
      'IN_SERVICE→CANCELLED',
      'CANCELLED→REFUNDED',
      'CANCELLED→PARTIAL_REFUNDED',
    ]);
  });

  it('全迁移矩阵：17 条声明边放行，其余 13×13 全组合（含自环与终态出边）一律拒绝', () => {
    const states = ONE_ON_ONE_MACHINE.def.states;
    const allowed = new Set(ONE_ON_ONE_MACHINE.def.transitions.map((t) => `${t.from}→${t.to}`));
    for (const from of states) {
      for (const to of states) {
        const key = `${from}→${to}`;
        if (allowed.has(key)) {
          expect(() => ONE_ON_ONE_MACHINE.assertTransition(from, to)).not.toThrow();
        } else {
          try {
            ONE_ON_ONE_MACHINE.assertTransition(from, to);
            expect.unreachable(`非法迁移 ${key} 未被拒绝`);
          } catch (e) {
            expect(e).toBeInstanceOf(AppError);
            expect((e as AppError).code).toBe(ErrorCode.StateIllegalTransition);
          }
        }
      }
    }
  });
});
