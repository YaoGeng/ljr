import { beforeEach, describe, expect, it } from 'bun:test';
import { setApiBaseUrl } from './config';
import { AdminApiError, getAccessToken, setAccessToken, __resetClientForTest } from './client';
import { KNOWN_SERVER_CODES, resolveApiErrorCopy } from './error-messages';
import {
  RESOLVE_TARGET_ID_FIELDS,
  TICKET_CATEGORY_LABELS,
  TICKET_CATEGORY_VALUES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_VALUES,
  WIRED_RESOLVE_TARGETS,
  buildCreateTicketBody,
  buildResolveTicketBody,
  createTicket,
  fetchSlaStats,
  fetchTicketDetail,
  isSlaOverdue,
  isTicketTerminal,
  listTickets,
  resolveTicket,
  slaWindowLabel,
  type TicketDetailView,
  type TicketSlaStats,
  type TicketView,
} from './tickets';

// bun test 同进程串文件：隔离他文件残留的 env 基址与 token（lawyers.test.ts 同款形态）
beforeEach(() => {
  __resetClientForTest();
  setApiBaseUrl();
  delete process.env.VITE_API_BASE;
});

/** fetch 桩：捕获请求并回放固定响应（lawyers.test.ts 同款形态） */
function stubFetch(payload: unknown, status = 200): Array<{ url: string; init: RequestInit }> {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? ({} as RequestInit) });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return seen;
}

/** 工单行样本（core ops/ticket.types.ts TicketView 13 字段形状） */
const TICKET_FIXTURE: TicketView = {
  id: 12,
  category: 'reconciliation',
  ref_type: 'recon_period',
  ref_id: 202610,
  title: 'PAY-8812 回调金额与订单不一致',
  detail: '回调 88.99 ≠ 订单 89.00，初判渠道券承接',
  status: 'OPEN',
  priority: 3,
  sla_due: '2026-10-24T02:00:00.000Z',
  sla_overdue: true,
  assignee_id: null,
  created_at: '2026-10-23T02:00:00.000Z',
  resolved_at: null,
};

const DETAIL_FIXTURE: TicketDetailView = {
  ticket: { ...TICKET_FIXTURE, status: 'PROCESSING' },
  actions: [
    {
      id: 1,
      ticket_id: 12,
      action: 'start_processing',
      operator_id: 137,
      payload: { claimed_by_resolve: true },
      created_at: '2026-10-23T06:00:00.000Z',
    },
    {
      id: 2,
      ticket_id: 12,
      action: 'resolve',
      operator_id: 137,
      payload: { approved: true, action_payload: {} },
      created_at: '2026-10-23T07:00:00.000Z',
    },
  ],
};

