import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@ljr/shared';
import {
  centsToMoney,
  composeSplits,
  dbNumericToCents,
  moneyToCents,
  platformFeeCents,
  rateToBasisPoints,
  splitAbsence7030,
} from './settlement.types';

/**
 * F3 分账构成纯函数全边界单测（§2/R-03/R-06/R-05 + D20 ⚠W3 + 简报取整二择）：
 * 整化全在「分」，乘法 BigInt 防 2^53；R-05 违约金不进 platform_fee 用例钉住。
 */

describe('分 ↔ Money 整化（禁 float，payment.types 同形）', () => {
  it('moneyToCents/centsToMoney 严格两位小数往返', () => {
    expect(moneyToCents('100.00')).toBe(10_000);
    expect(moneyToCents('0.01')).toBe(1);
    expect(moneyToCents('9999999999.99')).toBe(999_999_999_999);
    expect(centsToMoney(10_000)).toBe('100.00');
    expect(centsToMoney(1)).toBe('0.01');
    expect(centsToMoney(0)).toBe('0.00');
  });

  it('非法形态/越界显性抛（MoneyInvalidFormat 422 / 越界 400）', () => {
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        return (e as { code?: string }).code ?? '<none>';
      }
      return '<no-throw>';
    };
    expect(codeOf(() => moneyToCents('100'))).toBe(ErrorCode.MoneyInvalidFormat);
    expect(() => moneyToCents('100.0')).toThrowError();
    expect(() => moneyToCents('-1.00')).toThrowError();
    expect(() => moneyToCents(100 as unknown as string)).toThrowError();
    expect(() => centsToMoney(-1)).toThrowError();
    expect(() => moneyToCents('10000000000.00')).toThrowError(); // NUMERIC(12,2) 上限外
  });

  it('dbNumericToCents 容忍聚合非两位形态（sum/COALESCE 可产 0/40.5）', () => {
    expect(dbNumericToCents('0')).toBe(0);
    expect(dbNumericToCents('40.5')).toBe(4_050);
    expect(dbNumericToCents('40.55')).toBe(4_055);
    expect(dbNumericToCents('100.00')).toBe(10_000);
    expect(() => dbNumericToCents('abc')).toThrowError();
    expect(() => dbNumericToCents('-1.00')).toThrowError();
  });
});

describe('费率与费用（R-06 版本化；floor 语义）', () => {
  it('rateToBasisPoints：numeric(5,4) 文本 → 基点整数；形态/越界显性抛', () => {
    expect(rateToBasisPoints('0.0000')).toBe(0);
    expect(rateToBasisPoints('0.0500')).toBe(500);
    expect(rateToBasisPoints('0.1000')).toBe(1_000);
    expect(rateToBasisPoints('1.0000')).toBe(10_000);
    expect(() => rateToBasisPoints('0.05')).toThrowError(); // 非四位小数形态
    expect(() => rateToBasisPoints('2.0000')).toThrowError(); // ck 0..1 之外
    expect(() => rateToBasisPoints('-0.0500')).toThrowError();
  });

  it('platformFeeCents：floor(gross×rate)；0% 恒 0（D20 W3 默认）', () => {
    expect(platformFeeCents(10_000, '0.0000')).toBe(0);
    expect(platformFeeCents(10_000, '0.0500')).toBe(500);
    expect(platformFeeCents(3_333, '0.0500')).toBe(166); // 166.65 → floor
    expect(platformFeeCents(1, '0.0500')).toBe(0); // 0.05 分 → floor 0
    expect(platformFeeCents(999_999_999_999, '0.1000')).toBe(99_999_999_999); // BigInt 域防 2^53
  });
});

describe('R-03 缺席 70/30 取整（律师 70% 向下取整、尾差整份额归平台备付侧）', () => {
  it.each([
    [0, 0, 0],
    [1, 0, 1], // 0.7 分 → floor 0，尾差 1 分归备付
    [2, 1, 1], // 1.4 → 1
    [3, 2, 1], // 2.1 → 2
    [10, 7, 3],
    [100, 70, 30],
    [3_333, 2_333, 1_000], // 2333.1 → 2333
  ])('distributable=%i 分 → firm=%i + reserve=%i（和恒等）', (d, firm, reserve) => {
    expect(splitAbsence7030(d)).toEqual({ firm_cents: firm, reserve_cents: reserve });
  });

  it('极大值 BigInt 域不溢出；firm+reserve===distributable 恒等', () => {
    const d = 999_999_999_999;
    const r = splitAbsence7030(d);
    expect(r.firm_cents + r.reserve_cents).toBe(d);
    expect(r.firm_cents).toBe(699_999_999_999); // floor(0.7×999999999999)
    expect(() => splitAbsence7030(-1)).toThrowError();
  });
});

