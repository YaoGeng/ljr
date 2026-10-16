import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@ljr/shared';
import { moneyToCents, seatPriceFor, type SeatPriceSession } from './session.types';

/**
 * C1 席位价纯函数（R-W3-I，无需 PG）：session_total 模式=半分向上分摊、末位（seatNo=capacity）
 * 收尾差保证 Σ 恰等于 total（少收方向锚=半分案例）；per_head 模式恒 unit_price。
 * Money 字符串域全程整数分，禁 float。
 */

const s = (over: Partial<SeatPriceSession> = {}): SeatPriceSession => ({
  price_mode: 'session_total',
  unit_price: '33.33',
  session_total: '100.00',
  capacity: 3,
  ...over,
});

/** Σ(1..capacity) 恰等于 session_total 的不变量断言（整数分域） */
const assertSumInvariant = (session: SeatPriceSession): void => {
  const total = moneyToCents(session.session_total);
  let sum = 0;
  for (let seatNo = 1; seatNo <= session.capacity; seatNo += 1) {
    sum += moneyToCents(seatPriceFor(session, seatNo));
  }
  expect(sum).toBe(total);
};

describe('C1 席位价 seatPriceFor（R-W3-I，纯函数）', () => {
  it('session_total 模式·整除：分摊恒等、末位=分摊、Σ=total（90.00÷3）', () => {
    const session = s({ session_total: '90.00', unit_price: '30.00', capacity: 3 });
    expect(seatPriceFor(session, 1)).toBe('30.00');
    expect(seatPriceFor(session, 2)).toBe('30.00');
    expect(seatPriceFor(session, 3)).toBe('30.00'); // 末位=分摊（无尾差）
    assertSumInvariant(session);
  });

  it('session_total 模式·尾差 1-7 分归集末位（半分向上分摊），Σ 恒等 total', () => {
    // 尾差 +1 分：100.00÷3 → 分摊 33.33（3333，亚半向下）→ 末位 33.34（多收 1 分归集）
    const up1 = s({ session_total: '100.00', unit_price: '33.33', capacity: 3 });
    expect(seatPriceFor(up1, 1)).toBe('33.33');
    expect(seatPriceFor(up1, 2)).toBe('33.33');
    expect(seatPriceFor(up1, 3)).toBe('33.34');
    assertSumInvariant(up1);
    // 半分恰半（少收方向锚）：1.00÷8 → 分摊 0.13（12.5→13 半分向上）→ 末位 0.09（少收 4 分归集）
    const half = s({ session_total: '1.00', unit_price: '0.13', capacity: 8 });
    expect(seatPriceFor(half, 1)).toBe('0.13');
    expect(seatPriceFor(half, 7)).toBe('0.13');
    expect(seatPriceFor(half, 8)).toBe('0.09');
    assertSumInvariant(half);
    // 尾差 1 分（恰半）：0.03÷2 → 分摊 0.02 → 末位 0.01
    const odd = s({ session_total: '0.03', unit_price: '0.02', capacity: 2 });
    expect(seatPriceFor(odd, 1)).toBe('0.02');
    expect(seatPriceFor(odd, 2)).toBe('0.01');
    assertSumInvariant(odd);
    // 尾差 1 分：10.01÷4 → 分摊 2.50 → 末位 2.51（尾差归集）
    const q4 = s({ session_total: '10.01', unit_price: '2.50', capacity: 4 });
    expect(seatPriceFor(q4, 1)).toBe('2.50');
    expect(seatPriceFor(q4, 4)).toBe('2.51'); // 10.01−2.50×3=2.51
    assertSumInvariant(q4);
  });

  it('session_total 模式·末位公式：seatNo=capacity → session_total−(capacity−1)×分摊（少收方向锚=半分案例）', () => {
    // 显式钉公式：total=100.01、cap=4、分摊=round(10001/4)=2500（2500.25 亚半向下）→ 末位=10001−7500=2501
    const session = s({ session_total: '100.01', unit_price: '25.00', capacity: 4 });
    expect(seatPriceFor(session, 4)).toBe('25.01');
    assertSumInvariant(session);
  });

  it('per_head 模式：恒 unit_price（首/中/末位同值，不参与分摊）', () => {
    const session = s({
      price_mode: 'per_head',
      unit_price: '66.00',
      session_total: '330.00',
      capacity: 5,
    });
    for (const seatNo of [1, 3, 5]) {
      expect(seatPriceFor(session, seatNo)).toBe('66.00');
    }
  });

  it('边界拒绝：seatNo 0 / 越 capacity / 非整数 → 400 E_INVALID_ARGUMENT', () => {
    const session = s();
    for (const bad of [0, -1, 4, 2.5]) {
      expect(() => seatPriceFor(session, bad)).toThrow(AppError);
      try {
        seatPriceFor(session, bad);
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.InvalidArgument);
      }
    }
  });
});
