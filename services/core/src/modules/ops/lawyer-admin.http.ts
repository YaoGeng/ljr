/**
 * H1 律师与资质管理 HTTP 面共用件（§5 契约词汇 snake_case）：只做「形状→领域入参」搬运，
 * 错误映射经 infrastructure 的 AppHttpExceptionFilter（全仓唯一过滤器纪律，不新增副本）。
 * audit 动作解析复用 A3a parseAuditActionBody（R-W3-B：action 词汇=A3a 实现词汇
 * claim/approve/reject/suspend/resume——H1 §5 文档 pass/reject 旧词不采用，裁决已定）。
 */
import { AppError, ErrorCode } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';

/** 工作台 status 过滤值域（A3a 状态机状态；缺省=审核队列由服务层定） */
const WORKBENCH_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'PASSED', 'REJECTED', 'SUSPENDED'] as const;
export type WorkbenchStatus = (typeof WORKBENCH_STATUSES)[number];

export interface WorkbenchQuery {
  /** 单值过滤；absent=审核队列（SUBMITTED|IN_REVIEW） */
  readonly status?: WorkbenchStatus;
  readonly page: number;
}

/** GET /admin/lawyers?status=&page= 查询解析 */
export function parseWorkbenchQuery(query: {
  status?: string;
  page?: string;
}): WorkbenchQuery {
  const rawStatus = query.status;
  let status: WorkbenchStatus | undefined;
  if (rawStatus !== undefined && rawStatus !== '') {
    if (!(WORKBENCH_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `status 必须为 ${WORKBENCH_STATUSES.join('|')} 之一`,
      );
    }
    status = rawStatus as WorkbenchStatus;
  }
  const rawPage = query.page;
  const page =
    rawPage === undefined || rawPage === '' ? 1 : parsePositiveInt(rawPage, 'page');
  return { status, page };
}

/** POST /admin/lawyers/{id}/suspend 体：{reason}（1-256 位非空，A3a suspend reason 同规则） */
export function parseSuspendBody(body: unknown): { reason: string } {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCode.InvalidArgument, '请求体须为 JSON 对象 {reason}');
  }
  const raw = (body as { reason?: unknown }).reason;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 256) {
    throw new AppError(ErrorCode.InvalidArgument, 'reason 必须为 1-256 位非空字符串');
  }
  return { reason: raw };
}

/** YYYY-MM-DD 形态（上海日界口径，与 C1 stats 同源校验形态） */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ProfileWindowQuery {
  readonly from?: string;
  readonly to?: string;
}

/** GET /admin/lawyers/{id}/profile?from=&to= 查询解析（absent=服务层缺省近 30 天，⚠§11） */
export function parseProfileWindowQuery(query: {
  from?: string;
  to?: string;
}): ProfileWindowQuery {
  const out: { from?: string; to?: string } = {};
  for (const key of ['from', 'to'] as const) {
    const raw = query[key];
    if (raw === undefined || raw === '') continue;
    if (!ISO_DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      throw new AppError(ErrorCode.InvalidArgument, `${key} 必须为 YYYY-MM-DD 形态`);
    }
    out[key] = raw;
  }
  if (out.from !== undefined && out.to === undefined) {
    throw new AppError(ErrorCode.InvalidArgument, 'from/to 须成对给出（或都缺省=近 30 天）');
  }
  if (out.to !== undefined && out.from === undefined) {
    throw new AppError(ErrorCode.InvalidArgument, 'from/to 须成对给出（或都缺省=近 30 天）');
  }
  return out;
}
