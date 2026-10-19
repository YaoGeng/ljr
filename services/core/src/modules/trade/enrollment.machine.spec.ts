import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { ENROLLMENT_MACHINE, type EnrollmentPayStatus } from './enrollment.machine';

/**
 * C3 enrollment pay_status 状态机迁移矩阵（简报「经 StateTransitionGuard+STL
 * （entity_type='enrollment'）全矩阵用例」；§3 词汇 PENDING|PAID|REFUNDED 三态——
 * R-W3-O 裁决不加第四态；M2-W2 T4（C4）增第四态 CONVERTED_OUT=迁移出标记：
 *   - PENDING：报名下单初始态（下单事务即插行：快照+积分冻结+F1 单同事务）；
 *   - PENDING→PAID：支付成功回调（成团守卫事务：先席位计数后报名 PAID，§4/§9 顺序铁律）；
 *   - PENDING→REFUNDED：满员/终态自动退款分支（回调遇 FULL/FAILED/EXPIRED 等，R-01 未成团
 *     自动退款；F2 ISSUE_REFUND 受理后同事务终态化+F4 解冻）；
 *   - PAID→REFUNDED：退款完成收敛（RefundCompleted 消费；流标批量退款/部分退款完成）；
 *   - REFUNDED 唯一终态无出边（终态后重报=新行，ux_enroll_active 部分唯一保证）；
 *   - PAID→CONVERTED_OUT（M2-W2 T4）：C4 确认/认领转化的参与者迁移出标记——同事务新建
 *     session 型报名行（prev_enrollment_id 回链+快照复制），旧行置 CONVERTED_OUT（C4 §3；
 *     审计链铁律=迁移靠新建行，旧行仅状态位翻转，ref_type/ref_id/快照列禁 UPDATE）。
 *     CONVERTED_OUT 机终态无出边（退款完成收敛走后继行——advanceToRefunded 迁移链重定向）。
 */

const LEGAL: ReadonlyArray<readonly [EnrollmentPayStatus, EnrollmentPayStatus, string]> = [
  ['PENDING', 'PAID', '支付成功回调（成团守卫：先席位 UPDATE 后 PAID，顺序铁律 §4/§9）'],
  ['PENDING', 'REFUNDED', '满员/终态自动退款分支（R-01 未成团自动退款；F2 受理+STL 痕）'],
  ['PAID', 'REFUNDED', '退款完成收敛（RefundCompleted 消费；流标批量/部分退款）'],
  ['PAID', 'CONVERTED_OUT', 'C4 确认/认领转化迁移出（M2-W2 T4；新建行回链，旧行置标记）'],
];

const ILLEGAL: ReadonlyArray<readonly [EnrollmentPayStatus, EnrollmentPayStatus]> = [
  ['PENDING', 'PENDING'], // 自环非迁移（重投幂等走服务层短路，不进守卫）
  ['PAID', 'PENDING'], // 已支付不回退（退款走 REFUNDED，不发明撤销）
  ['PAID', 'PAID'],
  ['REFUNDED', 'PENDING'], // 终态无出边（重报=新行）
  ['REFUNDED', 'PAID'],
  ['REFUNDED', 'REFUNDED'],
  ['CONVERTED_OUT', 'PENDING'], // 迁移出标记无出边（退款收敛走后继行，不复活旧行）
  ['CONVERTED_OUT', 'PAID'],
  ['CONVERTED_OUT', 'REFUNDED'],
  ['CONVERTED_OUT', 'CONVERTED_OUT'],
  ['PENDING', 'CONVERTED_OUT'], // 未支付行不迁移（晚到回调走既有自动退款分支）
];

describe('C3 enrollment 状态机（entity_type=enrollment，四态迁移矩阵全用例钉住）', () => {
  it('entity_type 与状态全集=PENDING|PAID|REFUNDED 三态 + CONVERTED_OUT 迁移出标记（M2-W2 T4）', () => {
    expect(ENROLLMENT_MACHINE.def.entityType).toBe('enrollment');
    expect([...ENROLLMENT_MACHINE.def.states]).toEqual([
      'PENDING',
      'PAID',
      'REFUNDED',
      'CONVERTED_OUT',
    ]);
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
