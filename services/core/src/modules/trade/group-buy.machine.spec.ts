import { describe, expect, it } from 'vitest';
import {
  GROUP_BUY_MACHINE,
  type GroupBuyStatus,
  GROUP_BUY_TERMINAL_STATUSES,
} from './group-buy.machine';

/**
 * C2 C2B 拼团状态机（C2 §4 全迁移矩阵，简报「全矩阵用例」钉住）：
 *   PUBLISHED→REACHED→PENDING_LAWYER→CONFIRMED（成团主链，C3 守卫推进/确认 C4=M2）；
 *   PUBLISHED→EXPIRED→REFUNDED（截止未成流标链，本模块执行器→EXPIRED、REFUNDED=F2=T6）；
 *   PENDING_LAWYER→REJECTED→REFUNDED（拒绝链，超时自动拒=本模块执行器、显式拒/退款=C4/F2=M2/T6）；
 *   PUBLISHED/REACHED→CONVERTED（C4 认领转化=M2）+ PENDING_LAWYER→CONVERTED（M2-W2 T4 增边：
 *   执行计划 T4 行裁定「PENDING_LAWYER 可直接转化=认领」——12h 确认窗内的高需求拼团可直接
 *   认领转化，不必先确认再处置；C2 §4 文档原文仅 PUBLISHED/REACHED，增量建议随勾账回写）。
 * 全部迁移经 StateTransitionGuard+STL（entity_type='group_buy'）——本件钉机器定义，
 * 守卫留痕归 DB spec（group-buy.service.spec）。
 */
describe('C2 拼团状态机（§4 全迁移矩阵，纯机器件）', () => {
  it('states=八态全集（§4 逐字），entity_type=group_buy；锁终态集=EXPIRED/REJECTED/REFUNDED/CONVERTED（「不再需要占用锁」口径）', () => {
    expect(GROUP_BUY_MACHINE.def.states).toEqual([
      'PUBLISHED',
      'REACHED',
      'PENDING_LAWYER',
      'CONFIRMED',
      'EXPIRED',
      'REJECTED',
      'REFUNDED',
      'CONVERTED',
    ]);
    expect(GROUP_BUY_MACHINE.def.entityType).toBe('group_buy');
    expect([...GROUP_BUY_TERMINAL_STATUSES]).toEqual([
      'EXPIRED',
      'REJECTED',
      'REFUNDED',
      'CONVERTED',
    ]);
  });

  it('声明迁移恰 10 条：成团主链 3 边 + 流标链 2 边 + 拒绝链 2 边 + 转化 3 边（§4 逐字 + M2-W2 T4 增边）', () => {
    const edges = GROUP_BUY_MACHINE.def.transitions.map((t) => `${t.from}→${t.to}`);
    expect(edges).toEqual([
      'PUBLISHED→REACHED',
      'REACHED→PENDING_LAWYER',
      'PENDING_LAWYER→CONFIRMED',
      'PUBLISHED→EXPIRED',
      'EXPIRED→REFUNDED',
      'PENDING_LAWYER→REJECTED',
      'REJECTED→REFUNDED',
      'PUBLISHED→CONVERTED',
      'REACHED→CONVERTED',
      'PENDING_LAWYER→CONVERTED',
    ]);
  });

  it('全迁移矩阵：10 条声明边放行，其余 8×8 全组合（含自环与终态出边）一律拒绝', () => {
    const states = GROUP_BUY_MACHINE.def.states;
    const expected = new Set<string>([
      'PUBLISHED→REACHED',
      'REACHED→PENDING_LAWYER',
      'PENDING_LAWYER→CONFIRMED',
      'PUBLISHED→EXPIRED',
      'EXPIRED→REFUNDED',
      'PENDING_LAWYER→REJECTED',
      'REJECTED→REFUNDED',
      'PUBLISHED→CONVERTED',
      'REACHED→CONVERTED',
      'PENDING_LAWYER→CONVERTED',
    ]);
    for (const from of states as readonly GroupBuyStatus[]) {
      for (const to of states as readonly GroupBuyStatus[]) {
        const key = `${from}→${to}`;
        if (expected.has(key)) {
          expect(GROUP_BUY_MACHINE.canTransition(from, to)).toBe(true);
          expect(() => GROUP_BUY_MACHINE.assertTransition(from, to)).not.toThrow();
        } else {
          expect(GROUP_BUY_MACHINE.canTransition(from, to)).toBe(false);
          expect(() => GROUP_BUY_MACHINE.assertTransition(from, to)).toThrow('非法状态迁移');
        }
      }
    }
  });

  it('机终态（REFUNDED/CONVERTED）无出边；锁终态≠机终态：EXPIRED/REJECTED 唯一出边 REFUNDED（退款=F2=T6，迁移期锁已同事务释放）', () => {
    for (const terminal of ['REFUNDED', 'CONVERTED'] as const) {
      for (const to of GROUP_BUY_MACHINE.def.states) {
        expect(GROUP_BUY_MACHINE.canTransition(terminal, to)).toBe(false);
      }
    }
    for (const lockTerminal of ['EXPIRED', 'REJECTED'] as const) {
      for (const to of GROUP_BUY_MACHINE.def.states) {
        expect(GROUP_BUY_MACHINE.canTransition(lockTerminal, to)).toBe(to === 'REFUNDED');
      }
    }
  });
});
