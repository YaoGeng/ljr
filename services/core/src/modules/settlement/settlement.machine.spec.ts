import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { SETTLEMENT_MACHINE, type SettlementStatus } from './settlement.machine';

/**
 * F3 settlement 状态机迁移矩阵（§4 逐字 + R-01/R-02/R-07 语义，全迁移矩阵用例）：
 *   - PENDING→HOLD：结算创建即入 24h 冻结期（R-02；hold_reason=HOLD_24H，同事务注册
 *     SETTLE_HOLD_RELEASE job——服务层承担，状态机只管迁移合法性）；
 *   - HOLD→READY：释放（24h 到期 SETTLE_HOLD_RELEASE / 工单关闭 TicketResolved）；
 *   - READY→SETTLED：唯一解冻分账节点（R-01 硬规则：履约完成+HOLD 过/释放后才可分账；
 *     成团仅续冻=F1 指令面语义，本状态机无「续冻」边——成团不触碰 settlement 行）；
 *   - HOLD→SUSPENDED / READY→SUSPENDED：进件非 ACTIVE 挂起（R-07，事件驱动）；
 *   - SUSPENDED→READY：进件恢复且释放条件已满足（冻结期满+无工单）→ 重驱动分账；
 *   - SUSPENDED→HOLD：进件恢复但冻结期未满/工单未闭（回冻结期重走，锚仍=created_at）；
 *   - SETTLED 唯一终态无出边；PENDING 无跳变出边（创建与入 HOLD 同事务原子）。
 */

const LEGAL: ReadonlyArray<readonly [SettlementStatus, SettlementStatus, string]> = [
  ['PENDING', 'HOLD', '进入 24h 冻结期（R-02；hold_reason=HOLD_24H）'],
  ['HOLD', 'READY', '释放：24h 到期（SETTLE_HOLD_RELEASE）/ 工单关闭（TicketResolved）'],
  ['READY', 'SETTLED', '唯一解冻分账节点（R-01；/pay/split 指令确认后落定）'],
  ['HOLD', 'SUSPENDED', '进件非 ACTIVE 挂起（R-07 事件驱动）'],
  ['READY', 'SUSPENDED', '进件非 ACTIVE 挂起（R-07；含 SETTLED 前置断言失败路径）'],
  ['SUSPENDED', 'READY', '进件恢复且释放条件已满足 → 重驱动分账'],
  ['SUSPENDED', 'HOLD', '进件恢复但冻结期未满/工单未闭 → 回冻结期（锚=created_at）'],
];

const ILLEGAL: ReadonlyArray<readonly [SettlementStatus, SettlementStatus]> = [
  ['PENDING', 'PENDING'], // 自环非迁移
  ['PENDING', 'READY'], // 冻结期未过不得释放（R-02）
  ['PENDING', 'SETTLED'], // 跳过 HOLD 直分被禁（§9 硬禁止项）
  ['PENDING', 'SUSPENDED'], // PENDING 瞬态（创建与入 HOLD 同事务，无挂起语义）
  ['HOLD', 'PENDING'], // 冻结不可逆退
  ['HOLD', 'HOLD'], // 自环非迁移
  ['HOLD', 'SETTLED'], // 跳过 READY 直分被禁（R-01 唯一解冻节点）
  ['READY', 'PENDING'], // 释放不可逆退
  ['READY', 'HOLD'], // 释放不可逆退（续冻是成团语义，不触碰 settlement）
  ['READY', 'READY'], // 自环非迁移
  ['SETTLED', 'PENDING'], // 终态无出边
  ['SETTLED', 'HOLD'], // 终态无出边
  ['SETTLED', 'READY'], // 终态无出边（分账后不可撤销）
  ['SETTLED', 'SETTLED'], // 自环非迁移
  ['SETTLED', 'SUSPENDED'], // 终态无出边
  ['SUSPENDED', 'PENDING'], // 挂起不可逆退到瞬态
  ['SUSPENDED', 'SETTLED'], // 挂起必须先回 READY（R-01 唯一解冻节点）再分账
  ['SUSPENDED', 'SUSPENDED'], // 自环非迁移
];

describe('F3 settlement 状态机（entity_type=settlement，五态迁移矩阵全用例钉住）', () => {
  it('entity_type 与状态全集照 §4 五态', () => {
    expect(SETTLEMENT_MACHINE.def.entityType).toBe('settlement');
    expect([...SETTLEMENT_MACHINE.def.states]).toEqual([
      'PENDING',
      'HOLD',
      'READY',
      'SETTLED',
      'SUSPENDED',
    ]);
  });

  it(`合法迁移恰 ${LEGAL.length} 条（矩阵冻结；非法全序对 ${ILLEGAL.length} 条穷举）`, () => {
    expect(SETTLEMENT_MACHINE.def.transitions.length).toBe(LEGAL.length);
  });

  it.each(LEGAL)('合法：%s → %s（%s）', (from, to) => {
    expect(SETTLEMENT_MACHINE.canTransition(from, to)).toBe(true);
    expect(() => SETTLEMENT_MACHINE.assertTransition(from, to)).not.toThrow();
  });

  it.each(ILLEGAL)('非法：%s → %s 拒绝（StateIllegalTransition, 409）', (from, to) => {
    expect(SETTLEMENT_MACHINE.canTransition(from, to)).toBe(false);
    try {
      SETTLEMENT_MACHINE.assertTransition(from, to);
      expect.unreachable('非法迁移必须抛出');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(ErrorCode.StateIllegalTransition);
      expect((e as { httpStatus?: number }).httpStatus).toBe(409);
    }
  });
});
