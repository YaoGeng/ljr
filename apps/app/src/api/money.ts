/**
 * 金额展示单一出口（M3-W1 T1）：App 内一切金额渲染必须经本件，禁 parseFloat 裸算。
 *
 * 复用 @ljr/shared money 契约（NUMERIC(12,2) 字符串即 Money）；本件只做纯字符串
 * 千分位/拆段格式化（int 部分分组、dec 保持两位），不产生任何浮点运算。
 */
import { assertMoney, isValidMoney, type Money } from '@ljr/shared';

export { assertMoney, isValidMoney };
export type { Money };

/** 千分位分组（纯字符串正则，无数值化） */
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface MoneyFormatOptions {
  /** 带 ¥ 符号（默认 true） */
  symbol?: boolean;
  /** 千分位分组（默认 true） */
  group?: boolean;
}

/** '1234567.89' → '¥1,234,567.89'（格式化前先过 assertMoney 校验，非法即抛 AppError） */
export function formatMoney(value: Money, opts: MoneyFormatOptions = {}): string {
  const money = assertMoney(value);
  const withSymbol = opts.symbol ?? true;
  const withGroup = opts.group ?? true;
  const [intPart, decPart] = money.split('.');
  const int = withGroup ? groupThousands(intPart) : intPart;
  return `${withSymbol ? '¥' : ''}${int}.${decPart}`;
}

export interface MoneyParts {
  /** '¥'（symbol=false 时为 ''） */
  symbol: string;
  /** 整数段（可含千分位逗号） */
  int: string;
  /** 小数段（固定含前导点，如 '.89'；渲染方不再自行拼点） */
  decWithDot: string;
}

/**
 * 拆段输出：价格数字需红点缀色/大小字排版时用（symbol 大且淡、int 大、dec 小）。
 * decWithDot 固定含前导点（'.89'），渲染方不再自行拼接规则。
 */
export function splitMoney(value: Money, opts: MoneyFormatOptions = {}): MoneyParts {
  const money = assertMoney(value);
  const withSymbol = opts.symbol ?? true;
  const withGroup = opts.group ?? true;
  const [intPart, decPart] = money.split('.');
  return {
    symbol: withSymbol ? '¥' : '',
    int: withGroup ? groupThousands(intPart) : intPart,
    decWithDot: `.${decPart}`,
  };
}
