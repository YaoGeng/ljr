import { describe, expect, it } from 'vitest';
import { ErrorCode, isAppError } from '@ljr/shared';
import type { PutPricingInput } from './pricing.types';
import { moneyToCents, normalizePricingWrite } from './pricing.validate';

/**
 * B3 写入校验纯函数（R-01 二选一 / R-02 区间全矩阵 / Money 字符串纪律 / smallint 护栏）。
 * 全矩阵（§9）：文字 49/50/300/301，语音/视频 99/100/500/501（外拒内收）；
 * 金额一律字符串断言形态（number 即 422 E_MONEY_INVALID，禁 float）。
 */

const VALID_1V1 = {
  text: { per_round: '250.00' },
  voice: { per_15min: '200.00' },
  video: { per_15min: '300.00' },
};

const validInput = (over: Partial<PutPricingInput> = {}): PutPricingInput => ({
  base_version: 0,
  per_head: '80.00',
  group_size: 5,
  accept_min: 3,
  accept_max: 8,
  room_modes: ['text', 'voice'],
  one_on_one_prices: VALID_1V1,
  ...over,
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (isAppError(e)) return e.code;
    throw e;
  }
  return 'NO_THROW';
};

describe('B3 写入校验：R-01 计价模式二选一', () => {
  it('per_head 与 session_total 同给 → 400 E_INVALID_ARGUMENT；都不给 → 400', () => {
    expect(codeOf(() => normalizePricingWrite(validInput({ session_total: '1200.00' })))).toBe(
      ErrorCode.InvalidArgument,
    );
    expect(codeOf(() => normalizePricingWrite(validInput({ per_head: null })))).toBe(
      ErrorCode.InvalidArgument,
    );
  });

  it('单给 per_head / 单给 session_total → 通过且另一侧归一 null', () => {
    expect(normalizePricingWrite(validInput()).per_head).toBe('80.00');
    expect(normalizePricingWrite(validInput()).session_total).toBeNull();
    const totalOnly = normalizePricingWrite(
      validInput({ per_head: undefined, session_total: '1200.00' }),
    );
    expect(totalOnly.per_head).toBeNull();
    expect(totalOnly.session_total).toBe('1200.00');
  });
});

describe('B3 写入校验：R-02 1对1 区间全矩阵（文字 50-300/次；语音视频 100-500/15min）', () => {
  it.each([49, 301])('文字 per_round=%d → 400 E_OUT_OF_RANGE（外拒）', (v) => {
    expect(
      codeOf(() =>
        normalizePricingWrite(
          validInput({ one_on_one_prices: { ...VALID_1V1, text: { per_round: `${v}.00` } } }),
        ),
      ),
    ).toBe(ErrorCode.PriceOutOfRange);
  });

  it.each([50, 300])('文字 per_round=%d → 通过（内收，含边界）', (v) => {
    const out = normalizePricingWrite(
      validInput({ one_on_one_prices: { ...VALID_1V1, text: { per_round: `${v}.00` } } }),
    );
    expect(out.one_on_one_prices.text.per_round).toBe(`${v}.00`);
  });

  it.each([99, 501])('语音 per_15min=%d → 400 E_OUT_OF_RANGE', (v) => {
    expect(
      codeOf(() =>
        normalizePricingWrite(
          validInput({ one_on_one_prices: { ...VALID_1V1, voice: { per_15min: `${v}.00` } } }),
        ),
      ),
    ).toBe(ErrorCode.PriceOutOfRange);
  });

  it.each([100, 500])('语音 per_15min=%d → 通过（含边界）', (v) => {
    expect(
      normalizePricingWrite(
        validInput({ one_on_one_prices: { ...VALID_1V1, voice: { per_15min: `${v}.00` } } }),
      ).one_on_one_prices.voice.per_15min,
    ).toBe(`${v}.00`);
  });

  it.each([99, 501])('视频 per_15min=%d → 400 E_OUT_OF_RANGE', (v) => {
    expect(
      codeOf(() =>
        normalizePricingWrite(
          validInput({ one_on_one_prices: { ...VALID_1V1, video: { per_15min: `${v}.00` } } }),
        ),
      ),
    ).toBe(ErrorCode.PriceOutOfRange);
  });

  it.each([100, 500])('视频 per_15min=%d → 通过（含边界）', (v) => {
    expect(
      normalizePricingWrite(
        validInput({ one_on_one_prices: { ...VALID_1V1, video: { per_15min: `${v}.00` } } }),
      ).one_on_one_prices.video.per_15min,
    ).toBe(`${v}.00`);
  });
});

