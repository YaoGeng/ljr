/**
 * 律师工作台统计 API（M3-W2 T2）：四个独立统计面 + AI 辅助健康探针。
 * 不造聚合端点——视图层四请求各自三态（useResource），本层只做契约消费与形状校验。
 *
 *   GET /lawyer/sessions/stats?from=&to=    （C1 §5 四率——M2-W3 T3 起全真值；null=缺数据）
 *   GET /lawyer/attendance-stats?from=&to=  （D3 §5 {samples, punctual_rate}——H4 口径）
 *   GET /lawyer/response-stats?from=&to=    （C4 §5 {samples[], avg_confirm_minutes}）
 *   GET /lawyer/settlements                 （F3 §5 本人结算列表，新在前，无分页/窗口键）
 *   GET /agent/health                       （E1 §5 降级探针——无守卫面，不注 Bearer）
 *
 * 出参形状以 core 实文为准（session.service.stats / attendance.service.attendanceStats /
 * group-buy-response.service.responseStats / settlement.controller.mine → SettlementView /
 * draft.service.health）；率值=4 位小数分数（core rate4——比率非金额不受 Money 禁 float 约束）。
 * 本模块保持平台无关（无 react-native import），bun test 直接可测。
 */
import { AppClientErrorCode, apiFetch, AppApiError } from './client';
import { isValidMoney, type Money } from './money';

/** C1 四率（SessionStatsView 实文逐键；null=窗内零样本/零判定/零参与者——缺数据非 0） */
export interface SessionStatsView {
  /** 报名率=Σjoined/Σcapacity */
  readonly enroll_rate: number | null;
  /** 成团率=成团链场次数/总场次数 */
  readonly group_rate: number | null;
  /** 到场率=(NORMAL+LATE)÷已判定行（H4 口径，双角色） */
  readonly attendance_rate: number | null;
  /** 1对1 转化率=订单数÷进房去重用户数（02 §7.2 口径） */
  readonly ooo_rate: number | null;
}

/** D3 律师准时到场率（samples=0 → punctual_rate=0——core 空窗不除零口径） */
export interface AttendanceStatsView {
  readonly samples: number;
  readonly punctual_rate: number;
}

/** C4 响应样本（12h 确认时长口径——H4 实力档案聚合源） */
export interface ResponseStatsSample {
  readonly gb_id: number;
  readonly confirmed_at: string;
  readonly confirm_minutes: number;
}

export interface ResponseStatsView {
  readonly samples: readonly ResponseStatsSample[];
  /** 窗内零确认 → null（缺数据语义） */
  readonly avg_confirm_minutes: number | null;
}

/** F3 结算单视图（SettlementView 实文逐字段；工作台简版消费 status/net/ref_type/created_at，
 *  其余字段如实承载——deduction_detail 结构详情 F3 内部，原样透传不做形状断言） */
export interface LawyerSettlementView {
  readonly id: number;
  readonly ref_type: string;
  readonly ref_id: number;
  readonly lawyer_id: number;
  readonly firm_id: number;
  readonly gross: Money;
  readonly penalty: Money;
  readonly platform_fee: Money;
  readonly fee_version_id: number;
  readonly net: Money;
  readonly share_mode: string;
  readonly payment_order_id: number | null;
  readonly escrow_status: string | null;
  readonly deduction_detail: unknown;
  readonly status: string;
  readonly hold_reason: string | null;
  readonly created_at: string;
  readonly settled_at: string | null;
}

/** E1 健康探针出参（AgentHealth 实文：last_error 无原文——R-02；计数进程内单调） */
export interface AgentHealthView {
  readonly status: 'ok' | 'degraded';
  readonly last_error: string | null;
  readonly degraded_count: number;
}

/** 统计窗（from/to=YYYY-MM-DD 上海日界；三统计面共用形状） */
export interface StatsWindow {
  readonly from: string;
  readonly to: string;
}

function badShape(detail: string): AppApiError {
  return new AppApiError({
    code: AppClientErrorCode.BadResponseBody,
    copy: '服务响应异常，请稍后重试',
    serverMessage: `统计响应形状非法：${detail}`,
  });
}

