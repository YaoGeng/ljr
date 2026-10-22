/**
 * 价格配置编辑态（M3-W2 T3，schedule-edit 同款纯函数件，bun test 直测）：
 * 服务端视图 ↔ 表单态互转、表单防呆校验（问题清单）、dirty 多重集判定（离开确认前提）、
 * 表单 → PUT/change 线形态草案构造。
 *
 * 值域镜像 core normalizePricingWrite（R-01 二选一/R-02 1对1 区间/smallint 成对护栏）；
 * 金额全程字符串形态（moneyToCents 整数分比较，无 parseFloat）。
 */
import {
  ONE_ON_ONE_CHANNEL_LABELS,
  ONE_ON_ONE_RANGES,
  PRICING_ROOM_MODES,
  moneyToCents,
  type CurrentPricingView,
  type PricingRoomMode,
  type PutPricingInput,
} from '../api/pricing';
import { isValidMoney } from '../api/money';

/** 表单态（字符串输入形态；人数/范围为空串=null 语义） */
export interface PricingFormState {
  priceMode: 'per_head' | 'session_total';
  perHead: string;
  sessionTotal: string;
  groupSize: string;
  acceptMin: string;
  acceptMax: string;
  roomModes: readonly PricingRoomMode[];
  /** 1对1 三通道（text=per_round；voice/video=per_15min） */
  oooText: string;
  oooVoice: string;
  oooVideo: string;
}

/** 服务端视图 → 表单态（null 列 → 空串；pricing=null → 全空表单，mode 缺省 per_head） */
export function pricingFormFromView(view: CurrentPricingView): PricingFormState {
  const p = view.pricing;
  if (p === null) {
    return {
      priceMode: 'per_head',
      perHead: '',
      sessionTotal: '',
      groupSize: '',
      acceptMin: '',
      acceptMax: '',
      roomModes: [],
      oooText: '',
      oooVoice: '',
      oooVideo: '',
    };
  }
  return {
    priceMode: p.per_head !== null ? 'per_head' : 'session_total',
    perHead: p.per_head ?? '',
    sessionTotal: p.session_total ?? '',
    groupSize: p.group_size === null ? '' : String(p.group_size),
    acceptMin: p.accept_min === null ? '' : String(p.accept_min),
    acceptMax: p.accept_max === null ? '' : String(p.accept_max),
    roomModes: p.room_modes === null ? [] : [...p.room_modes],
    oooText: p.one_on_one_prices.text.per_round,
    oooVoice: p.one_on_one_prices.voice.per_15min,
    oooVideo: p.one_on_one_prices.video.per_15min,
  };
}

const trim = (v: string): string => v.trim();

/** 1-32767 整数输入形态（空串=合法 null 语义；返回 null=合法缺省，false=非法） */
function parseIntInput(v: string): number | null | false {
  const t = trim(v);
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return false;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 32_767) return false;
  return n;
}

/**
 * 表单防呆（用户可见问题清单；空清单=可保存）——core normalizePricingWrite 值域镜像 +
 * 1对1 R-02 区间（边界 50/300、100/500 内收外拒）。最终提交前仍过 validatePricingDraft
 * （API 层单源，双闸同口径）。
 */
export function validatePricingForm(form: PricingFormState): readonly string[] {
  const issues: string[] = [];
  // R-01 活动侧金额（未选侧不提交、不校验）
  const active = form.priceMode === 'per_head' ? trim(form.perHead) : trim(form.sessionTotal);
  if (!isValidMoney(active)) {
    issues.push(
      form.priceMode === 'per_head'
        ? '默认人头价须为两位小数金额（如 99.00）'
        : '默认场次总价须为两位小数金额（如 650.00）',
    );
  }
  // R-02 1对1 三通道（形态 + 区间）
  const channels: ReadonlyArray<readonly [PricingRoomMode, string]> = [
    ['text', trim(form.oooText)],
    ['voice', trim(form.oooVoice)],
    ['video', trim(form.oooVideo)],
  ];
  for (const [channel, raw] of channels) {
    const label = ONE_ON_ONE_CHANNEL_LABELS[channel];
    const range = ONE_ON_ONE_RANGES[channel];
    if (!isValidMoney(raw)) {
      issues.push(`1对1 ${label} 价格须为两位小数金额（如 150.00）`);
      continue;
    }
    const cents = moneyToCents(raw);
    if (cents < range.minCents || cents > range.maxCents) {
      issues.push(`1对1 ${label} 价格须在 ${range.label} 内`);
    }
  }
  // 可空 smallint
  if (parseIntInput(form.groupSize) === false) {
    issues.push('开团人数须为 1-32767 整数（留空=不设默认）');
  }
  const acceptMin = parseIntInput(form.acceptMin);
  const acceptMax = parseIntInput(form.acceptMax);
  if (acceptMin === false || acceptMax === false) {
    issues.push('接受拼团范围须成对填写为 1-32767 整数（留空=不设范围）');
  } else if (
    (acceptMin === null) !== (acceptMax === null) ||
    (acceptMin !== null && acceptMax !== null && acceptMin > acceptMax)
  ) {
    issues.push('接受拼团范围须成对填写且下限不大于上限');
  }
  return issues;
}

/**
 * dirty 判定（离开确认前提）：表单态 vs 服务端视图逐键比较；room_modes 为多选集合
 * （顺序无关）；金额按 trim 后字符串精确比较（'99' vs '99.00' 视为已修改——正确：
 * 编辑过的中间态即未保存语义）。
 */
export function isDirtyPricing(form: PricingFormState, view: CurrentPricingView): boolean {
  const saved = pricingFormFromView(view);
  const key = (f: PricingFormState): string =>
    [
      f.priceMode,
      trim(f.perHead),
      trim(f.sessionTotal),
      trim(f.groupSize),
      trim(f.acceptMin),
      trim(f.acceptMax),
      [...f.roomModes].sort().join(','),
      trim(f.oooText),
      trim(f.oooVoice),
      trim(f.oooVideo),
    ].join('|');
  return key(form) !== key(saved);
}

/** 表单 → PUT /lawyer/pricing 与 POST /lawyer/pricing/change 共用线形态草案 */
export function pricingDraftFromForm(form: PricingFormState, baseVersion: number): PutPricingInput {
  const int = (v: string): number | null => {
    const t = trim(v);
    return t === '' ? null : Number(t);
  };
  return {
    base_version: baseVersion,
    per_head: form.priceMode === 'per_head' ? trim(form.perHead) : null,
    session_total: form.priceMode === 'session_total' ? trim(form.sessionTotal) : null,
    group_size: int(form.groupSize),
    accept_min: int(form.acceptMin),
    accept_max: int(form.acceptMax),
    room_modes: PRICING_ROOM_MODES.filter((m) => form.roomModes.includes(m)),
    one_on_one_prices: {
      text: { per_round: trim(form.oooText) },
      voice: { per_15min: trim(form.oooVoice) },
      video: { per_15min: trim(form.oooVideo) },
    },
  };
}
