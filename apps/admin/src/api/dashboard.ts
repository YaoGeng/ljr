/**
 * 指标条数据面（M3-W3 T1，W3-5）：GET /admin/dashboard/metrics?group=core（H4 查询面）。
 *
 * 出参/目录/口径为 services/core/src/modules/ops/metrics.types.ts（MetricsResponse/
 * METRIC_CATALOG/METRIC_STUBS）的契约副本——admin 不依赖 core 包；core 改口径时本文件
 * 随之同步（后续消费侧出参类型上移 @ljr/shared=独立卡，M3-W3 计划「不入本批」注记）。
 *
 * H4 数据看板全页=M4 范畴不越界：本卡只做轻量指标条（数字卡横排+口径注记透传），
 * 不做图表/窗口筛选/健康组。
 */
import { apiFetch } from './client';

/** 查询面单指标出参（H4 §5「指标集」；value=null+stub=桩位/口径受限显式） */
export interface MetricView {
  readonly key: string;
  readonly value: number | null;
  readonly stub: string | null;
}

/** GET /admin/dashboard/metrics 出参（group=core） */
export interface CoreMetricsResponse {
  readonly group: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly metrics: readonly MetricView[];
}

/** group=core 指标目录标题副本（core METRIC_CATALOG core 组；展示名单序=服务端出参序） */
export const METRIC_TITLES: Readonly<Record<string, string>> = {
  group_buy_rate_b2c: '拼单成团率（B2C）',
  group_buy_rate_c2b: '拼单成团率（C2B）',
  user_group_buy_rate: '用户发起拼团成团率',
  attendance_rate: '到场率（normal+late÷判定数）',
  punctual_attendance_rate: '准时到场率（normal÷判定数）',
  absence_rate: '缺席率（absent÷判定数）',
  one_on_one_conversion_rate: '1对1转化率',
  lawyer_room_count: '律师人效·房间数',
  lawyer_room_avg_duration_min: '律师人效·房间平均时长（分钟）',
  draft_adoption_rate: 'Agent草稿采用率',
  satisfaction_avg_overall: '满意度·总体均值',
  satisfaction_avg_professional: '满意度·专业均值',
  satisfaction_avg_response: '满意度·响应均值',
  satisfaction_avg_attitude: '满意度·态度均值',
  repurchase_rate: '复购率',
};

/** 展示标题（未登记 key 原样透传——不吞不造） */
export function metricTitle(key: string): string {
  return METRIC_TITLES[key] ?? key;
}

/**
 * 指标值格式化（映射纪律：单位口径集中一处，禁组件散写三元）。
 * core 出参形态：rate4=0..1 小数（四位舍入）；satisfaction_avg_*=1-5 均值；计数=整数；
 * value=null=不可算/桩位 → '—'（stub 另行展示，不假装数据）。
 * 比率键判定=含 '_rate'（目录键有 group_buy_rate_b2c/c2b 后缀变体，endsWith 会漏判）。
 */
export function formatMetricValue(key: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (key.startsWith('satisfaction_avg_')) return value.toFixed(2);
  if (key === 'lawyer_room_count') return String(Math.round(value));
  if (key === 'lawyer_room_avg_duration_min') return `${Math.round(value)} 分钟`;
  if (key.includes('_rate')) return `${(value * 100).toFixed(2)}%`;
  return String(value);
}

/** 首页轻量指标条（group=core 全量窗口；from/to 窗口面=H4 全页 M4 范畴） */
export async function fetchCoreMetrics(): Promise<CoreMetricsResponse> {
  return apiFetch<CoreMetricsResponse>('/admin/dashboard/metrics?group=core', { auth: true });
}
