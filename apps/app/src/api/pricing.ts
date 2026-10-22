/**
 * B3 默认价格与1对1配置 + C6 改价申请 API（M3-W2 T3，契约消费——core 实文为准）：
 *   GET  /lawyer/:id/pricing            → {version, created_at, pricing|null}
 *                                         （无任何版本={version:0, created_at:null, pricing:null}）
 *   PUT  /lawyer/pricing                → 全量新配置（Bearer+lawyer；幂等键=lawyer+base_version；
 *                                         409 E_CONFLICT=base_version 过期 / 409 E_IN_GROUP_CHANGE=R-04
 *                                         在团转 C6 / 400 E_OUT_OF_RANGE=R-02 区间）
 *   GET  /lawyer/:id/pricing/history    → 版本列表（新在前；公开读）
 *   POST /lawyer/pricing/change         → 改价申请（体 {new_version_draft}；出参
 *                                         {result: EFFECTED|PENDING_APPROVAL, history_id, new_version}）
 *   GET  /pricing/histories?lawyer_id=  → 改价记录列表（C6 §5；公开读）
 *   POST /pricing/change/:id/revoke     → 24h 撤销（Bearer+lawyer 本人；409 E_PAST_24H 超窗）
 *
 * 契约口径（B3 §3/§5 + C6 §5 + core pricing.types/price-change.types 逐字）：
 *   - 金额一律 Money 字符串（两位小数，禁 float）；区间比较经 moneyToCents 整数分换算
 *     （core pricing.validate 同款拆位实现，无 parseFloat）；
 *   - R-01 二选一：per_head/session_total 恰一非空；R-02 1对1 区间=文字 50-300 元/次、
 *     语音/视频 100-500 元/15min（DB CHECK 同字面）；
 *   - 可空列护栏镜像 core normalizePricingWrite：smallint 1-32767、accept 成对且 min≤max、
 *     room_modes 值域 text|voice|video 且禁重复；NUMERIC(10,2) 列宽=整数部分 ≤8 位。
 *
 * fail-visible：出参形状本层校验，非法即 CLIENT_BAD_RESPONSE；入参本地前置校验
 * （validatePricingDraft）不发坏请求（CLIENT_BAD_REQUEST）。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { isValidMoney, type Money } from './money';

/** 房间沟通形式值域（B3 §3 room_modes / C1 room_mode 同词汇 text|voice|video） */
export type PricingRoomMode = 'text' | 'voice' | 'video';

export const PRICING_ROOM_MODES: readonly PricingRoomMode[] = ['text', 'voice', 'video'];

/** 1对1 通道中文标（B3 §2 词汇：文字/语音/视频——非 session-copy 的「图文」档） */
export const ONE_ON_ONE_CHANNEL_LABELS: Readonly<Record<PricingRoomMode, string>> = {
  text: '文字',
  voice: '语音',
  video: '视频',
};

/** R-02 区间（core ONE_ON_ONE_RANGES 同值；Money 整数分比较） */
export const ONE_ON_ONE_RANGES = {
  text: { field: 'per_round', minCents: 5_000, maxCents: 30_000, label: '50-300 元/次' },
  voice: { field: 'per_15min', minCents: 10_000, maxCents: 50_000, label: '100-500 元/15min' },
  video: { field: 'per_15min', minCents: 10_000, maxCents: 50_000, label: '100-500 元/15min' },
} as const;

/** NUMERIC(10,2) 列宽上限（分）：整数部分 ≤8 位（core normalizePricingWrite 同护栏） */
export const PRICING_MONEY_MAX_CENTS = 9_999_999_999;

/** smallint 列上限（core MAX_SMALLINT 同值） */
export const PRICING_SMALLINT_MAX = 32_767;

/** 1对1 价格矩阵（§3 jsonb 结构；三通道全量必填——core 简报最小口径） */
export interface OneOnOnePrices {
  readonly text: { readonly per_round: Money };
  readonly voice: { readonly per_15min: Money };
  readonly video: { readonly per_15min: Money };
}

