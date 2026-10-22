/**
 * 场次枚举文案映射表（M3-W1 T2）：状态/计价/沟通形式/专项 → 用户可读文案，单一事实源
 * （纪律：状态文案映射表禁散写三元；视图层一律经本件取文案）。
 *
 * - 状态集=C1 状态机十态（core session.machine 逐字；语义见 docs/modules/C-交易/C1 §4）；
 * - 未知值回退显示原码（fail-visible：core 新增枚举先行时前端不吞错不撒谎）；
 * - tone=徽标色调档（组件层映射颜色）：open 报名中（绿）/ grouped 已成团（绿重）/
 *   live 进行链（红点缀·焦点态）/ finished 终态（灰）/ failed 失败链（红·危险态）。
 */
import type { SessionStatus, SessionView } from './sessions';

export type SessionStatusTone = 'open' | 'grouped' | 'live' | 'finished' | 'failed';

export interface SessionStatusCopy {
  readonly label: string;
  readonly tone: SessionStatusTone;
}

export const SESSION_STATUS_COPY: Readonly<Record<SessionStatus, SessionStatusCopy>> = {
  CREATED: { label: '报名中', tone: 'open' },
  FULL: { label: '已成团 · 锁人', tone: 'grouped' },
  CONFIRMED: { label: '已成团 · 已确认', tone: 'grouped' },
  OPEN: { label: '已开房 · 待开场', tone: 'live' },
  IN_SERVICE: { label: '进行中', tone: 'live' },
  FINISHED: { label: '已结束', tone: 'finished' },
  HOLD: { label: '结算处理中', tone: 'finished' },
  SETTLED: { label: '已结算', tone: 'finished' },
  FAILED: { label: '已流标 · 退款', tone: 'failed' },
  CANCELLED: { label: '已取消', tone: 'failed' },
};

/** 状态文案（未知值回退原码 + finished 档，不吞不编） */
export function sessionStatusCopy(status: string): SessionStatusCopy {
  return SESSION_STATUS_COPY[status as SessionStatus] ?? { label: status, tone: 'finished' };
}

// ---------------------------------------------------------------------------
// 报名关闭说明（评审 I2：非报名中态按状态链分组——FAILED/CANCELLED 不得落入
// 「满员成团」句式；单源出，视图禁散写三元）
// ---------------------------------------------------------------------------

/** 成团链共句（FULL/CONFIRMED/OPEN/IN_SERVICE） */
const GROUPED_CLOSED_NOTE = '——满员成团后不再接受新报名。';

const CLOSED_NOTE: Readonly<Record<SessionStatus, string>> = {
  CREATED: '', // 报名中无关闭说明（详情页走截止/流标提示句）
  FULL: `已成团 · 锁人${GROUPED_CLOSED_NOTE}`,
  CONFIRMED: `已成团 · 已确认${GROUPED_CLOSED_NOTE}`,
  OPEN: `已开房 · 待开场${GROUPED_CLOSED_NOTE}`,
  IN_SERVICE: `进行中${GROUPED_CLOSED_NOTE}`,
  FINISHED: '场次已结束，不再接受新报名。',
  HOLD: '场次已结束（结算处理中），不再接受新报名。',
  SETTLED: '场次已结算，不再接受新报名。',
  FAILED: '已流标，报名费用将原路全额自动退款。',
  CANCELLED: '场次已取消，已支付报名将按取消规则处理退款。',
};

/** 非报名中态的报名关闭说明（未知状态回退=状态文案+通用关闭句） */
export function sessionClosedNote(status: string): string {
  const note = CLOSED_NOTE[status as SessionStatus];
  if (note !== undefined) return note;
  return `${sessionStatusCopy(status).label}——不再接受新报名。`;
}

const PRICE_MODE_COPY: Readonly<Record<string, string>> = {
  per_head: '人头价',
  session_total: '总价分摊',
};

/** 计价方式文案（per_head=每人同价；session_total=总价÷人数分摊快照） */
export function priceModeCopy(mode: string): string {
  return PRICE_MODE_COPY[mode] ?? mode;
}

const ROOM_MODE_COPY: Readonly<Record<string, string>> = {
  text: '图文',
  voice: '语音',
  video: '视频',
};

/** 沟通形式文案（B3 §3 值域 text|voice|video） */
export function roomModeCopy(mode: string): string {
  return ROOM_MODE_COPY[mode] ?? mode;
}

const SPECIALTY_COPY: Readonly<Record<string, string>> = {
  labor_arbitration: '劳动仲裁',
};

/** 专项文案（V1 单专项 labor_arbitration，E3 接线后扩表） */
export function specialtyCopy(specialty: string): string {
  return SPECIALTY_COPY[specialty] ?? specialty;
}

// ---------------------------------------------------------------------------
// 列表状态筛选（客户端过滤档位：C1 生命周期分组单源；GET /sessions 无状态查询键）
// ---------------------------------------------------------------------------

export interface SessionStatusFilter {
  readonly key: string;
  readonly label: string;
  /** 'all'=不过滤；否则=命中状态集 */
  readonly statuses: readonly SessionStatus[] | 'all';
  /**
   * 公开列表可选档（评审 S7）：GET /sessions 仅返回 CREATED（core W3-12）——
   * 仅 all/CREATED 可选，其余档禁用并标「暂未开放」（恒空档不给可点击假象）
   */
  readonly available: boolean;
}

export const SESSION_STATUS_FILTERS: readonly SessionStatusFilter[] = [
  { key: 'all', label: '全部', statuses: 'all', available: true },
  { key: 'CREATED', label: '报名中', statuses: ['CREATED'], available: true },
  {
    key: 'GROUPED',
    label: '已成团',
    statuses: ['FULL', 'CONFIRMED'],
    available: false,
  },
  { key: 'LIVE', label: '进行中', statuses: ['OPEN', 'IN_SERVICE'], available: false },
  {
    key: 'DONE',
    label: '已结束',
    statuses: ['FINISHED', 'HOLD', 'SETTLED'],
    available: false,
  },
  {
    key: 'FAILED',
    label: '已流标/取消',
    statuses: ['FAILED', 'CANCELLED'],
    available: false,
  },
];

/** 按筛选档过滤列表（未知档键=原样返回，防御散写键） */
export function filterSessionsByStatus(
  list: readonly SessionView[],
  filterKey: string,
): readonly SessionView[] {
  const filter = SESSION_STATUS_FILTERS.find((f) => f.key === filterKey);
  if (!filter || filter.statuses === 'all') return list;
  return list.filter((s) => (filter.statuses as readonly string[]).includes(s.status));
}
