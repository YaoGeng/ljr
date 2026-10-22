/**
 * 律师端状态文案映射表（M3-W2 T2）：时段状态/结算状态/结算对象类型/周几/AI 健康
 * → 用户可读文案，单一事实源（纪律：状态文案映射表禁散写三元；视图层一律经本件取文案）。
 *
 * - 状态集=core 实文：B1 状态视图四态（FREE + slot_locks 活跃三态）、F3 settlement.machine
 *   五态、SettlementRefType 二值、weekday 0=周日..6=周六（core normalizeTemplate 口径）、
 *   E1 AgentHealth status 二值；
 * - 未知值回退显示原码（fail-visible：core 新增枚举先行时前端不吞错不撒谎）；
 * - slot tone=周视图配色档单源（free 绿/open 锁定红点缀/busy 占用实绿/idle 中性）。
 */
export type SlotStatusTone = 'free' | 'lock' | 'busy' | 'idle';

export interface SlotStatusCopy {
  readonly label: string;
  readonly tone: SlotStatusTone;
}

const SLOT_STATUS_COPY: Readonly<Record<string, SlotStatusCopy>> = {
  FREE: { label: '空闲', tone: 'free' },
  PENDING_PAYMENT: { label: '待支付锁定', tone: 'lock' },
  LOCKED: { label: '已锁定', tone: 'lock' },
  OCCUPIED: { label: '已占用', tone: 'busy' },
};

/** 时段状态文案（B1 §2 状态视图词汇：空闲/已锁定/已占用 + PENDING_PAYMENT 活跃锁态） */
export function slotStatusCopy(status: string): SlotStatusCopy {
  return SLOT_STATUS_COPY[status] ?? { label: status, tone: 'idle' };
}

// ---------------------------------------------------------------------------
// F3 结算（settlement.machine 五态；语义见 docs/modules/F-资金/F3 §4）
// ---------------------------------------------------------------------------

const SETTLEMENT_STATUS_COPY: Readonly<Record<string, string>> = {
  PENDING: '待结算',
  HOLD: '结算冻结中', // 24h 冻结期/未闭工单（R-02）
  READY: '待分账', // 唯一解冻分账节点前（R-01）
  SETTLED: '已结算',
  SUSPENDED: '分账已暂停', // 进件非 ACTIVE（R-07）
};

export function settlementStatusCopy(status: string): string {
  return SETTLEMENT_STATUS_COPY[status] ?? status;
}

export const SETTLEMENT_REF_TYPE_COPY: Readonly<Record<string, string>> = {
  session: '场次',
  one_on_one: '1对1',
};

export function settlementRefTypeCopy(refType: string): string {
  return SETTLEMENT_REF_TYPE_COPY[refType] ?? refType;
}

// ---------------------------------------------------------------------------
// B1 模板 weekday（0=周日..6=周六——core normalizeTemplate 错误文案同口径）
// ---------------------------------------------------------------------------

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function weekdayCopy(weekday: number): string {
  return WEEKDAYS[weekday] ?? `周${weekday}`;
}

// ---------------------------------------------------------------------------
// E1 AI 辅助健康（degraded=显式「AI 辅助不可用」——E1 §2 降级显式态常驻可见位）
// ---------------------------------------------------------------------------

export function agentHealthCopy(status: string): string {
  if (status === 'ok') return 'AI 辅助正常';
  if (status === 'degraded') return 'AI 辅助不可用';
  return status;
}

// ---------------------------------------------------------------------------
// C6 改价记录（M3-W2 T3：price-change.types result 三态 + direction 二值；
// revoked_at 由视图层另行判空徽标，不占 result 词位）
// ---------------------------------------------------------------------------

export type PriceChangeTone = 'open' | 'grouped' | 'finished' | 'failed';

export interface PriceChangeStatusCopy {
  readonly label: string;
  readonly tone: PriceChangeTone;
}

const PRICE_CHANGE_RESULT_COPY: Readonly<Record<string, PriceChangeStatusCopy>> = {
  EFFECTED: { label: '已生效', tone: 'grouped' },
  PENDING_APPROVAL: { label: '待平台审批', tone: 'open' },
  REJECTED: { label: '已否决', tone: 'failed' },
};

/** 改价结果三态徽标（未知值回退原码+中性档——fail-visible 不吞不编） */
export function priceChangeResultCopy(result: string): PriceChangeStatusCopy {
  return PRICE_CHANGE_RESULT_COPY[result] ?? { label: result, tone: 'finished' };
}

const PRICE_CHANGE_DIRECTION_COPY: Readonly<Record<string, string>> = {
  UP: '涨价',
  DOWN: '降价',
};

/** 改价方向二值（UP=涨价/DOWN=降价；未知回退原码） */
export function priceChangeDirectionCopy(direction: string): string {
  return PRICE_CHANGE_DIRECTION_COPY[direction] ?? direction;
}