describe('B3 写入校验：Money 字符串纪律（禁 number/float）+ numeric(10,2) 列宽', () => {
  it.each([80, '80', '80.5', '80.001', '-80.00', '0080.00'])(
    'per_head=%j 非法金额形态 → 422 E_MONEY_INVALID（number 即拒）',
    (v) => {
      expect(codeOf(() => normalizePricingWrite(validInput({ per_head: v as never })))).toBe(
        ErrorCode.MoneyInvalidFormat,
      );
    },
  );

  it('1对1 金额非字符串（number）→ 422 E_MONEY_INVALID', () => {
    expect(
      codeOf(() =>
        normalizePricingWrite(
          validInput({ one_on_one_prices: { ...VALID_1V1, text: { per_round: 250 as never } } }),
        ),
      ),
    ).toBe(ErrorCode.MoneyInvalidFormat);
  });

  it('NUMERIC(10,2) 列宽：整数部分 9 位 → 400；8 位上限内通过', () => {
    expect(codeOf(() => normalizePricingWrite(validInput({ per_head: '999999999.99' })))).toBe(
      ErrorCode.InvalidArgument,
    );
    expect(normalizePricingWrite(validInput({ per_head: '99999999.99' })).per_head).toBe(
      '99999999.99',
    );
  });
});

describe('B3 写入校验：base_version 乐观锁令牌与 smallint 护栏', () => {
  it.each([-1, 1.5, '0', null])('base_version=%j → 400 E_INVALID_ARGUMENT', (v) => {
    expect(codeOf(() => normalizePricingWrite(validInput({ base_version: v as never })))).toBe(
      ErrorCode.InvalidArgument,
    );
  });

  it.each([0, 5, 12])('base_version=%d 非负整数 → 通过', (v) => {
    expect(normalizePricingWrite(validInput({ base_version: v })).base_version).toBe(v);
  });

  it.each([0, -1, 2.5, 32768])('group_size=%j（非正/非整/超 smallint）→ 400', (v) => {
    expect(codeOf(() => normalizePricingWrite(validInput({ group_size: v as never })))).toBe(
      ErrorCode.InvalidArgument,
    );
  });

  it('accept_min/accept_max 须成对：单边 → 400；min>max → 400；min=max → 通过', () => {
    expect(
      codeOf(() => normalizePricingWrite(validInput({ accept_min: 3, accept_max: null }))),
    ).toBe(ErrorCode.InvalidArgument);
    expect(
      codeOf(() => normalizePricingWrite(validInput({ accept_min: null, accept_max: 8 }))),
    ).toBe(ErrorCode.InvalidArgument);
    expect(codeOf(() => normalizePricingWrite(validInput({ accept_min: 9, accept_max: 8 })))).toBe(
      ErrorCode.InvalidArgument,
    );
    const eq = normalizePricingWrite(validInput({ accept_min: 5, accept_max: 5 }));
    expect([eq.accept_min, eq.accept_max]).toEqual([5, 5]);
  });

  it.each([0, -1, 2.5])('accept 边界值 %j 非正/非整 → 400', (v) => {
    expect(
      codeOf(() => normalizePricingWrite(validInput({ accept_min: v as never, accept_max: 8 }))),
    ).toBe(ErrorCode.InvalidArgument);
  });
});

describe('B3 写入校验：room_modes 多选形态', () => {
  it('重复值 / 越域值 / 非数组 → 400；三值全选通过（乱序保留）', () => {
    expect(codeOf(() => normalizePricingWrite(validInput({ room_modes: ['text', 'text'] })))).toBe(
      ErrorCode.InvalidArgument,
    );
    expect(codeOf(() => normalizePricingWrite(validInput({ room_modes: ['fax'] as never })))).toBe(
      ErrorCode.InvalidArgument,
    );
    expect(codeOf(() => normalizePricingWrite(validInput({ room_modes: 'text' as never })))).toBe(
      ErrorCode.InvalidArgument,
    );
    expect(
      normalizePricingWrite(validInput({ room_modes: ['video', 'text', 'voice'] })).room_modes,
    ).toEqual(['video', 'text', 'voice']);
  });

  it('缺省 / null / [] → 归一 null / null / []（[] = 未选择，DB 值域 CHECK 通行）', () => {
    expect(normalizePricingWrite(validInput({ room_modes: undefined })).room_modes).toBeNull();
    expect(normalizePricingWrite(validInput({ room_modes: null })).room_modes).toBeNull();
    expect(normalizePricingWrite(validInput({ room_modes: [] })).room_modes).toEqual([]);
  });
});

describe('B3 写入校验：one_on_one_prices 结构（三通道全量必填，简报裁决）', () => {
  it.each([
    ['缺 text', { voice: VALID_1V1.voice, video: VALID_1V1.video }],
    ['缺 voice', { text: VALID_1V1.text, video: VALID_1V1.video }],
    ['缺 video', { text: VALID_1V1.text, voice: VALID_1V1.voice }],
    ['text 缺 per_round', { text: {}, voice: VALID_1V1.voice, video: VALID_1V1.video }],
    ['整体非对象', '250.00'],
    ['整体 null', null],
  ])('%s → 400 E_INVALID_ARGUMENT', (_label, bad) => {
    expect(
      codeOf(() => normalizePricingWrite(validInput({ one_on_one_prices: bad as never }))),
    ).toBe(ErrorCode.InvalidArgument);
  });
});

describe('B3 moneyToCents：字符串精确换分（无 float 运算）', () => {
  it.each([
    ['0.01', 1],
    ['0.29', 29],
    ['99.99', 9999],
    ['300.00', 30000],
    ['99999999.99', 9999999999],
  ])('%s → %d 分', (v, expected) => {
    expect(moneyToCents(v)).toBe(expected);
  });
});
