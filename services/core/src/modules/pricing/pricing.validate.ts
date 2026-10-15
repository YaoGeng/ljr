/**
 * B3 写入校验纯函数（R-01/R-02 应用校验层 + 简报裁决护栏）：DB CHECK 之外的双层应用侧。
 *
 * 错误码口径：形态/结构非法 = InvalidArgument（400）；金额形态 = MoneyInvalidFormat（422，
 * assertMoney 全局契约——number 即拒，禁 float）；R-02 区间越界 = PriceOutOfRange（§5 400
 * OUT_OF_RANGE）。金额比较经 moneyToCents 整数精确换算（字符串拆位，无 parseFloat/float）。
 */
import { AppError, ErrorCode, assertMoney, type Money } from '@ljr/shared';
import {
  ONE_ON_ONE_RANGES,
  ROOM_MODES,
  type OneOnOnePrices,
  type PricingConfigView,
  type PutPricingInput,
  type RoomMode,
} from './pricing.types';

/** numeric(10,2) 列宽上限（分）：整数部分最多 8 位（Money 允许 10 位，列更窄——应用侧护栏防 22003 漏出） */
const MAX_NUMERIC_10_2_CENTS = 9_999_999_999;

/** smallint 列上限 */
const MAX_SMALLINT = 32_767;

/** 校验/归一后的全量写入（= 可直接落库与回显的 PricingConfigView + base_version 令牌） */
export type NormalizedPricingWrite = PricingConfigView & { readonly base_version: number };

/** Money 字符串 → 分（整数精确换算：assertMoney 保证 0-10 位整数 + 恰两位小数，拆位转 Number） */
export function moneyToCents(v: Money): number {
  assertMoney(v);
  const dot = v.indexOf('.');
  return Number(v.slice(0, dot)) * 100 + Number(v.slice(dot + 1));
}

function invalid(message: string): never {
  throw new AppError(ErrorCode.InvalidArgument, message);
}

function assertPositiveSmallint(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_SMALLINT) {
    invalid(`${name} 须为 1-${MAX_SMALLINT} 整数：${JSON.stringify(value)}`);
  }
  return value;
}

/** undefined/null → null；其余经 assertMoney（422）+ 列宽护栏（400） */
function normalizeMoneyColumn(value: unknown, name: string): Money | null {
  if (value === undefined || value === null) return null;
  const money = assertMoney(value as string); // 非字符串/形态非法 → 422 E_MONEY_INVALID
  if (moneyToCents(money) > MAX_NUMERIC_10_2_CENTS) {
    invalid(`${name} 超出 NUMERIC(10,2) 列宽（整数部分 ≤8 位）：${money}`);
  }
  return money;
}

/** R-02：单通道金额区间校验（区间常量=ONE_ON_ONE_RANGES，与迁移 CHECK 字面同源） */
function assertChannelMoney(channel: RoomMode, value: unknown): Money {
  const money = assertMoney(value as string);
  const range = ONE_ON_ONE_RANGES[channel];
  const cents = moneyToCents(money);
  if (cents < range.minCents || cents > range.maxCents) {
    throw new AppError(
      ErrorCode.PriceOutOfRange,
      `1对1 ${channel} 价格越界（${range.label}）：${money}`,
    );
  }
  return money;
}

function normalizeOneOnOne(raw: unknown): OneOnOnePrices {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid('one_on_one_prices 须为对象 {text, voice, video}（三通道全量必填）');
  }
  const obj = raw as Record<string, unknown>;
  const channel = (name: RoomMode): Record<string, unknown> => {
    const c = obj[name];
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      invalid(
        `one_on_one_prices.${name} 须为对象 {${ONE_ON_ONE_RANGES[name].field}}（三通道全量必填）`,
      );
    }
    return c as Record<string, unknown>;
  };
  const text = channel('text');
  const voice = channel('voice');
  const video = channel('video');
  if (text['per_round'] === undefined || text['per_round'] === null) {
    invalid('one_on_one_prices.text.per_round 必填（三通道全量必填）');
  }
  if (voice['per_15min'] === undefined || voice['per_15min'] === null) {
    invalid('one_on_one_prices.voice.per_15min 必填（三通道全量必填）');
  }
  if (video['per_15min'] === undefined || video['per_15min'] === null) {
    invalid('one_on_one_prices.video.per_15min 必填（三通道全量必填）');
  }
  return {
    text: { per_round: assertChannelMoney('text', text['per_round']) },
    voice: { per_15min: assertChannelMoney('voice', voice['per_15min']) },
    video: { per_15min: assertChannelMoney('video', video['per_15min']) },
  };
}

function normalizeRoomModes(raw: unknown): RoomMode[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw))
    invalid(`room_modes 须为数组（${ROOM_MODES.join('/')} 多选）：${JSON.stringify(raw)}`);
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !(ROOM_MODES as readonly string[]).includes(item)) {
      invalid(`room_modes 值越域（${ROOM_MODES.join('/')}）：${JSON.stringify(item)}`);
    }
    if (seen.has(item)) invalid(`room_modes 重复值：${item}`);
    seen.add(item);
  }
  return raw as RoomMode[];
}

/**
 * 全量写入校验：R-01 二选一、R-02 区间、Money 字符串、smallint/成对/去重护栏。
 * 通过即返回可直接落库与回显的归一形态（undefined/null 可空列归一 null）。
 */
export function normalizePricingWrite(input: PutPricingInput): NormalizedPricingWrite {
  if (
    typeof input?.base_version !== 'number' ||
    !Number.isInteger(input.base_version) ||
    input.base_version < 0
  ) {
    invalid(`base_version 须为非负整数（无任何版本=0）：${JSON.stringify(input?.base_version)}`);
  }
  const perHead = normalizeMoneyColumn(input.per_head, 'per_head');
  const sessionTotal = normalizeMoneyColumn(input.session_total, 'session_total');
  // R-01：二选一非空（DB ck_price_versions_pricing_mode 同字面）
  if ((perHead === null) === (sessionTotal === null)) {
    invalid('per_head 与 session_total 须二选一非空（R-01 计价模式：人头价或场次总价）');
  }
  const groupSize =
    input.group_size === undefined || input.group_size === null
      ? null
      : assertPositiveSmallint(input.group_size, 'group_size');
  const acceptMin =
    input.accept_min === undefined || input.accept_min === null
      ? null
      : assertPositiveSmallint(input.accept_min, 'accept_min');
  const acceptMax =
    input.accept_max === undefined || input.accept_max === null
      ? null
      : assertPositiveSmallint(input.accept_max, 'accept_max');
  if ((acceptMin === null) !== (acceptMax === null)) {
    invalid('accept_min 与 accept_max 须成对给出（接受拼团范围）');
  }
  if (acceptMin !== null && acceptMax !== null && acceptMin > acceptMax) {
    invalid(`accept_min 须 ≤ accept_max（接受拼团范围）：${acceptMin} > ${acceptMax}`);
  }
  return {
    base_version: input.base_version,
    per_head: perHead,
    session_total: sessionTotal,
    group_size: groupSize,
    accept_min: acceptMin,
    accept_max: acceptMax,
    room_modes: normalizeRoomModes(input.room_modes),
    one_on_one_prices: normalizeOneOnOne(input.one_on_one_prices),
  };
}