/** 单个版本的全量配置（core PricingConfigView 逐字段） */
export interface PricingConfigView {
  readonly per_head: Money | null;
  readonly session_total: Money | null;
  readonly group_size: number | null;
  readonly accept_min: number | null;
  readonly accept_max: number | null;
  readonly room_modes: readonly PricingRoomMode[] | null;
  readonly one_on_one_prices: OneOnOnePrices;
}

/** GET /lawyer/:id/pricing 出参（无任何版本=version 0 + pricing null——core 自定口径） */
export interface CurrentPricingView {
  readonly version: number;
  readonly created_at: string | null;
  readonly pricing: PricingConfigView | null;
}

/** GET /lawyer/:id/pricing/history 条目（新版本在前） */
export interface PricingVersionHistoryItem {
  readonly version: number;
  readonly created_at: string;
  readonly pricing: PricingConfigView;
}

/** PUT /lawyer/pricing 入参（§5「全量新配置」+ base_version 乐观锁令牌；wire=snake_case） */
export interface PutPricingInput {
  readonly base_version: number;
  readonly per_head?: Money | null;
  readonly session_total?: Money | null;
  readonly group_size?: number | null;
  readonly accept_min?: number | null;
  readonly accept_max?: number | null;
  readonly room_modes?: readonly PricingRoomMode[] | null;
  readonly one_on_one_prices: OneOnOnePrices;
}

// ---------------------------------------------------------------------------
// C6（price-change.types 实文）
// ---------------------------------------------------------------------------

/** 改价结果三态（C6 §5 {result: EFFECTED|PENDING_APPROVAL|REJECTED}；REJECTED 仅审批路径产生） */
export type PriceChangeResultState = 'EFFECTED' | 'PENDING_APPROVAL' | 'REJECTED';

/** POST /lawyer/pricing/change 出参（请求路径不返回 REJECTED） */
export interface PriceChangeRequestResult {
  readonly result: Exclude<PriceChangeResultState, 'REJECTED'>;
  readonly history_id: number;
  readonly new_version: number;
}

/** POST /pricing/change/:id/revoke 出参（restored_version=B3 恢复落版的新版本号） */
export interface RevokeResult {
  readonly history_id: number;
  readonly status: 'REVOKED';
  readonly restored_version: number;
}

/** GET /pricing/histories?lawyer_id= 条目（core PriceHistoryView 逐字段） */
export interface PriceHistoryView {
  readonly history_id: number;
  readonly lawyer_id: number;
  readonly old_version: number;
  readonly new_version: number;
  readonly direction: 'UP' | 'DOWN';
  /** numeric(6,3) 文本（审计展示位；|新-旧|/旧 分数） */
  readonly change_pct: string;
  readonly has_active_group: boolean;
  readonly result: PriceChangeResultState;
  readonly approval_id: number | null;
  readonly approval_source: 'MANUAL' | null;
  readonly credit_penalty: number;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

// ---------------------------------------------------------------------------
// 工具与校验
// ---------------------------------------------------------------------------

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `价格配置响应形状非法：${detail}`,
  });
}

function localReject(detail: string, copy = '请检查输入后重试'): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadRequest,
    copy,
    serverMessage: `价格配置入参非法：${detail}`,
  });
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** Money 字符串 → 整数分（core pricing.validate moneyToCents 同款拆位实现，无浮点） */
export function moneyToCents(v: Money): number {
  const dot = v.indexOf('.');
  return Number(v.slice(0, dot)) * 100 + Number(v.slice(dot + 1));
}

/** 分 → Money 字符串（两位小数；core centsToMoney 同口径，非负安全整数域） */
export function centsToMoney(cents: number): Money {
  const intPart = Math.floor(cents / 100);
  const decPart = cents % 100;
  return `${String(intPart)}.${String(decPart).padStart(2, '0')}`;
}

