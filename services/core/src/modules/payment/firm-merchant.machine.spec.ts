import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import {
  FIRM_MERCHANT_MACHINE,
  LAWYER_DEPOSIT_MACHINE,
  type FirmMerchantStatus,
  type LawyerDepositStatus,
} from './firm-merchant.machine';

/**
 * A3b 状态机迁移矩阵（A3b §4 逐字 + Task 3 简报「迁移矩阵全用例钉住」）：
 *   firm_merchant（entity_type='firm_merchant'）六态：
 *     SUBMITTING→IN_REVIEW（机构受理/提交）→ACTIVE（审核通过/生效）→
 *     (CHANGING→ACTIVE | SUSPENDED | STOPPED)；SUSPENDED→ACTIVE（复验/变更完成）。
 *     - ACTIVE→CHANGING：对公账户变更发起（R-02）；R-W3-C2 裁决=进入 CHANGING 即分账暂停语义
 *       （F3 查询态 CHANGING 与 SUSPENDED 同拒），并发事件 FirmMerchantSuspended(ACCOUNT_CHANGING)
 *       由服务层同事务出箱（状态机只管迁移合法性）；
 *     - CHANGING→SUSPENDED：变更流程转暂停（§4 图出边）；
 *     - ACTIVE→SUSPENDED：年度复验到期未复验（R-03）/运营暂停；
 *     - ACTIVE→STOPPED：停用（合作终止）；STOPPED 唯一终态无出边（复开通=重新进件，唯一约束
 *       (firm_id,channel) 下须走新迁移扩边，本批不发明）；
 *     - 无 SUBMITTING/IN_REVIEW 的跳变出边（未受理不得生效/暂停/停用）。
 *   lawyer_deposit（entity_type='lawyer_deposit'）两态：ISSUED→FROZEN（指令下发→通道确认）；
 *     FROZEN 无出边（释放/扣减划转是 F3 处置词汇，落位时走新迁移扩边，本批不发明）。
 */

const FIRM_LEGAL: ReadonlyArray<readonly [FirmMerchantStatus, FirmMerchantStatus, string]> = [
  ['SUBMITTING', 'IN_REVIEW', '机构受理/材料提交完成'],
  ['IN_REVIEW', 'ACTIVE', '机构审核通过（生效；verified_at/reverify_due 落定+Activated 事件）'],
  ['ACTIVE', 'CHANGING', '对公账户变更发起（R-02；R-W3-C2=分账暂停语义，Suspended(ACCOUNT_CHANGING) 同事务出箱）'],
  ['CHANGING', 'ACTIVE', '变更重新进件完成（→ACTIVE 同生效口径：刷新 verified_at/reverify_due+job）'],
  ['CHANGING', 'SUSPENDED', '变更流程转暂停（§4 图出边）'],
  ['ACTIVE', 'SUSPENDED', '复验到期未复验（R-03，FIRM_REVERIFY 执行器）/运营暂停'],
  ['ACTIVE', 'STOPPED', '停用（合作终止）'],
  ['SUSPENDED', 'ACTIVE', '复验/变更完成（复验经 POST reverify 端点，R-03）'],
];

/** 全序对穷举（含自环）：36 对 - 8 合法 = 28 非法，全量钉住不留死角 */
const FIRM_STATES: readonly FirmMerchantStatus[] = [
  'SUBMITTING',
  'IN_REVIEW',
  'ACTIVE',
  'CHANGING',
  'SUSPENDED',
  'STOPPED',
];
const FIRM_ILLEGAL = FIRM_STATES.flatMap((from) =>
  FIRM_STATES.map((to) => [from, to] as const).filter(
    ([f, t]) => !FIRM_LEGAL.some(([lf, lt]) => lf === f && lt === t),
  ),
);

