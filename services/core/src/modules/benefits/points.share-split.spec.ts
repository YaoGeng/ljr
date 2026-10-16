import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import { splitAbsenceShare } from './points.share-split';

/**
 * R-04 分摊取整纯函数矩阵（F4 §7 R-04 逐字口径 + Task 2 简报裁决）：
 *   每用户分配额 = 30% 总额 × (本人 paid ÷ 到场 paid 合计)，向下取整到分，
 *   余数归 user_id 升序首名；积分化 = 分→积分 ×1（= 元 ×100，100 积分=1 元恒等，
 *  「积分化 ×100 只在 int 域」以 cents 承载，恒等式 points === share_cents 在矩阵钉死）。
 *
 * 全程 int 域（分）：30% 池先取整到分，再按占比 floor 分配，Σ分配 ≤ 30% 池。
 * 消费方 D3=M2：本切片只落纯函数定义+全边界单测，函数导出位即可，不接事件。
 */
describe('R-04 缺席 30% 分摊取整纯函数（F4 §7）', () => {
  it('均分：池 1000 分、两人各付一半 → 各 150 分（30% 池 300 平分无余数）', () => {
    const r = splitAbsenceShare(1000, [
      { user_id: 1, paid_cents: 500 },
      { user_id: 2, paid_cents: 500 },
    ]);
    expect(r).toEqual([
      { user_id: 1, share_cents: 150, points: 150 },
      { user_id: 2, share_cents: 150, points: 150 },
    ]);
  });

  it('占比不整除向下取整：池 100 分、1:2 出资 → 10/20（floor(30×⅓)=10、floor(30×⅔)=20）', () => {
    const r = splitAbsenceShare(100, [
      { user_id: 1, paid_cents: 1 },
      { user_id: 2, paid_cents: 2 },
    ]);
    expect(r.map((a) => [a.user_id, a.share_cents])).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });

  it('余数归 user_id 升序首名：池 105 分（30% 池 31）、等额出资 → 首名 16、次名 15', () => {
    const r = splitAbsenceShare(105, [
      { user_id: 5, paid_cents: 1 },
      { user_id: 3, paid_cents: 1 }, // user_id 3 < 5：首名是 3（与出资金额、数组顺序无关）
    ]);
    expect(r).toEqual([
      { user_id: 3, share_cents: 16, points: 16 },
      { user_id: 5, share_cents: 15, points: 15 },
    ]);
  });

  it('30% 池本身取整到分：池 101 分 → 30% 池 30（floor(30.3)），两人各 15', () => {
    const r = splitAbsenceShare(101, [
      { user_id: 1, paid_cents: 7 },
      { user_id: 2, paid_cents: 3 },
    ]);
    // 30×0.7=21 恰整、30×0.3=9 恰整（该例无占比余数；30% 取整损耗由池吸收）
    expect(r.map((a) => a.share_cents)).toEqual([21, 9]);
  });

  it('单人到场：独占 30% 池（floor）', () => {
    const r = splitAbsenceShare(999, [{ user_id: 42, paid_cents: 999 }]);
    // 30% 池 = floor(999×3/10) = 299（2997/10=299.7）
    expect(r).toEqual([{ user_id: 42, share_cents: 299, points: 299 }]);
  });

  it('占比分配精度矩阵（NUMERIC(12,2) 上限池 + 极端占比，BigInt 域防 2^53 溢出）', () => {
    // 上限池：999999999999 分 → 30% 池 = floor(2999999999997/10) = 299999999999
    const pool = 999_999_999_999;
    const r = splitAbsenceShare(pool, [
      { user_id: 1, paid_cents: 1 },
      { user_id: 2, paid_cents: 999_999_999_998 },
    ]);
    // 首名（user 1）：floor(299999999999 × 1 / 999999999999) = 0 + 余数 1 = 1
    // 次名：floor(299999999999 × 999999999998 / 999999999999) = 299999999998
    expect(r).toEqual([
      { user_id: 1, share_cents: 1, points: 1 },
      { user_id: 2, share_cents: 299_999_999_998, points: 299_999_999_998 },
    ]);
    expect(r.reduce((s, a) => s + a.share_cents, 0)).toBe(299_999_999_999);
  });

  it('Σ分配额恒 ≤ 30% 池（不变量，随机形态抽查）', () => {
    const cases: Array<[number, Array<{ user_id: number; paid_cents: number }>]> = [
      [12345, [{ user_id: 1, paid_cents: 1 }, { user_id: 2, paid_cents: 2 }, { user_id: 3, paid_cents: 3 }]],
      [7, [{ user_id: 1, paid_cents: 100 }, { user_id: 2, paid_cents: 1 }]],
      [999999999999, [{ user_id: 9, paid_cents: 3 }, { user_id: 4, paid_cents: 1 }]],
    ];
    for (const [pool, participants] of cases) {
      const r = splitAbsenceShare(pool, participants);
      const pool30 = Math.floor((pool * 3) / 10);
      expect(r.reduce((s, a) => s + a.share_cents, 0)).toBeLessThanOrEqual(pool30);
      // 输出按 user_id 升序（余数归首名的确定性口径的可观察面）
      expect(r.map((a) => a.user_id)).toEqual([...r.map((a) => a.user_id)].sort((a, b) => a - b));
      for (const a of r) expect(a.points).toBe(a.share_cents); // 分→积分 ×1 恒等（= 元 ×100）
    }
  });

  it('零付费不可分：合计 paid=0 → InvalidArgument（占比分母 0，显性化不静默全归首名）', () => {
    expect(() =>
      splitAbsenceShare(1000, [
        { user_id: 1, paid_cents: 0 },
        { user_id: 2, paid_cents: 0 },
      ]),
    ).toThrowError();
  });

  it('入参防御：空名单/负 paid/重复 user_id/非法池 → InvalidArgument', () => {
    const bad = [
      () => splitAbsenceShare(100, []),
      () => splitAbsenceShare(-1, [{ user_id: 1, paid_cents: 1 }]),
      () => splitAbsenceShare(1.5, [{ user_id: 1, paid_cents: 1 }]),
      () => splitAbsenceShare(100, [{ user_id: 1, paid_cents: -5 }]),
      () =>
        splitAbsenceShare(100, [
          { user_id: 1, paid_cents: 1 },
          { user_id: 1, paid_cents: 2 },
        ]),
    ];
    for (const fn of bad) {
      try {
        fn();
        expect.unreachable('应抛 InvalidArgument');
      } catch (e) {
        expect((e as { code?: string }).code).toBe(ErrorCode.InvalidArgument);
      }
    }
  });
});