/** 可空 Money 列校验（形态 + NUMERIC(10,2) 列宽；core normalizeMoneyColumn 镜像） */
function normalizeMoneyColumn(value: unknown, name: string): Money | null {
  if (value === undefined || value === null) return null;
  if (!isValidMoney(value)) {
    throw localReject(`${name} 须为两位小数金额字符串（如 99.00）：${JSON.stringify(value)}`);
  }
  if (moneyToCents(value) > PRICING_MONEY_MAX_CENTS) {
    throw localReject(`${name} 超出 NUMERIC(10,2) 列宽（整数部分 ≤8 位）：${value}`);
  }
  return value;
}

/** R-02 单通道区间（core assertChannelMoney 镜像；区间外=本地拒绝） */
function assertChannelMoney(channel: PricingRoomMode, value: unknown): Money {
  if (!isValidMoney(value)) {
    throw localReject(
      `one_on_one_prices.${channel} 须为两位小数金额字符串：${JSON.stringify(value)}`,
    );
  }
  const range = ONE_ON_ONE_RANGES[channel];
  const cents = moneyToCents(value);
  if (cents < range.minCents || cents > range.maxCents) {
    throw localReject(
      `1对1 ${ONE_ON_ONE_CHANNEL_LABELS[channel]} 价格越界（${range.label}）：${value}`,
      `1对1 ${ONE_ON_ONE_CHANNEL_LABELS[channel]} 价格须在 ${range.label} 内`,
    );
  }
  return value;
}

