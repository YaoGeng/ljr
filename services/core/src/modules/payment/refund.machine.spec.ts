import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { REFUND_MACHINE, type RefundStatus } from './refund.machine';

/**
 * F2 refund 状态机迁移矩阵（简报「REQUESTED→PROCESSING→DONE/FAILED；全经
 * StateTransitionGuard+STL（entity_type='refund'）全矩阵用例」）：
 *   - REQUESTED：受理落单（幂等 claim 后初始态），尚未进入下发轨道；
 *   - REQUESTED→PROCESSING：首次下发启动（F1 refund 指令面调用前，指令在途语义含重试）；
 *   - PROCESSING→DONE：REFUND_SUCCESS 回调推进（F1 Inbox 事件驱动），落 done_at；
 *   - PROCESSING→FAILED：下发重试耗尽（3 次退避，§4「失败重试 3 次后工单」）；
 *   - DONE/FAILED 唯一终态无出边（FAILED 复活=人工/工单面 H3，M2 接线，不在本批）。
 */

const LEGAL: ReadonlyArray<readonly [RefundStatus, RefundStatus, string]> = [
  ['REQUESTED', 'PROCESSING', '首次下发启动（F1 refund 指令下发；指令在途含退避重试）'],
  ['PROCESSING', 'DONE', 'REFUND_SUCCESS 回调推进（F1 Inbox 事件；落 done_at）'],
  ['PROCESSING', 'FAILED', '下发重试耗尽（3 次退避后工单，RefundFailed 出箱）'],
];

const ILLEGAL: ReadonlyArray<readonly [RefundStatus, RefundStatus]> = [
  ['REQUESTED', 'DONE'], // 未下发先完成：跳过指令在途节点
  ['REQUESTED', 'FAILED'], // 受理单未进轨道不终局（失败语义挂在 PROCESSING 重试耗尽）
  ['REQUESTED', 'REQUESTED'], // 自环非迁移
  ['PROCESSING', 'REQUESTED'], // 退避重试不发起新迁移（停留 PROCESSING，同 F1 REFUNDING 口径）
  ['PROCESSING', 'PROCESSING'],
  ['DONE', 'REQUESTED'],
  ['DONE', 'PROCESSING'],
  ['DONE', 'FAILED'],
  ['DONE', 'DONE'],
  ['FAILED', 'REQUESTED'],
  ['FAILED', 'PROCESSING'],
  ['FAILED', 'DONE'],
  ['FAILED', 'FAILED'], // 终态无出边（复活走人工/工单面，不在本批）
];

describe('F2 refund 状态机（entity_type=refund，四态迁移矩阵全用例钉住）', () => {
  it('entity_type 与状态全集照简报四态', () => {
    expect(REFUND_MACHINE.def.entityType).toBe('refund');
    expect([...REFUND_MACHINE.def.states]).toEqual(['REQUESTED', 'PROCESSING', 'DONE', 'FAILED']);
  });

  it(`合法迁移恰 ${LEGAL.length} 条（矩阵冻结）`, () => {
    expect(REFUND_MACHINE.def.transitions.length).toBe(LEGAL.length);
  });

  it.each(LEGAL)('合法：%s → %s（%s）', (from, to) => {
    expect(REFUND_MACHINE.canTransition(from, to)).toBe(true);
    expect(() => REFUND_MACHINE.assertTransition(from, to)).not.toThrow();
  });

  it.each(ILLEGAL)('非法：%s → %s 拒绝（StateIllegalTransition, 409）', (from, to) => {
    expect(REFUND_MACHINE.canTransition(from, to)).toBe(false);
    try {
      REFUND_MACHINE.assertTransition(from, to);
      expect.unreachable('非法迁移必须抛出');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(ErrorCode.StateIllegalTransition);
      expect((e as { httpStatus?: number }).httpStatus).toBe(409);
    }
  });
});