describe('A3b firm_merchant 状态机（entity_type=firm_merchant，六态迁移矩阵全用例钉住）', () => {
  it('entity_type 与状态全集照 §3 注释六态', () => {
    expect(FIRM_MERCHANT_MACHINE.def.entityType).toBe('firm_merchant');
    expect([...FIRM_MERCHANT_MACHINE.def.states]).toEqual([
      'SUBMITTING',
      'IN_REVIEW',
      'ACTIVE',
      'CHANGING',
      'SUSPENDED',
      'STOPPED',
    ]);
  });

  it(`合法迁移恰 ${FIRM_LEGAL.length} 条（矩阵冻结：§4 图逐字）`, () => {
    expect(FIRM_MERCHANT_MACHINE.def.transitions.length).toBe(FIRM_LEGAL.length);
  });

  it.each(FIRM_LEGAL)('合法：%s → %s（%s）', (from, to) => {
    expect(FIRM_MERCHANT_MACHINE.canTransition(from, to)).toBe(true);
    expect(() => FIRM_MERCHANT_MACHINE.assertTransition(from, to)).not.toThrow();
  });

  it(`非法迁移恰 ${FIRM_ILLEGAL.length} 条（全序对穷举含自环），全部拒绝（StateIllegalTransition, 409）`, () => {
    expect(FIRM_ILLEGAL.length).toBe(36 - FIRM_LEGAL.length);
  });

  it.each(FIRM_ILLEGAL)('非法：%s → %s 拒绝', (from, to) => {
    expect(FIRM_MERCHANT_MACHINE.canTransition(from, to)).toBe(false);
    try {
      FIRM_MERCHANT_MACHINE.assertTransition(from, to);
      expect.unreachable('非法迁移必须抛出');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(ErrorCode.StateIllegalTransition);
      expect((e as { httpStatus?: number }).httpStatus).toBe(409);
    }
  });

  it('R-01 语义锚点：仅 ACTIVE 有到 CHANGING/SUSPENDED/STOPPED 的出边；STOPPED/SUSPENDED 非法出边全拒', () => {
    for (const to of ['CHANGING', 'SUSPENDED', 'STOPPED'] as const) {
      expect(FIRM_MERCHANT_MACHINE.canTransition('ACTIVE', to)).toBe(true);
      expect(FIRM_MERCHANT_MACHINE.canTransition('IN_REVIEW', to)).toBe(false);
      expect(FIRM_MERCHANT_MACHINE.canTransition('SUBMITTING', to)).toBe(false);
    }
    for (const from of ['STOPPED', 'SUSPENDED', 'CHANGING'] as const) {
      expect(FIRM_MERCHANT_MACHINE.canTransition(from, 'STOPPED')).toBe(false);
    }
  });
});

describe('A3b lawyer_deposit 状态机（entity_type=lawyer_deposit，ISSUED|FROZEN）', () => {
  it('entity_type 与状态全集两态；合法迁移恰 1 条', () => {
    expect(LAWYER_DEPOSIT_MACHINE.def.entityType).toBe('lawyer_deposit');
    expect([...LAWYER_DEPOSIT_MACHINE.def.states]).toEqual(['ISSUED', 'FROZEN']);
    expect(LAWYER_DEPOSIT_MACHINE.def.transitions.length).toBe(1);
    expect(LAWYER_DEPOSIT_MACHINE.canTransition('ISSUED', 'FROZEN')).toBe(true);
    expect(() => LAWYER_DEPOSIT_MACHINE.assertTransition('ISSUED', 'FROZEN')).not.toThrow();
  });

  it.each([
    ['FROZEN', 'ISSUED'],
    ['FROZEN', 'FROZEN'],
    ['ISSUED', 'ISSUED'],
  ] as ReadonlyArray<readonly [LawyerDepositStatus, LawyerDepositStatus]>)(
    '非法：%s → %s（FROZEN 终态无出边；释放/扣减划转=F3 处置词汇，本批不发明）',
    (from, to) => {
      expect(LAWYER_DEPOSIT_MACHINE.canTransition(from, to)).toBe(false);
      expect(() => LAWYER_DEPOSIT_MACHINE.assertTransition(from, to)).toThrow();
    },
  );
});
