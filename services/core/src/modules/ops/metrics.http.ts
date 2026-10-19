/**
 * H4 指标查询面 HTTP 共用件（§5 契约词汇 snake_case）：只做「形状→领域入参」搬运，
 * 错误映射经 AppHttpExceptionFilter（全仓唯一过滤器纪律）。窗口成对规则=H1
 * parseProfileWindowQuery 同源形态（缺省语义不同：本面缺省=全量，H1=近 30 天——§5 未定
 * 缺省窗，全量=零隐式默认，报告注明）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import type { MetricGroup } from './metrics.types';

const METRIC_GROUPS: readonly MetricGroup[] = ['core', 'health'];

/** YYYY-MM-DD 形态（上海日界口径） */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface MetricsQuery {
  readonly group: MetricGroup;
  readonly from?: string;
  readonly to?: string;
}

/** GET /admin/dashboard/metrics?group=core|health&from=&to= 查询解析 */
export function parseMetricsQuery(query: {
  group?: string;
  from?: string;
  to?: string;
}): MetricsQuery {
  const group = query.group;
  if (group === undefined || group === '') {
    throw new AppError(ErrorCode.InvalidArgument, `group 必填（${METRIC_GROUPS.join('|')}）`);
  }
  if (!(METRIC_GROUPS as readonly string[]).includes(group)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `group 必须为 ${METRIC_GROUPS.join('|')} 之一：${group}`,
    );
  }
  const out: { group: MetricGroup; from?: string; to?: string } = { group: group as MetricGroup };
  for (const key of ['from', 'to'] as const) {
    const raw = query[key];
    if (raw === undefined || raw === '') continue;
    if (!ISO_DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      throw new AppError(ErrorCode.InvalidArgument, `${key} 必须为 YYYY-MM-DD 形态`);
    }
    out[key] = raw;
  }
  if ((out.from !== undefined) !== (out.to !== undefined)) {
    throw new AppError(ErrorCode.InvalidArgument, 'from/to 须成对给出（或都缺省=全量）');
  }
  if (
    out.from !== undefined &&
    out.to !== undefined &&
    Date.parse(`${out.to}T00:00:00Z`) < Date.parse(`${out.from}T00:00:00Z`)
  ) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `区间倒置（from 须 ≤ to）：${out.from}..${out.to}`,
    );
  }
  return out;
}