/** 正 smallint（1-32767；core assertPositiveSmallint 镜像） */
function assertPositiveSmallint(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > PRICING_SMALLINT_MAX
  ) {
    throw localReject(`${name} 须为 1-${PRICING_SMALLINT_MAX} 整数：${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 全量草案本地前置校验（core normalizePricingWrite 镜像——R-01 二选一/R-02 区间/
 * 可空列成对护栏/room_modes 值域去重）；坏草案不发请求。
 */
export function validatePricingDraft(input: PutPricingInput): void {
  if (
    typeof input?.base_version !== 'number' ||
    !Number.isInteger(input.base_version) ||
    input.base_version < 0
  ) {
    throw localReject(
      `base_version 须为非负整数（无任何版本=0）：${JSON.stringify(input?.base_version)}`,
    );
  }
  const perHead = normalizeMoneyColumn(input.per_head, 'per_head');
  const sessionTotal = normalizeMoneyColumn(input.session_total, 'session_total');
  // R-01：二选一非空
  if ((perHead === null) === (sessionTotal === null)) {
    throw localReject(
      'per_head 与 session_total 须二选一非空（R-01 计价模式：人头价或场次总价）',
      '默认价格须在人头价 / 场次总价中恰好填一项（R-01 二选一）',
    );
  }
  if (input.group_size !== undefined && input.group_size !== null) {
    assertPositiveSmallint(input.group_size, 'group_size');
  }
  const acceptMin =
    input.accept_min === undefined || input.accept_min === null
      ? null
      : assertPositiveSmallint(input.accept_min, 'accept_min');
  const acceptMax =
    input.accept_max === undefined || input.accept_max === null
      ? null
      : assertPositiveSmallint(input.accept_max, 'accept_max');
  if ((acceptMin === null) !== (acceptMax === null)) {
    throw localReject(
      'accept_min 与 accept_max 须成对给出（接受拼团范围）',
      '接受拼团范围须成对填写',
    );
  }
  if (acceptMin !== null && acceptMax !== null && acceptMin > acceptMax) {
    throw localReject(
      `accept_min 须 ≤ accept_max（接受拼团范围）：${acceptMin} > ${acceptMax}`,
      '接受拼团范围下限须不大于上限',
    );
  }
  if (input.room_modes !== undefined && input.room_modes !== null) {
    if (!Array.isArray(input.room_modes)) {
      throw localReject(
        `room_modes 须为数组（text/voice/video 多选）：${JSON.stringify(input.room_modes)}`,
      );
    }
    const seen = new Set<string>();
    for (const item of input.room_modes) {
      if (typeof item !== 'string' || !(PRICING_ROOM_MODES as readonly string[]).includes(item)) {
        throw localReject(`room_modes 值越域（text/voice/video）：${JSON.stringify(item)}`);
      }
      if (seen.has(item)) throw localReject(`room_modes 重复值：${item}`);
      seen.add(item);
    }
  }
  const ooo = input.one_on_one_prices;
  if (typeof ooo !== 'object' || ooo === null) {
    throw localReject('one_on_one_prices 须为对象 {text, voice, video}（三通道全量必填）');
  }
  const o = ooo as unknown as Record<string, unknown>;
  const channel = (name: PricingRoomMode): Record<string, unknown> => {
    const c = o[name];
    if (typeof c !== 'object' || c === null) {
      throw localReject(`one_on_one_prices.${name} 须为对象（三通道全量必填）`);
    }
    return c as Record<string, unknown>;
  };
  const field = (name: PricingRoomMode): unknown => {
    const c = channel(name);
    const key = ONE_ON_ONE_RANGES[name].field;
    const v = c[key];
    if (v === undefined || v === null) {
      throw localReject(`one_on_one_prices.${name}.${key} 必填（三通道全量必填）`);
    }
    return v;
  };
  assertChannelMoney('text', field('text'));
  assertChannelMoney('voice', field('voice'));
  assertChannelMoney('video', field('video'));
}

// ---------------------------------------------------------------------------
// 出参形状校验（fail-visible）
// ---------------------------------------------------------------------------

function readMoney(r: Record<string, unknown>, key: string): Money | null {
  const v = r[key];
  if (v === null) return null;
  if (!isValidMoney(v)) throw badShape(`${key} 非两位小数金额字符串/null`);
  return v;
}

function readNullableInt(r: Record<string, unknown>, key: string): number | null {
  const v = r[key];
  if (v === null) return null;
  if (!isNonNegInt(v) || v === 0 || v > PRICING_SMALLINT_MAX) {
    throw badShape(`${key} 非 1-${PRICING_SMALLINT_MAX} 整数/null`);
  }
  return v;
}

function readRoomModes(v: unknown): PricingRoomMode[] | null {
  if (v === null) return null;
  if (!Array.isArray(v)) throw badShape('room_modes 非数组/null');
  return v.map((item): PricingRoomMode => {
    if (typeof item !== 'string' || !(PRICING_ROOM_MODES as readonly string[]).includes(item)) {
      throw badShape(`room_modes 值越域：${JSON.stringify(item)}`);
    }
    return item as PricingRoomMode;
  });
}

function parsePricingConfig(raw: unknown): PricingConfigView {
  if (typeof raw !== 'object' || raw === null) throw badShape('pricing 非对象');
  const r = raw as Record<string, unknown>;
  const ooo = r['one_on_one_prices'];
  if (typeof ooo !== 'object' || ooo === null) throw badShape('one_on_one_prices 非对象');
  const o = ooo as Record<string, unknown>;
  const readChannel = (name: PricingRoomMode): Record<string, unknown> => {
    const c = o[name];
    if (typeof c !== 'object' || c === null) throw badShape(`one_on_one_prices.${name} 非对象`);
    return c as Record<string, unknown>;
  };
  const text = readChannel('text');
  const voice = readChannel('voice');
  const video = readChannel('video');
  if (!isValidMoney(text['per_round'])) throw badShape('one_on_one_prices.text.per_round 非金额');
  if (!isValidMoney(voice['per_15min'])) throw badShape('one_on_one_prices.voice.per_15min 非金额');
  if (!isValidMoney(video['per_15min'])) throw badShape('one_on_one_prices.video.per_15min 非金额');
  return {
    per_head: readMoney(r, 'per_head'),
    session_total: readMoney(r, 'session_total'),
    group_size: readNullableInt(r, 'group_size'),
    accept_min: readNullableInt(r, 'accept_min'),
    accept_max: readNullableInt(r, 'accept_max'),
    room_modes: readRoomModes(r['room_modes']),
    one_on_one_prices: {
      text: { per_round: text['per_round'] as Money },
      voice: { per_15min: voice['per_15min'] as Money },
      video: { per_15min: video['per_15min'] as Money },
    },
  };
}

function parseCurrentView(raw: unknown): CurrentPricingView {
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (!isNonNegInt(r['version'])) throw badShape('version 非非负整数');
  const createdAt = r['created_at'];
  if (createdAt !== null && !isIsoString(createdAt)) throw badShape('created_at 非时刻/null');
  if (r['pricing'] === null) {
    return { version: r['version'], created_at: null, pricing: null };
  }
  return {
    version: r['version'],
    created_at: createdAt as string | null,
    pricing: parsePricingConfig(r['pricing']),
  };
}

// ---------------------------------------------------------------------------
// 端点封装
// ---------------------------------------------------------------------------

/** GET /lawyer/:id/pricing：当前版本读（公开面——用户端选律师要比价，无 Bearer） */
export async function fetchPricing(lawyerId: number): Promise<CurrentPricingView> {
  assertLawyerId(lawyerId);
  return parseCurrentView(await apiFetch<unknown>(`/lawyer/${lawyerId}/pricing`));
}

/** PUT /lawyer/pricing：全量新配置（本人；幂等键=lawyer+base_version——409=过期/在团转 C6） */
export async function putPricing(input: PutPricingInput): Promise<CurrentPricingView> {
  validatePricingDraft(input);
  return parseCurrentView(
    await apiFetch<unknown>('/lawyer/pricing', { method: 'PUT', auth: true, body: input }),
  );
}

/** GET /lawyer/:id/pricing/history：版本列表（公开面；新在前） */
export async function fetchPricingHistory(lawyerId: number): Promise<PricingVersionHistoryItem[]> {
  assertLawyerId(lawyerId);
  const raw = await apiFetch<unknown>(`/lawyer/${lawyerId}/pricing/history`);
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map((row): PricingVersionHistoryItem => {
    if (typeof row !== 'object' || row === null) throw badShape('版本行非对象');
    const r = row as Record<string, unknown>;
    if (!isNonNegInt(r['version']) || r['version'] === 0) throw badShape('version 非正整数');
    if (!isIsoString(r['created_at'])) throw badShape('created_at 非时刻');
    return {
      version: r['version'],
      created_at: r['created_at'],
      pricing: parsePricingConfig(r['pricing']),
    };
  });
}

/** POST /lawyer/pricing/change：改价申请（C6 引擎判定；草案校验复用 B3 镜像） */
export async function requestPriceChange(
  draft: PutPricingInput,
): Promise<PriceChangeRequestResult> {
  validatePricingDraft(draft);
  const raw = await apiFetch<unknown>('/lawyer/pricing/change', {
    method: 'POST',
    auth: true,
    body: { new_version_draft: draft },
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (r['result'] !== 'EFFECTED' && r['result'] !== 'PENDING_APPROVAL') {
    throw badShape(`result 越二值域（请求路径无 REJECTED）：${JSON.stringify(r['result'])}`);
  }
  if (!isNonNegInt(r['history_id']) || r['history_id'] === 0) throw badShape('history_id 非正整数');
  if (!isNonNegInt(r['new_version']) || r['new_version'] === 0)
    throw badShape('new_version 非正整数');
  return {
    result: r['result'],
    history_id: r['history_id'],
    new_version: r['new_version'],
  };
}

/** GET /pricing/histories?lawyer_id=：改价记录列表（新在前=id DESC；公开读） */
export async function fetchPriceHistories(lawyerId: number): Promise<PriceHistoryView[]> {
  assertLawyerId(lawyerId);
  const raw = await apiFetch<unknown>(`/pricing/histories?lawyer_id=${lawyerId}`);
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map((row): PriceHistoryView => {
    if (typeof row !== 'object' || row === null) throw badShape('改价记录行非对象');
    const r = row as Record<string, unknown>;
    if (!isNonNegInt(r['history_id']) || r['history_id'] === 0)
      throw badShape('history_id 非正整数');
    if (!isNonNegInt(r['lawyer_id']) || r['lawyer_id'] === 0) throw badShape('lawyer_id 非正整数');
    if (!isNonNegInt(r['old_version'])) throw badShape('old_version 非非负整数');
    if (!isNonNegInt(r['new_version'])) throw badShape('new_version 非非负整数');
    if (r['direction'] !== 'UP' && r['direction'] !== 'DOWN') throw badShape('direction 越二值域');
    if (typeof r['change_pct'] !== 'string' || !/^\d+(\.\d+)?$/.test(r['change_pct'])) {
      throw badShape('change_pct 非十进制文本');
    }
    if (typeof r['has_active_group'] !== 'boolean') throw badShape('has_active_group 非布尔');
    if (
      r['result'] !== 'EFFECTED' &&
      r['result'] !== 'PENDING_APPROVAL' &&
      r['result'] !== 'REJECTED'
    ) {
      throw badShape('result 越三值域');
    }
    const approvalId = r['approval_id'];
    if (approvalId !== null && !(isNonNegInt(approvalId) && approvalId !== 0)) {
      throw badShape('approval_id 非 null/正整数');
    }
    if (r['approval_source'] !== null && r['approval_source'] !== 'MANUAL') {
      throw badShape('approval_source 越 null/MANUAL 值域');
    }
    // credit_penalty=有符号 smallint（真库实证：UP 档 -5——负值=扣分口径，0=无信用影响）
    if (
      typeof r['credit_penalty'] !== 'number' ||
      !Number.isInteger(r['credit_penalty']) ||
      Math.abs(r['credit_penalty']) > 32_767
    ) {
      throw badShape('credit_penalty 非有符号整数');
    }
    if (!isIsoString(r['created_at'])) throw badShape('created_at 非时刻');
    const revokedAt = r['revoked_at'];
    if (revokedAt !== null && !isIsoString(revokedAt)) throw badShape('revoked_at 非时刻/null');
    return {
      history_id: r['history_id'],
      lawyer_id: r['lawyer_id'],
      old_version: r['old_version'],
      new_version: r['new_version'],
      direction: r['direction'],
      change_pct: r['change_pct'],
      has_active_group: r['has_active_group'],
      result: r['result'],
      approval_id: approvalId,
      approval_source: r['approval_source'] as 'MANUAL' | null,
      credit_penalty: r['credit_penalty'],
      created_at: r['created_at'],
      revoked_at: revokedAt,
    };
  });
}

/** POST /pricing/change/:id/revoke：24h 撤销（律师本人；R-04 不扣信用） */
export async function revokePriceChange(historyId: number): Promise<RevokeResult> {
  if (!Number.isInteger(historyId) || historyId <= 0 || !Number.isSafeInteger(historyId)) {
    throw localReject(`history id 非正整数：${String(historyId)}`);
  }
  const raw = await apiFetch<unknown>(`/pricing/change/${historyId}/revoke`, {
    method: 'POST',
    auth: true,
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (r['status'] !== 'REVOKED')
    throw badShape(`status 非 REVOKED：${JSON.stringify(r['status'])}`);
  if (!isNonNegInt(r['history_id']) || r['history_id'] === 0) throw badShape('history_id 非正整数');
  if (!isNonNegInt(r['restored_version']) || r['restored_version'] === 0) {
    throw badShape('restored_version 非正整数');
  }
  return {
    history_id: r['history_id'],
    status: 'REVOKED',
    restored_version: r['restored_version'],
  };
}

function assertLawyerId(lawyerId: number): void {
  if (!Number.isInteger(lawyerId) || lawyerId <= 0 || !Number.isSafeInteger(lawyerId)) {
    throw localReject(`lawyerId 非正整数：${String(lawyerId)}`);
  }
}
