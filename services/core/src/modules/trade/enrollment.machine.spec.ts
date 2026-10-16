import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { ENROLLMENT_MACHINE, type EnrollmentPayStatus } from './enrollment.machine';

/**
 * C3 enrollment pay_status 状态机迁移矩阵（简报「经 StateTransitionGuard+STL
 * （entity_type='enrollment'）全矩阵用例」；§3 词汇 PENDING|PAID|REFUNDED 三态——
 * R-W3-O 裁决不加第四态）：
 *   - PENDING：报名下单初始态（下单事务即插行：快照+积分冻结+F1 单同事务）；
 *   - PENDING→PAID：支付成功回调（成团原子守卫事务：先席位计数后报名 PAID，§4/§9 顺序铁律）；
 *   - PENDING→REFUNDED：满员/终态自动退款分支（回调遇 FULL/FAILED/EXPIRED 等，R-01 未成团
 *     自动退款；F2 ISSUE_REFUND 受理后同事务终态化+F4 解冻）；
 *   - PAID→REFUNDED：退款完成收敛（RefundCompleted 消费；流标批量退款/部分退款完成）；
 *   - REFUNDED 唯一终态无出边（终态后重报=新行，ux_enroll_active 部分唯一保证）。
 */

const LEGAL: ReadonlyArray<readonly [EnrollmentPayStatus, EnrollmentPayStatus, string]> = [
  ['PENDING', 'PAID', '支付成功回调（成团守卫：先席位 UPDATE 后 PAID，顺序铁律 §4/§9）'],
  ['PENDING', 'REFUNDED', '满员/终态自动退款分支（R-01 未成团自动退款；F2 受理+STL 痕）'],
  ['PAID', 'REFUNDED', '退款完成收敛（RefundCompleted 消费；流标批量/部分退款）'],
];

const ILLEGAL: ReadonlyArray<readonly [EnrollmentPayStatus, EnrollmentPayStatus]> = [
  ['PENDING', 'PENDING'], // 自环非迁移（重投幂等走服务层短路，不进守卫）
  ['PAID', 'PENDING'], // 已支付不回退（退款走 REFUNDED，不发明撤销）
  ['PAID', 'PAID'],
  ['REFUNDED', 'PENDING'], // 终态无出边（重报=新行）
  ['REFUNDED', 'PAID'],
  ['REFUNDED', 'REFUNDED'],
];

describe('C3 enrollment 状态机（entity_type=enrollment，三态迁移矩阵全用例钉住）', () => {
  it('entity_type 与状态全集照 §3 三态（R-W3-O：不加第四态）', () => {
    expect(ENROLLMENT_MACHINE.def.entityType).toBe('enrollment');
    expect([...ENROLLMENT_MACHINE.def.states]).toEqual(['PENDING', 'PAID', 'REFUNDED']);
  });

  it(`合法迁移恰 ${LEGAL.length} 条（矩阵冻结）`, () => {
    expect(ENROLLMENT_MACHINE.def.transitions.length).toBe(LEGAL.length);
  });

  it.each(LEGAL)('合法：%s → %s（%s）', (from, to) => {
    expect(ENROLLMENT_MACHINE.canTransition(from, to)).toBe(true);
    expect(() => ENROLLMENT_MACHINE.assertTransition(from, to)).not.toThrow();
  });

  it.each(ILLEGAL)('非法：%s → %s 拒绝（StateIllegalTransition, 409）', (from, to) => {
    expect(ENROLLMENT_MACHINE.canTransition(from, to)).toBe(false);
    try {
      ENROLLMENT_MACHINE.assertTransition(from, to);
      expect.unreachable('非法迁移必须抛出');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(ErrorCode.StateIllegalTransition);
      expect((e as { httpStatus?: number }).httpStatus).toBe(409);
    }
  });
});