describe('composeSplits 分账构成（§2；Σsplits=net 恒等式；R-05 违约金不抽佣钉住）', () => {
  it('FULL_TO_LAWYER + 0% 费率（D20 W3 默认）：律师全额，splits 单项', () => {
    const r = composeSplits({
      firm_id: 31,
      gross_cents: 10_000,
      penalty_cents: 0,
      platform_fee_cents: 0,
      share_mode: 'FULL_TO_LAWYER',
    });
    expect(r).toMatchObject({ fee_cents: 0, net_cents: 10_000, firm_share_cents: 10_000, reserve_share_cents: 0 });
    expect(r.splits).toEqual([{ payee_type: 'lawyer_firm', payee_id: 31, amount: '100.00' }]);
  });

  it('ABSENCE_7030：律师 70% floor + 30% 备付单项（Σsplits=net）', () => {
    const r = composeSplits({
      firm_id: 31,
      gross_cents: 10_000,
      penalty_cents: 0,
      platform_fee_cents: 0,
      share_mode: 'ABSENCE_7030',
    });
    expect(r.firm_share_cents).toBe(7_000);
    expect(r.reserve_share_cents).toBe(3_000);
    expect(r.splits).toEqual([
      { payee_type: 'lawyer_firm', payee_id: 31, amount: '70.00' },
      { payee_type: 'platform', payee_id: 0, amount: '30.00' },
    ]);
  });

  it('R-05 硬规则：违约金不进 platform_fee——费用恒按 gross 计，penalty 只减律师净额', () => {
    const noPenalty = composeSplits({
      firm_id: 31,
      gross_cents: 10_000,
      penalty_cents: 0,
      platform_fee_cents: 500,
      share_mode: 'FULL_TO_LAWYER',
    });
    const withPenalty = composeSplits({
      firm_id: 31,
      gross_cents: 10_000,
      penalty_cents: 2_000,
      platform_fee_cents: 500,
      share_mode: 'FULL_TO_LAWYER',
    });
    expect(noPenalty.fee_cents).toBe(500); // 建行固化值注入（R-06 计算由 platformFeeCents 专测钉住）
    expect(withPenalty.fee_cents).toBe(500); // 不因 penalty 变 400（gross 基数，平台不抽违约金）
    expect(withPenalty.net_cents).toBe(8_000); // 分账净额=gross−penalty=80
    expect(withPenalty.firm_share_cents).toBe(7_500); // 律师份额在扣费后净额上（80−5）
    // 构成校验恒等式（简报口径）：Σsplits = net = gross − penalty（fee 为 splits 构成项）
    const sum = withPenalty.splits.reduce((s, it) => s + moneyToCents(it.amount), 0);
    expect(sum).toBe(withPenalty.net_cents);
    expect(sum).toBe(10_000 - 2_000);
  });

  it('费率+缺席叠加：fee=floor(gross×rate)、firm=floor(扣费净额×0.7)、尾差归备付；Σsplits=net', () => {
    const r = composeSplits({
      firm_id: 31,
      gross_cents: 3_333,
      penalty_cents: 0,
      platform_fee_cents: 166,
      share_mode: 'ABSENCE_7030',
    });
    expect(r.fee_cents).toBe(166); // 建行固化（platformFeeCents(3333, 0.0500)=166 已专测）
    expect(r.net_cents).toBe(3_333); // gross−penalty
    expect(r.firm_share_cents).toBe(2_216); // floor((3333−166)×0.7)=floor(2216.9)
    expect(r.reserve_share_cents).toBe(951);
    const sum = r.splits.reduce((s, it) => s + moneyToCents(it.amount), 0);
    expect(sum).toBe(r.net_cents);
    expect(r.splits.map((s) => s.payee_type)).toEqual(['lawyer_firm', 'platform', 'platform']);
  });

  it('零可分净额（penalty 吃满）：splits 空数组（服务层跳过 /pay/split 指令面）', () => {
    const r = composeSplits({
      firm_id: 31,
      gross_cents: 5_000,
      penalty_cents: 5_000,
      platform_fee_cents: 0,
      share_mode: 'FULL_TO_LAWYER',
    });
    expect(r.net_cents).toBe(0);
    expect(r.splits).toEqual([]);
  });

  it('入参防御：负值/penalty>gross/费超过净额显性抛（内部不变量失守即硬错误）', () => {
    expect(() =>
      composeSplits({ firm_id: 31, gross_cents: -1, penalty_cents: 0, platform_fee_cents: 0, share_mode: 'FULL_TO_LAWYER' }),
    ).toThrowError();
    expect(() =>
      composeSplits({ firm_id: 31, gross_cents: 100, penalty_cents: 200, platform_fee_cents: 0, share_mode: 'FULL_TO_LAWYER' }),
    ).toThrowError(/扣减顺序守恒失守/);
    expect(() =>
      composeSplits({ firm_id: 31, gross_cents: 100, penalty_cents: 0, platform_fee_cents: 500, share_mode: 'FULL_TO_LAWYER' }),
    ).toThrowError(/行内构成不变量失守/);
    expect(() =>
      composeSplits({ firm_id: 31, gross_cents: 100, penalty_cents: 0, platform_fee_cents: 0, share_mode: 'FULL_TO_LAWYER' }),
    ).not.toThrowError();
    // centsToMoney 出口恒两位小数（Money 契约）
    expect(centsToMoney(composeSplits({ firm_id: 1, gross_cents: 1, penalty_cents: 0, platform_fee_cents: 0, share_mode: 'FULL_TO_LAWYER' }).net_cents)).toBe('0.01');
  });
});
