/**
 * H3 纠纷工单数据面（M3-W3 T3）：/admin/tickets 五端点。
 *
 * 出入参类型为 services/core 实码契约副本（admin 不依赖 core/shared 包——T1 口径，
 * 消费侧出参类型上移 @ljr/shared=独立卡）：每类型头注标注来源文件，core 改口径时本文件
 * 随之同步。词汇纪律：category 七值/status 四值/请求体键名逐字对照 core 实码，禁发明字段
 * （TicketView 无金额字段——原型 a-tickets 金额列不虚构承载）。
 *
 * 幂等口径（H3 §5 + core 实码）：建单幂等键=category+ref（无 ref 人工单无幂等锚 ⚠W2-9，
 * 服务端 ON CONFLICT 重放返回 created:false）；处置幂等键=工单（终态 409 CLOSED 不翻案）。
 */
import { apiFetch } from './client';

// ---------------------------------------------------------------------------
// 契约类型副本（对照来源逐字段抄，禁发明）
// ---------------------------------------------------------------------------

/** 工单类目七值（@ljr/shared events.ts TICKET_CATEGORIES 实码序；DDL ck 同源锚） */
export type TicketCategory =
  | 'dispute'
  | 'refund_review'
  | 'price_change'
  | 'cancel_lt24h'
  | 'reconciliation'
  | 'dead_letter'
  | 'export_recording';

export const TICKET_CATEGORY_VALUES: readonly TicketCategory[] = [
  'dispute',
  'refund_review',
  'price_change',
  'cancel_lt24h',
  'reconciliation',
  'dead_letter',
  'export_recording',
];

/** 工单状态四值（core ops/ticket.types.ts TICKET_STATUSES 实码序；迁移禁裸写） */
export type TicketStatus = 'OPEN' | 'PROCESSING' | 'RESOLVED' | 'REJECTED';

export const TICKET_STATUS_VALUES: readonly TicketStatus[] = [
  'OPEN',
  'PROCESSING',
  'RESOLVED',
  'REJECTED',
];

