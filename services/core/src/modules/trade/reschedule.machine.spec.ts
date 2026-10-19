import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { RESCHEDULE_MACHINE, type RescheduleStatus } from './reschedule.machine';

/**
 * C5 reschedule_requests 状态机迁移矩阵（M2-W2 T5；§3 五态词汇逐字，状态禁裸写——
 * 全部迁移经 StateTransitionGuardService 守卫并落 STL（entity_type='reschedule_request'））：
 *   - PENDING：申请事务即插行（同事务预写 RESCHEDULE_CONFIRM_TIMEOUT job，due=expires_at）；
 *   - PENDING→CONFIRMED：律师确认（§4 确认事务：目标空位守卫+enrollment 迁移+joined+1）；
 *   - PENDING→FAILED：确认时目标空位守卫失败（满员/非 CREATED/非同律师）——请求终态化+409 NO_SEAT；
 *   - PENDING→EXPIRED：RESCHEDULE_CONFIRM_TIMEOUT 超时回退（R-04：原报名不动）；
 *   - PENDING→CANCELLED：用户撤回（确认前，§2）——同事务作废超时 job；
 *   - 四终态（CONFIRMED/FAILED/EXPIRED/CANCELLED）无出边（重开申请=新请求行，幂等键=enrollment
 *     的进行中唯一性由服务层守卫承载）。
 */

const LEGAL: ReadonlyArray<readonly [RescheduleStatus, RescheduleStatus, string]> = [
  [
    'PENDING',
    'CONFIRMED',
    '律师确认（§4 确认事务：空位守卫+旧行 RESCHEDULED_OUT+新建行+joined+1）',
  ],
  ['PENDING', 'FAILED', '确认时空位守卫失败（目标满员/非 CREATED/非同律师）——409 NO_SEAT 路径'],
  ['PENDING', 'EXPIRED', 'RESCHEDULE_CONFIRM_TIMEOUT 超时回退（R-04：原报名不动）'],
  ['PENDING', 'CANCELLED', '用户撤回（确认前，§2；同事务作废超时 job）'],
];

const ILLEGAL: ReadonlyArray<readonly [RescheduleStatus, RescheduleStatus]> = [
  ['PENDING', 'PENDING'], // 自环非迁移（幂等走服务层短路，不进守卫）
  ['CONFIRMED', 'PENDING'], // 终态无出边（已确认不可撤——C5 §5 cancel 409 CONFIRMED 的守卫半边）
  ['CONFIRMED', 'CANCELLED'],
  ['CONFIRMED', 'EXPIRED'],
  ['CONFIRMED', 'FAILED'],
  ['FAILED', 'PENDING'],
  ['EXPIRED', 'PENDING'],
  ['EXPIRED', 'CONFIRMED'], // 已过期不可确认（C5 §5 confirm 409 EXPIRED 的守卫半边）
  ['CANCELLED', 'PENDING'],
  ['CANCELLED', 'CONFIRMED'],
];

describe('C5 reschedule_requests 状态机（entity_type=reschedule_request，五态迁移矩阵全用例钉住）', () => {
  it('entity_type 与状态全集=PENDING|CONFIRMED|FAILED|EXPIRED|CANCELLED（§3 逐字）', () => {
    expect(RESCHEDULE_MACHINE.def.entityType).toBe('reschedule_request');
    expect([...RESCHEDULE_MACHINE.def.states]).toEqual([
      'PENDING',
      'CONFIRMED',
      'FAILED',
      'EXPIRED',
      'CANCELLED',
    ]);
  });

  it(`合法迁移恰 ${LEGAL.length} 条（全部自 PENDING 出发——终态无出边）`, () => {
    expect(RESCHEDULE_MACHINE.def.transitions.length).toBe(LEGAL.length);
    for (const rule of RESCHEDULE_MACHINE.def.transitions) {
      expect(rule.from).toBe('PENDING');
    }
  });

  it.each(LEGAL)('合法：%s → %s（%s）', (from, to) => {
    expect(RESCHEDULE_MACHINE.canTransition(from, to)).toBe(true);
    expect(() => RESCHEDULE_MACHINE.assertTransition(from, to)).not.toThrow();
  });

  it.each(ILLEGAL)('非法：%s → %s 拒绝（StateIllegalTransition, 409）', (from, to) => {
    expect(RESCHEDULE_MACHINE.canTransition(from, to)).toBe(false);
    try {
      RESCHEDULE_MACHINE.assertTransition(from, to);
      expect.unreachable('非法迁移必须抛出');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(ErrorCode.StateIllegalTransition);
      expect((e as { httpStatus?: number }).httpStatus).toBe(409);
    }
  });
});