describe('H3 纠纷工单 API 层（M3-W3 T3：/admin/tickets 五端点）', () => {
  it('listTickets：缺省=无查询串；category/status/limit 逐字透传 + Bearer 注入 + items 出参直通（sla_overdue 布尔数据位）', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({ items: [TICKET_FIXTURE] });
    const plain = await listTickets();
    expect(seen[0]?.url).toBe('/admin/tickets');
    expect(plain.items[0]?.sla_overdue).toBe(true);
    expect(plain.items[0]?.ref_id).toBe(202610);

    seen = stubFetch({ items: [] });
    await listTickets('dispute', 'OPEN', 50);
    expect(seen[0]?.url).toBe('/admin/tickets?category=dispute&status=OPEN&limit=50');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-admin');
  });

  it('fetchSlaStats：sla-stats 端点形态 + 出参三字段形状直通（by_category 仅未结类目）', async () => {
    setAccessToken('jwt-admin');
    const stats: TicketSlaStats = {
      open_total: 7,
      overdue_total: 2,
      by_category: {
        reconciliation: { open: 3, overdue: 2 },
        dispute: { open: 4, overdue: 0 },
      },
    };
    const seen = stubFetch(stats);
    const res = await fetchSlaStats();
    expect(seen[0]?.url).toBe('/admin/tickets/sla-stats');
    expect(res.overdue_total).toBe(2);
    expect(res.by_category.reconciliation?.open).toBe(3);
  });

  it('createTicket：POST /admin/tickets；请求体键 snake_case 且可选键缺省不发；幂等重放回包直通', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({ created: true, ticket_id: 12, status: 'OPEN' });
    const created = await createTicket({
      category: 'dispute',
      title: '用户申诉场次服务质量',
      detail: '申诉正文…',
    });
    expect(seen[0]?.url).toBe('/admin/tickets');
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      category: 'dispute',
      title: '用户申诉场次服务质量',
      detail: '申诉正文…',
    });
    expect(created.created).toBe(true);

    // 全字段体：ref 成对 + priority + assignee_id 逐键进体
    seen = stubFetch({ created: false, ticket_id: 12, status: 'OPEN' });
    const replay = await createTicket({
      category: 'reconciliation',
      title: '对账差异',
      detail: '差异明细',
      ref_type: 'recon_period',
      ref_id: 202610,
      priority: 5,
      assignee_id: 137,
    });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      category: 'reconciliation',
      title: '对账差异',
      detail: '差异明细',
      ref_type: 'recon_period',
      ref_id: 202610,
      priority: 5,
      assignee_id: 137,
    });
    expect(replay.created).toBe(false); // 幂等重放回原单
    expect(replay.ticket_id).toBe(12);
  });

  it('fetchTicketDetail：/:id 端点 + ticket 主行与 actions 审计行（payload 对象）直通', async () => {
    setAccessToken('jwt-admin');
    const seen = stubFetch(DETAIL_FIXTURE);
    const res = await fetchTicketDetail(12);
    expect(seen[0]?.url).toBe('/admin/tickets/12');
    expect(res.ticket.status).toBe('PROCESSING');
    expect(res.actions).toHaveLength(2);
    expect(res.actions[0]?.action).toBe('start_processing');
    expect(res.actions[1]?.payload.action_payload).toEqual({});
  });

  it('resolveTicket：无载荷体={approved}；携带 action_payload 时逐字段进体；端点 /resolve', async () => {
    setAccessToken('jwt-admin');
    let seen = stubFetch({ status: 'REJECTED' });
    await resolveTicket(12, { approved: false });
    expect(seen[0]?.url).toBe('/admin/tickets/12/resolve');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ approved: false });

    seen = stubFetch({ status: 'RESOLVED' });
    await resolveTicket(12, {
      approved: true,
      action_payload: { target: 'pricing', price_change_id: 88 },
    });
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      approved: true,
      action_payload: { target: 'pricing', price_change_id: 88 },
    });
  });

  it('错误归一：409 E_CONFLICT（终态 CLOSED）→ AdminApiError 透传 + 映射文案；非 401 不触发登出', async () => {
    setAccessToken('jwt-admin');
    stubFetch(
      { code: 'E_CONFLICT', message: '工单已关闭（CLOSED）：12 当前状态 RESOLVED，终态不可再处置' },
      409,
    );
    let caught: unknown;
    try {
      await resolveTicket(12, { approved: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdminApiError);
    const apiErr = caught as AdminApiError;
    expect(apiErr.code).toBe('E_CONFLICT');
    expect(apiErr.httpStatus).toBe(409);
    expect(apiErr.serverMessage).toContain('CLOSED');
    expect(apiErr.message).toContain('请刷新后重试');
    expect(getAccessToken()).toBe('jwt-admin'); // 409 非 401：不触发登出拦截
  });

  it('工单域在册错误码全覆盖（ticket.http/service 抛码实码 ⊆ KNOWN_SERVER_CODES 且映射表有文案）', () => {
    // parseCreateTicketBody/parseResolveTicketBody/parseTicketListQuery → 400；
    // resolveTicket 终态 → 409 E_CONFLICT；并发迁移 → 409 E_STATE_STALE_ENTITY；
    // 守卫非法迁移 → 409 E_STATE_ILLEGAL_TRANSITION；详情未知 → 404；兜底 → 500
    const ticketDomainCodes = [
      'E_INVALID_ARGUMENT',
      'E_NOT_FOUND',
      'E_CONFLICT',
      'E_STATE_STALE_ENTITY',
      'E_STATE_ILLEGAL_TRANSITION',
      'E_INTERNAL',
    ] as const;
    for (const code of ticketDomainCodes) {
      expect(KNOWN_SERVER_CODES.has(code)).toBe(true);
      expect(resolveApiErrorCopy(code)).not.toBe('操作失败，请稍后重试'); // 表内映射命中非兜底
    }
  });
});