/** 工单行视图（core ops/ticket.types.ts TicketView；sla_overdue=未结且已过 SLA 的告警数据位） */
export interface TicketView {
  readonly id: number;
  readonly category: TicketCategory;
  readonly ref_type: string | null;
  readonly ref_id: number | null;
  readonly title: string;
  readonly detail: string;
  readonly status: TicketStatus;
  readonly priority: number;
  readonly sla_due: string;
  readonly sla_overdue: boolean;
  readonly assignee_id: number | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

/** 工单处置审计行（core ops/ticket.types.ts TicketActionView——每次状态迁移同事务一行） */
export interface TicketActionView {
  readonly id: number;
  readonly ticket_id: number;
  readonly action: string;
  readonly operator_id: number;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

/** GET /admin/tickets/{id} 出参（core ticket.service.ts getTicketDetail） */
export interface TicketDetailView {
  readonly ticket: TicketView;
  readonly actions: readonly TicketActionView[];
}

/** GET /admin/tickets/sla-stats 出参（core ticket.types.ts TicketSlaStats；超时率口径留 H4） */
export interface TicketSlaStats {
  /** 未结工单总数（OPEN+PROCESSING） */
  readonly open_total: number;
  /** 未结且已过 SLA 的工单数 */
  readonly overdue_total: number;
  /** 分类计数（键=category；仅尚有未结工单的类目出现——已决净空类目不计） */
  readonly by_category: Readonly<Record<string, { open: number; overdue: number }>>;
}

/** POST /admin/tickets 请求体（core ticket.http.ts parseCreateTicketBody 形状；键 snake_case） */
export interface CreateTicketBody {
  readonly category: TicketCategory;
  readonly title: string;
  readonly detail: string;
  /** 关联实体类型（≤16 字符；与 ref_id 成对——两者齐备才构成幂等键 category+ref） */
  readonly ref_type?: string;
  readonly ref_id?: number;
  /** 优先级 1-5（缺省 3——PRD 未定义档位语义，占位值） */
  readonly priority?: number;
  /** 分派处理人（正整数；可缺省） */
  readonly assignee_id?: number;
}

/** POST /admin/tickets 出参（core ticket.controller.ts create：幂等重放 created:false 回原单） */
export interface CreateTicketResult {
  readonly created: boolean;
  readonly ticket_id: number;
  readonly status: string;
}

/** POST /admin/tickets/{id}/resolve 请求体（core ticket.http.ts parseResolveTicketBody 形状） */
export interface ResolveTicketRequest {
  /** 审批决策：true→RESOLVED / false→REJECTED（H3 §9 只透传决策，不内嵌资损规则） */
  readonly approved: boolean;
  /** 处置载荷：携带 target 时触发回调发起方（效果先行，目标侧幂等） */
  readonly action_payload?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 展示映射表（文案单源，禁组件散写三元）
// ---------------------------------------------------------------------------

/** 类目 → 中文（H3 §2 工单类型；列筛选/列表/详情共用单表） */
export const TICKET_CATEGORY_LABELS: Readonly<Record<TicketCategory, string>> = {
  dispute: '纠纷申诉',
  refund_review: '退款审核',
  price_change: '改价审批',
  cancel_lt24h: '<24h 取消审批',
  reconciliation: '对账差异',
  dead_letter: '死信',
  export_recording: '录制调取',
};

/** 状态 → 中文（TicketView.status 四值域） */
export const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, string>> = {
  OPEN: '待处理',
  PROCESSING: '处理中',
  RESOLVED: '已办结',
  REJECTED: '已驳回',
};

/** 审计动作 → 中文（core 实码三动作：认领半步 + 终态两枚；表外动作原样透传） */
export const TICKET_ACTION_LABELS: Readonly<Record<string, string>> = {
  start_processing: '认领处理（OPEN → PROCESSING）',
  resolve: '办结（→ RESOLVED）',
  reject: '驳回（→ REJECTED）',
};

/** 终态判定（core ticket.types.ts isTicketTerminal 同规则：再处置即 409 CLOSED 幂等短路） */
export function isTicketTerminal(status: TicketStatus): boolean {
  return status === 'RESOLVED' || status === 'REJECTED';
}

/**
 * SLA 窗口口径（H3 §2 / core ticket.config slaMsForCategory：对账差异 24h 硬（R-03）、
 * 其余 48h 软；锚=建单时刻）。展示用标签单源。
 */
export function slaWindowLabel(category: TicketCategory): string {
  return category === 'reconciliation' ? '24h（硬）' : '48h（软）';
}

/**
 * 超期徽标展示判定：服务端 sla_overdue 数据位为真**且**状态非终态才亮——服务端 SQL 已按
 * 「未结且过 SLA」计算，此处终态复核为防御位（陈旧行不让已决工单挂超期告警，统计面同口径）。
 */
export function isSlaOverdue(ticket: Pick<TicketView, 'status' | 'sla_overdue'>): boolean {
  return ticket.sla_overdue === true && !isTicketTerminal(ticket.status);
}

// ---------------------------------------------------------------------------
// resolve 回调目标（core ops/ticket.callbacks.ts 实码：target 路由词 + 发起方实体 id 字段名）
// ---------------------------------------------------------------------------

/** 回调目标路由词（callbacks 注册表词汇：pricing 已接线 / d4=W2 T3 接线位） */
export type ResolveTarget = 'pricing' | 'd4';

/** target → 发起方实体 id 字段名（ticket.callbacks.ts TicketResolveCallback.idField 实码） */
export const RESOLVE_TARGET_ID_FIELDS: Readonly<Record<ResolveTarget, string>> = {
  pricing: 'price_change_id',
  d4: 'cancellation_id',
};

/**
 * 已接线回调目标（callbacks 注册表构造期仅注册 pricing=C6 改价审批真链；d4 未注册——
 * 携带未注册 target 服务端显式 400，UI 不提供入口）。
 */
export const WIRED_RESOLVE_TARGETS: readonly ResolveTarget[] = ['pricing'];

// ---------------------------------------------------------------------------
// 纯函数（表单防呆 + 请求体构造，bun test 直测；规则逐字对照 core 校验实码双层）
// ---------------------------------------------------------------------------

/** 构造结果：ok=false 附防呆提示（与服务端校验同规则——前端防呆+服务端兜底双层） */
export type BuildResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** 建单表单输入（字符串原样；校验+数值化收口在 buildCreateTicketBody） */
export interface CreateTicketFormInput {
  readonly category: string;
  readonly title: string;
  readonly detail: string;
  readonly refType: string;
  readonly refId: string;
  readonly priority: string;
  readonly assigneeId: string;
}

function isPositiveIntString(raw: string): boolean {
  return /^\d+$/.test(raw.trim()) && Number.parseInt(raw.trim(), 10) > 0;
}

/**
 * 建单请求体构造（对照 core ticket.http.ts parseCreateTicketBody + ticket.service.ts
 * assertCreateInput 规则）：category 七值词汇 / title 1-128 / detail 1-4000 / ref
 * both-or-neither（ref_type ≤16 且 ref_id 正整数）/ priority 1-5 整数 / assignee_id 正整数。
 * 可选键合法缺省不进请求体（parseCreateTicketBody 只认 undefined 缺省）。
 */
export function buildCreateTicketBody(input: CreateTicketFormInput): BuildResult<CreateTicketBody> {
  if (!(TICKET_CATEGORY_VALUES as readonly string[]).includes(input.category)) {
    return { ok: false, error: 'category 必须为七类工单之一' };
  }
  const category = input.category as TicketCategory;
  const title = input.title.trim();
  if (title === '') return { ok: false, error: '标题不得为空' };
  if (input.title.length > 128) return { ok: false, error: '标题不得超过 128 字' };
  const detail = input.detail.trim();
  if (detail === '') return { ok: false, error: '工单正文不得为空' };
  if (input.detail.length > 4000) return { ok: false, error: '工单正文不得超过 4000 字' };
  const body: {
    category: TicketCategory;
    title: string;
    detail: string;
    ref_type?: string;
    ref_id?: number;
    priority?: number;
    assignee_id?: number;
  } = { category, title, detail };
  const refType = input.refType.trim();
  const refId = input.refId.trim();
  // both-or-neither：部分携带=幂等键残缺，前端先拒（服务层同规则收口）
  if (refType !== '' || refId !== '') {
    if (refType === '' || refId === '') {
      return { ok: false, error: 'ref_type/ref_id 必须成对填写（两者齐备才构成幂等键）' };
    }
    if (refType.length > 16) return { ok: false, error: 'ref_type 不得超过 16 字符' };
    if (!isPositiveIntString(refId)) return { ok: false, error: 'ref_id 必须为正整数' };
    body.ref_type = refType;
    body.ref_id = Number.parseInt(refId, 10);
  }
  const priority = input.priority.trim();
  if (priority !== '') {
    if (!/^[1-5]$/.test(priority))
      return { ok: false, error: 'priority 必须为 1-5 整数（缺省 3）' };
    body.priority = Number.parseInt(priority, 10);
  }
  const assigneeId = input.assigneeId.trim();
  if (assigneeId !== '') {
    if (!isPositiveIntString(assigneeId)) return { ok: false, error: 'assignee_id 必须为正整数' };
    body.assignee_id = Number.parseInt(assigneeId, 10);
  }
  return { ok: true, value: body };
}

/** resolve 处置表单输入（target 空串=不携带回调；refId=target 对应实体 id） */
export interface ResolveFormInput {
  readonly target: string;
  readonly refId: string;
}

/**
 * resolve 请求体构造（对照 core ticket.service.ts resolveTicket 实码规则）：
 *  - target 缺省 → 不带 action_payload（纯记录处置）；category=cancel_lt24h 例外——
 *    回调承载类工单缺 target 服务端 400（core I-3：审批通过而取消流未生效的静默漂移防线）；
 *  - target=pricing → action_payload={target, price_change_id}（C6 审批回调真链：approved
 *    时触发 POST /pricing/change/{id}/approve，工单号=①期人工兜底处置凭据）；
 *  - target=d4 → 未接线（W2 T3 位，服务端未注册 target 400），前端先拒。
 */
export function buildResolveTicketBody(
  input: ResolveFormInput & { readonly approved: boolean; readonly category: TicketCategory },
): BuildResult<ResolveTicketRequest> {
  const target = input.target.trim();
  if (target === '') {
    if (input.category === 'cancel_lt24h') {
      return {
        ok: false,
        error: '该工单为回调承载类（cancel_lt24h）：处置必须携带 action_payload.target',
      };
    }
    return { ok: true, value: { approved: input.approved } };
  }
  if (
    !(Object.keys(RESOLVE_TARGET_ID_FIELDS) as ResolveTarget[]).includes(target as ResolveTarget)
  ) {
    return { ok: false, error: `未知回调目标：${target}` };
  }
  if (!(WIRED_RESOLVE_TARGETS as readonly string[]).includes(target)) {
    return { ok: false, error: `target=${target} 回调未接线（W2 T3 接线位），当前不可选` };
  }
  const idField = RESOLVE_TARGET_ID_FIELDS[target as ResolveTarget];
  if (!isPositiveIntString(input.refId)) {
    return { ok: false, error: `action_payload.${idField} 必须为正整数` };
  }
  return {
    ok: true,
    value: {
      approved: input.approved,
      action_payload: { target, [idField]: Number.parseInt(input.refId, 10) },
    },
  };
}

// ---------------------------------------------------------------------------
// API 函数（全部受保护面：auth + 401 统一拦截）
// ---------------------------------------------------------------------------

/**
 * GET /admin/tickets?category=&status=&limit=：工单列表（新单在前=服务端 id DESC；
 * 缺省 limit=100/封顶 200——读面无翻页契约，本页用缺省不传）。
 */
export async function listTickets(
  category?: TicketCategory,
  status?: TicketStatus,
  limit?: number,
): Promise<{ items: readonly TicketView[] }> {
  const params = new URLSearchParams();
  if (category !== undefined) params.set('category', category);
  if (status !== undefined) params.set('status', status);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch<{ items: readonly TicketView[] }>(`/admin/tickets${qs === '' ? '' : `?${qs}`}`, {
    auth: true,
  });
}

/** GET /admin/tickets/sla-stats：SLA 统计面（open/overdue 计数 + 分类计数；超时率留 H4） */
export async function fetchSlaStats(): Promise<TicketSlaStats> {
  return apiFetch<TicketSlaStats>('/admin/tickets/sla-stats', { auth: true });
}

/**
 * POST /admin/tickets：人工建单（事件建单走 relay 消费面不经此端点）。幂等键=category+ref：
 * 重复提交服务端幂等重放返回 created:false + 原单 ticket_id（调用方据此区分提示）。
 */
export async function createTicket(body: CreateTicketBody): Promise<CreateTicketResult> {
  return apiFetch<CreateTicketResult>('/admin/tickets', { method: 'POST', auth: true, body });
}

/** GET /admin/tickets/{id}：详情（主行 + ticket_actions 审计行；404 未知如实承载错误态） */
export async function fetchTicketDetail(id: number): Promise<TicketDetailView> {
  return apiFetch<TicketDetailView>(`/admin/tickets/${id}`, { auth: true });
}

/**
 * POST /admin/tickets/{id}/resolve：处置（approved=true→RESOLVED / false→REJECTED）。
 * 终态重放 → 409 E_CONFLICT（CLOSED，幂等键=工单）；action_payload.target=pricing 时
 * 触发 C6 审批回调真链（目标侧幂等）。409 → 屏顶横幅+刷新（T2 模式承载）。
 */
export async function resolveTicket(
  id: number,
  req: ResolveTicketRequest,
): Promise<{ status: string }> {
  const body: { approved: boolean; action_payload?: Readonly<Record<string, unknown>> } = {
    approved: req.approved,
  };
  if (req.action_payload !== undefined) body.action_payload = req.action_payload;
  return apiFetch<{ status: string }>(`/admin/tickets/${id}/resolve`, {
    method: 'POST',
    auth: true,
    body,
  });
}
