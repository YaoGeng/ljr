/**
 * H3 纠纷工单类型定义（§3 领域模型的代码侧形状 + §5 接口契约出入参）。
 *
 * 词汇锚：category 七值/ref 锚=shared TICKET_CATEGORIES（DDL ck 同源契约锚，V38）；
 * 状态四值=DDL ck 同源。视图出站 snake_case（audit-log/lawyer-admin 先例）。
 */
import type { TicketCategory } from '@ljr/shared';

/** 工单状态四值（V38 ck 同源；迁移禁裸写——守卫+STL entity_type='ticket'） */
export const TICKET_STATUSES = ['OPEN', 'PROCESSING', 'RESOLVED', 'REJECTED'] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** 终态判定（RESOLVED/REJECTED——再处置即 409 CLOSED 幂等短路） */
export function isTicketTerminal(status: TicketStatus): boolean {
  return status === 'RESOLVED' || status === 'REJECTED';
}

/** 建单入参（事件消费与人工创建共用核；ref both-or-neither 由服务层校验） */
export interface CreateTicketInput {
  readonly category: TicketCategory;
  /** 关联实体类型（≤16 字符；与 ref_id 成对） */
  readonly refType?: string;
  /** 关联实体 id（正整数；与 refType 成对——两者齐备才构成幂等键 category+ref） */
  readonly refId?: number;
  readonly title: string;
  /** 工单正文（事件工单=触发事件载荷 JSON 留档；禁 phone/id_no 等 PII） */
  readonly detail: string;
  /** 优先级 1-5（缺省 3——PRD 未定义档位语义，占位值） */
  readonly priority?: number;
  /** 分派处理人（人工建单可带；事件建单缺省空） */
  readonly assigneeId?: number;
}

/** 工单行视图（snake_case 出站；sla_overdue=未结且已过 SLA 的告警数据位，H4 同源口径） */
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

/** 工单处置审计行（ticket_actions 出站） */
export interface TicketActionView {
  readonly id: number;
  readonly ticket_id: number;
  readonly action: string;
  readonly operator_id: number;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

/** 工单详情（GET /admin/tickets/{id}：主行 + actions 审计行，§5） */
export interface TicketDetailView {
  readonly ticket: TicketView;
  readonly actions: readonly TicketActionView[];
}

/** SLA 统计面（本批=布尔/计数查询；超时率口径留 H4） */
export interface TicketSlaStats {
  /** 未结工单总数（OPEN+PROCESSING） */
  readonly open_total: number;
  /** 未结且已过 SLA 的工单数 */
  readonly overdue_total: number;
  /** 分类计数（键=category；仅未结类目出现） */
  readonly by_category: Readonly<Record<string, { open: number; overdue: number }>>;
}

/** 处置入参（POST /admin/tickets/{id}/resolve {action_payload, approved}，§5 + 任务简报） */
export interface ResolveTicketInput {
  readonly ticketId: number;
  readonly operatorId: number;
  /** 审批决策：true→RESOLVED / false→REJECTED（H3 §1 只透传决策，不内嵌资损规则 §9） */
  readonly approved: boolean;
  /**
   * 处置载荷：携带 target 时触发回调发起方（{target:'pricing', price_change_id} /
   * {target:'d4', cancellation_id}——回调器注入形态，ticket.callbacks）。
   */
  readonly actionPayload?: Readonly<Record<string, unknown>>;
}