describe('词汇与映射表（单源纪律：对照 core/shared 实码序）', () => {
  it('category 七值词汇与 @ljr/shared TICKET_CATEGORIES 实码序逐字一致；标签覆盖全集', () => {
    expect([...TICKET_CATEGORY_VALUES]).toEqual([
      'dispute',
      'refund_review',
      'price_change',
      'cancel_lt24h',
      'reconciliation',
      'dead_letter',
      'export_recording',
    ]);
    expect(TICKET_CATEGORY_LABELS.reconciliation).toBe('对账差异');
    expect(TICKET_CATEGORY_LABELS.cancel_lt24h).toBeDefined();
    for (const c of TICKET_CATEGORY_VALUES) {
      expect(TICKET_CATEGORY_LABELS[c].length).toBeGreaterThan(0);
    }
  });

  it('status 四值词汇与 core TICKET_STATUSES 实码序逐字一致；终态判定=RESOLVED/REJECTED', () => {
    expect([...TICKET_STATUS_VALUES]).toEqual(['OPEN', 'PROCESSING', 'RESOLVED', 'REJECTED']);
    expect(TICKET_STATUS_LABELS.OPEN).toBe('待处理');
    expect(TICKET_STATUS_LABELS.PROCESSING).toBe('处理中');
    expect(TICKET_STATUS_LABELS.RESOLVED).toBe('已办结');
    expect(TICKET_STATUS_LABELS.REJECTED).toBe('已驳回');
    expect(isTicketTerminal('RESOLVED')).toBe(true);
    expect(isTicketTerminal('REJECTED')).toBe(true);
    expect(isTicketTerminal('OPEN')).toBe(false);
    expect(isTicketTerminal('PROCESSING')).toBe(false);
  });

  it('SLA 窗口口径：reconciliation=24h 硬、其余六类=48h 软（H3 §2 / core slaMsForCategory）', () => {
    expect(slaWindowLabel('reconciliation')).toBe('24h（硬）');
    for (const c of TICKET_CATEGORY_VALUES.filter((c) => c !== 'reconciliation')) {
      expect(slaWindowLabel(c)).toBe('48h（软）');
    }
  });

  it('sla_overdue 展示判定：服务端数据位为真且非终态才亮；终态/数据位为假不亮（防御位）', () => {
    expect(isSlaOverdue({ status: 'OPEN', sla_overdue: true })).toBe(true);
    expect(isSlaOverdue({ status: 'PROCESSING', sla_overdue: true })).toBe(true);
    expect(isSlaOverdue({ status: 'RESOLVED', sla_overdue: true })).toBe(false); // 陈旧防御位
    expect(isSlaOverdue({ status: 'OPEN', sla_overdue: false })).toBe(false);
  });

  it('回调目标 idField 对照 ticket.callbacks 实码：pricing=price_change_id / d4=cancellation_id；已接线仅 pricing', () => {
    expect(RESOLVE_TARGET_ID_FIELDS.pricing).toBe('price_change_id');
    expect(RESOLVE_TARGET_ID_FIELDS.d4).toBe('cancellation_id');
    expect([...WIRED_RESOLVE_TARGETS]).toEqual(['pricing']);
  });
});

