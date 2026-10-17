import { describe, expect, it } from 'vitest';
import { classifyChange, computeCompensations } from './price-change.engine';

/**
 * C6 改价引擎纯函数层（R-01 三档矩阵 + R-05 补偿计算）——无 PG 单元层。
 * 金额全程整数分域（1 元=100 分；积分 1 分=1 分即 points==cents），BigInt 精确除法禁 float。
 * 三档边界（10.0% 恰档）与补偿占比分母（D17：paid_amount 全额=cash+points/100）为 §9 必测项。
 */

describe('C6 引擎·classifyChange（R-01 三档矩阵，10.0% 边界恰档）', () => {
  it('UP 且在团：kind=PRICE_UP，信用 -5，不需审批（涨价允许）', () => {
    const c = classifyChange(10_000, 12_000, true);
    expect(c.direction).toBe('UP');
    expect(c.kind).toBe('PRICE_UP');
    expect(c.creditPenalty).toBe(-5);
    expect(c.tierRequiresApproval).toBe(false);
  });

  it('UP 且不在团：档位同归类但信用 0（PRD §8.2 惩罚表=在团场景），不需审批', () => {
    const c = classifyChange(10_000, 12_000, false);
    expect(c.kind).toBe('PRICE_UP');
    expect(c.creditPenalty).toBe(0);
    expect(c.tierRequiresApproval).toBe(false);
  });

  it('降价恰 10.0%（100→90）：边界恰档=PRICE_DOWN_LE10（delta×10==old 整数精确比较），信用 -15，需审批', () => {
    const c = classifyChange(10_000, 9_000, true);
    expect(c.direction).toBe('DOWN');
    expect(c.kind).toBe('PRICE_DOWN_LE10');
    expect(c.creditPenalty).toBe(-15);
    expect(c.tierRequiresApproval).toBe(true);
    expect(c.changePct).toBe('10.000');
  });

  it('降价恰差一分不过界（100→90.01）：仍 LE10', () => {
    expect(classifyChange(10_000, 9_001, true).kind).toBe('PRICE_DOWN_LE10');
  });

  it('降价恰差一分过界（100→89.99）：GT10（delta×10>old）', () => {
    const c = classifyChange(10_000, 8_999, true);
    expect(c.kind).toBe('PRICE_DOWN_GT10');
    expect(c.creditPenalty).toBe(-30);
    expect(c.tierRequiresApproval).toBe(true);
    expect(c.changePct).toBe('10.010');
  });

  it('降价 20%（100→80）：GT10，信用 -30，需审批', () => {
    expect(classifyChange(10_000, 8_000, true).changePct).toBe('20.000');
    expect(classifyChange(10_000, 8_000, true).kind).toBe('PRICE_DOWN_GT10');
  });

  it('降价且不在团：档位照归类、不需审批、信用 0（自由改价无惩罚）', () => {
    const c = classifyChange(10_000, 8_000, false);
    expect(c.kind).toBe('PRICE_DOWN_GT10');
    expect(c.creditPenalty).toBe(0);
    expect(c.tierRequiresApproval).toBe(false);
  });

  it('非十进整除降价（30→20，33.33%）：display changePct 三位小数向下取整（审计展示位；档位判定不走该列，走整数精确比较）', () => {
    const c = classifyChange(300, 200, true);
    expect(c.kind).toBe('PRICE_DOWN_GT10');
    expect(c.changePct).toBe('33.333');
  });

  it('新旧同价 → 显性拒绝（无价格变化不是改价）', () => {
    expect(() => classifyChange(10_000, 10_000, true)).toThrow();
  });

  it('旧价为 0/负 → 显性拒绝（change_pct 分母域保护）', () => {
    expect(() => classifyChange(0, 100, true)).toThrow();
    expect(() => classifyChange(-1, 100, true)).toThrow();
  });

  it('新价为负 → 显性拒绝', () => {
    expect(() => classifyChange(10_000, -1, true)).toThrow();
  });
});

describe('C6 引擎·computeCompensations（R-05 + D17 分母=paid_amount 全额）', () => {
  it('占比分母=Σ(cash+points/100) 全额：现金 50 元+积分 1000（=10 元）与现金 40 元两用户，(100-90)×占比 → 6 元/4 元=600/400 分', () => {
    const comps = computeCompensations(
      [
        { user_id: 601, paidCents: 5_000 + 1_000 }, // cash 50.00 + points 1000（100 积分=1 元 → 1000 分）
        { user_id: 602, paidCents: 4_000 },
      ],
      10_000,
      9_000,
    );
    expect(comps).toEqual([
      { user_id: 601, points: 600 },
      { user_id: 602, points: 400 },
    ]);
  });

  it('唯一受偿用户拿满 delta（1 积分=1 分）', () => {
    expect(computeCompensations([{ user_id: 601, paidCents: 5_000 }], 8_000, 7_000)).toEqual([
      { user_id: 601, points: 1_000 },
    ]);
  });

  it('向下取整纪律：零头不付出（Σ补偿 ≤ delta，平台不超付）；取整到 0 的用户不产生授予', () => {
    const comps = computeCompensations(
      [
        { user_id: 601, paidCents: 1 },
        { user_id: 602, paidCents: 9_999 },
      ],
      10_000,
      9_000, // delta=1000 分
    );
    expect(comps).toEqual([{ user_id: 602, points: 999 }]); // 601: floor(1000*1/10000)=0 → 不出授予
  });

  it('全额分母含积分享受占比：全积分支付用户与其他现金用户按全额同权分摊', () => {
    const comps = computeCompensations(
      [
        { user_id: 601, paidCents: 2_000 }, // 全积分：points 2000（=20 元）
        { user_id: 602, paidCents: 2_000 }, // 全现金 20.00
      ],
      5_000,
      4_500, // delta=500 分
    );
    expect(comps).toEqual([
      { user_id: 601, points: 250 },
      { user_id: 602, points: 250 },
    ]);
  });

  it('Σpaid=0（无有效支付）→ 空补偿（分母 0 保护，不出授予）', () => {
    expect(
      computeCompensations(
        [
          { user_id: 601, paidCents: 0 },
          { user_id: 602, paidCents: 0 },
        ],
        10_000,
        9_000,
      ),
    ).toEqual([]);
  });

  it('空受偿集 → 空补偿', () => {
    expect(computeCompensations([], 10_000, 9_000)).toEqual([]);
  });

  it('NUMERIC(10,2) 列宽极值：BigInt 精确除法不丢精度（delta≈1e10 分 × 占比）', () => {
    const big = 9_999_999_999;
    expect(computeCompensations([{ user_id: 601, paidCents: big }], big, big - 1)).toEqual([
      { user_id: 601, points: 1 },
    ]);
    expect(computeCompensations([{ user_id: 601, paidCents: big }], big, 0)).toEqual([
      { user_id: 601, points: big },
    ]);
  });
});