function isRate(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

/** 率字段读取（unknown → number|null；非法即形状错——索引访问收窄不生效，显式读取） */
function readRate(r: Record<string, unknown>, key: string): number | null {
  const v = r[key];
  if (!isRate(v)) throw badShape(`${key} 非 number|null`);
  return v;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 非负整数字段读取（同 readRate——正整数域加 must 位：0 视非法的 id 类） */
function readInt(
  r: Record<string, unknown>,
  key: string,
  opts: { readonly positive?: boolean } = {},
): number {
  const v = r[key];
  if (!isNonNegInt(v) || (opts.positive === true && v === 0)) {
    throw badShape(`${key} 非${opts.positive === true ? '正' : '非负'}整数`);
  }
  return v;
}

function windowQuery(w: StatsWindow): string {
  return `?from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`;
}

/** GET /lawyer/sessions/stats（Bearer+lawyer；四率全真值——session.service M2-W3 T3 起） */
export async function fetchSessionStats(window: StatsWindow): Promise<SessionStatsView> {
  const raw = await apiFetch<unknown>(`/lawyer/sessions/stats${windowQuery(window)}`, {
    auth: true,
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  return {
    enroll_rate: readRate(r, 'enroll_rate'),
    group_rate: readRate(r, 'group_rate'),
    attendance_rate: readRate(r, 'attendance_rate'),
    ooo_rate: readRate(r, 'ooo_rate'),
  };
}

/** GET /lawyer/attendance-stats（Bearer+lawyer） */
export async function fetchAttendanceStats(window: StatsWindow): Promise<AttendanceStatsView> {
  const raw = await apiFetch<unknown>(`/lawyer/attendance-stats${windowQuery(window)}`, {
    auth: true,
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  const samples = readInt(r, 'samples');
  const rate = r['punctual_rate'];
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw badShape('punctual_rate 非数值');
  }
  return { samples, punctual_rate: rate };
}

/** GET /lawyer/response-stats（Bearer+lawyer） */
export async function fetchResponseStats(window: StatsWindow): Promise<ResponseStatsView> {
  const raw = await apiFetch<unknown>(`/lawyer/response-stats${windowQuery(window)}`, {
    auth: true,
  });
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['samples'])) throw badShape('samples 非数组');
  const samples = r['samples'].map((row): ResponseStatsSample => {
    if (typeof row !== 'object' || row === null) throw badShape('samples 行非对象');
    const s = row as Record<string, unknown>;
    const gbId = readInt(s, 'gb_id', { positive: true });
    const confirmedAt = s['confirmed_at'];
    if (typeof confirmedAt !== 'string' || Number.isNaN(Date.parse(confirmedAt))) {
      throw badShape('confirmed_at 非时刻');
    }
    const minutes = s['confirm_minutes'];
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
      throw badShape('confirm_minutes 非数值');
    }
    return { gb_id: gbId, confirmed_at: confirmedAt, confirm_minutes: minutes };
  });
  return { samples, avg_confirm_minutes: readRate(r, 'avg_confirm_minutes') };
}

/** GET /lawyer/settlements（Bearer+lawyer；本人全量新在前——视图层取前 N 条做简版） */
export async function fetchLawyerSettlements(): Promise<LawyerSettlementView[]> {
  const raw = await apiFetch<unknown>('/lawyer/settlements', { auth: true });
  if (!Array.isArray(raw)) throw badShape('响应非数组');
  return raw.map((row): LawyerSettlementView => {
    if (typeof row !== 'object' || row === null) throw badShape('结算行非对象');
    const r = row as Record<string, unknown>;
    const ints = {
      id: readInt(r, 'id', { positive: true }),
      ref_id: readInt(r, 'ref_id', { positive: true }),
      lawyer_id: readInt(r, 'lawyer_id', { positive: true }),
      firm_id: readInt(r, 'firm_id', { positive: true }),
      fee_version_id: readInt(r, 'fee_version_id', { positive: true }),
    };
    const readMoney = (key: string): Money => {
      const v = r[key];
      if (!isValidMoney(v)) throw badShape(`${key} 非两位小数金额字符串`);
      return v;
    };
    const money = {
      gross: readMoney('gross'),
      penalty: readMoney('penalty'),
      platform_fee: readMoney('platform_fee'),
      net: readMoney('net'),
    };
    const readNonEmptyString = (key: string): string => {
      const v = r[key];
      if (typeof v !== 'string' || v.length === 0) throw badShape(`${key} 非非空字符串`);
      return v;
    };
    const strings = {
      ref_type: readNonEmptyString('ref_type'),
      share_mode: readNonEmptyString('share_mode'),
      status: readNonEmptyString('status'),
      created_at: readNonEmptyString('created_at'),
    };
    const readNullableString = (key: string): string | null => {
      const v = r[key];
      if (v !== null && typeof v !== 'string') throw badShape(`${key} 非 null/字符串`);
      return v;
    };
    const paymentOrderId = r['payment_order_id'];
    if (paymentOrderId !== null && !(isNonNegInt(paymentOrderId) && paymentOrderId !== 0)) {
      throw badShape('payment_order_id 非 null/正整数');
    }
    return {
      ...ints,
      ref_type: strings.ref_type,
      gross: money.gross,
      penalty: money.penalty,
      platform_fee: money.platform_fee,
      net: money.net,
      share_mode: strings.share_mode,
      payment_order_id: paymentOrderId,
      escrow_status: readNullableString('escrow_status'),
      deduction_detail: r['deduction_detail'],
      status: strings.status,
      hold_reason: readNullableString('hold_reason'),
      created_at: strings.created_at,
      settled_at: readNullableString('settled_at'),
    };
  });
}

/** GET /agent/health（E1 探针面无守卫——不注 Bearer；status 二值域严检） */
export async function fetchAgentHealth(): Promise<AgentHealthView> {
  const raw = await apiFetch<unknown>('/agent/health');
  if (typeof raw !== 'object' || raw === null) throw badShape('响应非对象');
  const r = raw as Record<string, unknown>;
  if (r['status'] !== 'ok' && r['status'] !== 'degraded') throw badShape('status 越二值域');
  if (r['last_error'] !== null && typeof r['last_error'] !== 'string') {
    throw badShape('last_error 非 null/字符串');
  }
  if (!isNonNegInt(r['degraded_count'])) throw badShape('degraded_count 非非负整数');
  return {
    status: r['status'],
    last_error: r['last_error'] as string | null,
    degraded_count: r['degraded_count'],
  };
}

// ---------------------------------------------------------------------------
// 统计窗与比率展示（纯函数，视图层共用）
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** 上海时区日历日 'YYYY-MM-DD'（en-CA locale=ISO 形状；中国无夏令时，周界无 DST 位移） */
function shanghaiDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * 当前统计窗：上海日历周的周一..周日（统计面 from/to=YYYY-MM-DD 上海日界）。
 * 工作台「本周数据」默认窗；纯函数可注入时钟直测。
 */
export function shanghaiWeekWindow(now: Date = new Date()): StatsWindow {
  const today = shanghaiDate(now);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const weekday = new Date(midnight).getUTCDay(); // 0=周日..6=周六
  const monday = midnight - ((weekday + 6) % 7) * DAY_MS;
  const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { from: fmt(monday), to: fmt(monday + 6 * DAY_MS) };
}

/** 周窗平移 ±N 周（时间表周视图翻页；纯日期算术，无时区再解释） */
export function shiftWeekWindow(w: StatsWindow, weeks: number): StatsWindow {
  const ms = weeks * 7 * DAY_MS;
  const shift = (d: string): string =>
    new Date(Date.parse(`${d}T00:00:00Z`) + ms).toISOString().slice(0, 10);
  return { from: shift(w.from), to: shift(w.to) };
}

/** 4 位小数分数 → '85.3%'（最多 1 位小数，无小数不补零）；null → '—'（缺数据语义非 0） */
export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  const pct = Math.round(rate * 1000) / 10;
  return `${pct}%`;
}

/**
 * 百分数数值 → '4.6%'（去尾零，最多 1 位小数）；null → '—'（评审修复环 I-1 单出口）。
 * 与 formatRate 输入域区分：本函数入参**已是百分数值**（C6 change_pct numeric(6,3) 文本，
 * 如 4.615=4.615%）；formatRate 入参为 [0,1] 分数（core rate4 出参）。混用即产生
 * 「4.615 → 461.5%」类放大百倍错误——两出口并列钉住用例。
 */
export function formatPercent(pct: number | null): string {
  if (pct === null) return '—';
  return `${Math.round(pct * 10) / 10}%`;
}