describe('建单请求体构造（对照 parseCreateTicketBody + assertCreateInput 实码规则）', () => {
  const BASE = {
    category: 'dispute',
    title: '用户申诉',
    detail: '申诉正文',
    refType: '',
    refId: '',
    priority: '',
    assigneeId: '',
  };

  it('合法最小体：仅必填三键（可选键缺省不发）；全字段体逐键数值化', () => {
    const min = buildCreateTicketBody(BASE);
    expect(min.ok).toBe(true);
    if (min.ok)
      expect(min.value).toEqual({ category: 'dispute', title: '用户申诉', detail: '申诉正文' });

    const full = buildCreateTicketBody({
      ...BASE,
      refType: 'session',
      refId: '2041',
      priority: '5',
      assigneeId: '137',
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.value).toEqual({
        category: 'dispute',
        title: '用户申诉',
        detail: '申诉正文',
        ref_type: 'session',
        ref_id: 2041,
        priority: 5,
        assignee_id: 137,
      });
    }
  });

  it('title/detail 边界：空白拒、128/4000 上界内过、超一字符拒；category 表外拒', () => {
    expect(buildCreateTicketBody({ ...BASE, title: '  ' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, title: 'a'.repeat(129) }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, title: 'a'.repeat(128) }).ok).toBe(true);
    expect(buildCreateTicketBody({ ...BASE, detail: ' ' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, detail: 'a'.repeat(4001) }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, detail: 'a'.repeat(4000) }).ok).toBe(true);
    expect(buildCreateTicketBody({ ...BASE, category: 'unknown' }).ok).toBe(false);
  });

  it('ref both-or-neither：只填一侧拒；ref_type 超 16 字符拒；ref_id 非正整数拒（0/小数/非数字）', () => {
    expect(buildCreateTicketBody({ ...BASE, refType: 'session' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, refId: '12' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, refType: 'x'.repeat(17), refId: '12' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, refType: 'session', refId: '0' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, refType: 'session', refId: '1.5' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, refType: 'session', refId: 'ab' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, refType: 'session', refId: '2041' }).ok).toBe(true);
  });

  it('priority 1-5 整数（缺省不发键）；assignee_id 正整数（缺省不发键）', () => {
    expect(buildCreateTicketBody({ ...BASE, priority: '0' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, priority: '6' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, priority: '3.5' }).ok).toBe(false);
    const p = buildCreateTicketBody({ ...BASE, priority: '5' });
    expect(p.ok && p.value.priority).toBe(5);
    expect(buildCreateTicketBody({ ...BASE, assigneeId: '0' }).ok).toBe(false);
    expect(buildCreateTicketBody({ ...BASE, assigneeId: '-3' }).ok).toBe(false);
    const a = buildCreateTicketBody({ ...BASE, assigneeId: '137' });
    expect(a.ok && a.value.assignee_id).toBe(137);
    const none = buildCreateTicketBody(BASE);
    expect(none.ok && none.value.priority).toBeUndefined();
    expect(none.ok && none.value.assignee_id).toBeUndefined();
  });
});

describe('resolve 载荷构造（对照 resolveTicket 实码：target 路由 + cancel_lt24h 强制回调）', () => {
  it('无 target → {approved} 纯记录处置；cancel_lt24h 例外必须带 target（core I-3）', () => {
    const plain = buildResolveTicketBody({
      approved: true,
      category: 'dispute',
      target: '',
      refId: '',
    });
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.value).toEqual({ approved: true });

    const cb = buildResolveTicketBody({
      approved: true,
      category: 'cancel_lt24h',
      target: '',
      refId: '',
    });
    expect(cb.ok).toBe(false);
    if (!cb.ok) expect(cb.error).toContain('cancel_lt24h');
  });

  it('target=pricing → action_payload={target, price_change_id}（数值化）；refId 缺失/非法拒', () => {
    const ok = buildResolveTicketBody({
      approved: true,
      category: 'price_change',
      target: 'pricing',
      refId: '88',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toEqual({
        approved: true,
        action_payload: { target: 'pricing', price_change_id: 88 },
      });
    }
    for (const bad of ['', '0', '8.8', 'x']) {
      const r = buildResolveTicketBody({
        approved: false,
        category: 'price_change',
        target: 'pricing',
        refId: bad,
      });
      expect(r.ok).toBe(false);
    }
  });

  it('target=d4 未接线（W2 T3 位）前端先拒；未知 target 拒', () => {
    const d4 = buildResolveTicketBody({
      approved: true,
      category: 'cancel_lt24h',
      target: 'd4',
      refId: '9',
    });
    expect(d4.ok).toBe(false);
    if (!d4.ok) expect(d4.error).toContain('未接线');
    const unknown = buildResolveTicketBody({
      approved: true,
      category: 'dispute',
      target: 'sms',
      refId: '1',
    });
    expect(unknown.ok).toBe(false);
  });
});
