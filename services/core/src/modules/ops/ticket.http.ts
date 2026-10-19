/**
 * H3 工单 HTTP 面共用件（§5 契约词汇 snake_case）：只做「形状→领域入参」搬运，错误映射
 * 经 infrastructure 的 AppHttpExceptionFilter（全仓唯一过滤器纪律）。lawyer-admin.http 先例。
 */
import { AppError, ErrorCode, TICKET_CATEGORIES } from '@ljr/shared';
import { parsePositiveInt } from '../../infrastructure/parse-positive-int';
import type { CreateTicketInput, TicketStatus } from './ticket.types';
import { TICKET_STATUSES } from './ticket.types';

/** GET /admin/tickets 查询解析（category/status 单值筛选，均合法词汇校验） */
export function parseTicketListQuery(query: {
  readonly category?: string;
  readonly status?: string;
  readonly limit?: string;
}): { category?: CreateTicketInput['category']; status?: TicketStatus; limit?: number } {
  const out: { category?: CreateTicketInput['category']; status?: TicketStatus; limit?: number } =
    {};
  if (query.category !== undefined && query.category !== '') {
    if (!(TICKET_CATEGORIES as readonly string[]).includes(query.category)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `category 必须为 ${TICKET_CATEGORIES.join('|')} 之一：${query.category}`,
      );
    }
    out.category = query.category as CreateTicketInput['category'];
  }
  if (query.status !== undefined && query.status !== '') {
    if (!(TICKET_STATUSES as readonly string[]).includes(query.status)) {
      throw new AppError(
        ErrorCode.InvalidArgument,
        `status 必须为 ${TICKET_STATUSES.join('|')} 之一：${query.status}`,
      );
    }
    out.status = query.status as TicketStatus;
  }
  if (query.limit !== undefined && query.limit !== '') {
    out.limit = parsePositiveInt(query.limit, 'limit');
  }
  return out;
}

/** POST /admin/tickets 体：{category, ref_type?, ref_id?, title, detail, priority?, assignee_id?} */
export function parseCreateTicketBody(body: unknown): CreateTicketInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      '请求体须为 JSON 对象 {category, title, detail, ...}',
    );
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw['category'] !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, 'category 必须为字符串（七值词汇）');
  }
  const input: {
    category: CreateTicketInput['category'];
    title: unknown;
    detail: unknown;
    refType?: unknown;
    refId?: unknown;
    priority?: unknown;
    assigneeId?: unknown;
  } = {
    category: raw['category'] as CreateTicketInput['category'],
    title: raw['title'],
    detail: raw['detail'],
  };
  if (raw['ref_type'] !== undefined || raw['ref_id'] !== undefined) {
    if (typeof raw['ref_type'] !== 'string' || raw['ref_id'] === undefined) {
      throw new AppError(ErrorCode.InvalidArgument, 'ref_type/ref_id 必须成对出现（或都缺省）');
    }
    input.refType = raw['ref_type'];
    input.refId = raw['ref_id']; // 服务层正整数校验收口
  }
  if (raw['priority'] !== undefined) input.priority = raw['priority'];
  if (raw['assignee_id'] !== undefined) input.assigneeId = raw['assignee_id'];
  return input as CreateTicketInput;
}

/** POST /admin/tickets/{id}/resolve 体：{action_payload?, approved}（§5+任务简报形状） */
export function parseResolveTicketBody(body: unknown): {
  approved: boolean;
  actionPayload?: Readonly<Record<string, unknown>>;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(
      ErrorCode.InvalidArgument,
      '请求体须为 JSON 对象 {approved, action_payload?}',
    );
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw['approved'] !== 'boolean') {
    throw new AppError(
      ErrorCode.InvalidArgument,
      `approved 必须为布尔：${JSON.stringify(raw['approved'])}`,
    );
  }
  const out: { approved: boolean; actionPayload?: Readonly<Record<string, unknown>> } = {
    approved: raw['approved'],
  };
  if (raw['action_payload'] !== undefined) {
    if (
      typeof raw['action_payload'] !== 'object' ||
      raw['action_payload'] === null ||
      Array.isArray(raw['action_payload'])
    ) {
      throw new AppError(ErrorCode.InvalidArgument, 'action_payload 必须为 JSON 对象');
    }
    out.actionPayload = raw['action_payload'] as Record<string, unknown>;
  }
  return out;
}
