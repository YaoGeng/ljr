/**
 * H3 纠纷工单页（M3-W3 T3，#/tickets）：SLA 统计条 + 工单列表 + 人工建单 +
 * 详情审计抽屉 + resolve 处置。
 *
 * 对照 prototype a-tickets（列表+筛选+详情+处置弹层的信息层级）与 core 实码契约：
 *   - 列表行=TicketView 实码 13 字段（无金额字段——原型金额列不虚构，禁发明）；
 *   - sla_overdue=服务端数据位（未结且过 SLA）→ 超期徽标=豆沙红极小面积铁律；
 *   - 幂等口径：建单=category+ref（无 ref 人工单无幂等锚 ⚠W2-9；重复提交防呆=提交中禁用
 *     + 幂等重放 created:false 如实提示）；处置=工单（终态 409 CLOSED → 横幅+刷新，T2 模式）；
 *   - resolve 的 action_payload.target=回调发起方路由词：仅 pricing 已接线（approved 时触发
 *     C6 改价审批回调真链=①期人工兜底凭据）；d4=W2 T3 接线位未注册（服务端 400）不提供入口；
 *     cancel_lt24h=回调承载类工单处置必须带 target（core I-3——前端防呆+服务端双层）；
 *   - 危险动作（approved=false 拒绝处置）二段确认门；状态/类目文案走映射表单源；
 *   - 三态齐全：列表与统计各自 loading/error/ok 如实承载，不假装数据。
 */
import { useCallback, useEffect, useState } from 'react';
// formatDateTime 复用 T2 单源（lawyers.ts 的 admin 通用 ISO 展示出口），勿再造副本
import { formatDateTime } from '../api/lawyers';
import { isAdminApiError } from '../api/client';
import {
  RESOLVE_TARGET_ID_FIELDS,
  TICKET_ACTION_LABELS,
  TICKET_CATEGORY_LABELS,
  TICKET_CATEGORY_VALUES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_VALUES,
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
  type CreateTicketResult,
  type TicketCategory,
  type TicketDetailView,
  type TicketSlaStats,
  type TicketStatus,
  type TicketView,
} from '../api/tickets';
import { IconRefresh } from '../components/icons';

/** 状态串 → tag 形态（橄榄绿系；驳回=红点缀极小面积；表外值灰防御位） */
const TICKET_STATUS_TAG_CLASS: Readonly<Record<string, string>> = {
  OPEN: 'tag', // 未结待办（最显眼）
  PROCESSING: 'tag gray',
  RESOLVED: 'tag gray',
  REJECTED: 'tag acc',
};

function statusLabel(status: string): string {
  return TICKET_STATUS_LABELS[status as TicketStatus] ?? status;
}

function categoryLabel(category: string): string {
  return TICKET_CATEGORY_LABELS[category as TicketCategory] ?? category;
}

/** 409 判定：终态 CLOSED（E_CONFLICT）+ 并发/守卫冲突（E_STATE_*）→ 横幅+刷新承载 */
function isResolveConflict(err: unknown): boolean {
  return (
    isAdminApiError(err) &&
    (err.code === 'E_CONFLICT' ||
      err.code === 'E_STATE_STALE_ENTITY' ||
      err.code === 'E_STATE_ILLEGAL_TRANSITION')
  );
}

/** 冲突横幅文案：服务端已关闭/并发明细优先（归一链第二源），映射表通用文案兜底 */
function conflictCopy(err: unknown): string {
  return isAdminApiError(err) ? (err.serverMessage ?? err.message) : '操作冲突，请刷新后重试';
}

function errorCopy(err: unknown): string {
  return isAdminApiError(err) ? err.message : '操作失败，请稍后重试';
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: { items: readonly TicketView[] } };

type StatsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: TicketSlaStats };

type Banner = { kind: 'error' | 'notice'; text: string } | null;

type Modal = { kind: 'create' } | { kind: 'resolve'; ticket: TicketView } | null;

/**
 * 动作统一收口（弹层调用）：成功 → notice 横幅+关弹层+刷新列表与统计；409 → error
 * 横幅+关弹层+刷新（冲突即数据已陈旧，强制对齐服务端）；其余错误 rethrow 由弹层就地内联。
 */
type RunAction = <T>(action: () => Promise<T>, successText: (result: T) => string) => Promise<void>;

export function TicketsPage() {
  const [categoryFilter, setCategoryFilter] = useState<TicketCategory | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | undefined>(undefined);
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [stats, setStats] = useState<StatsState>({ phase: 'loading' });
  const [banner, setBanner] = useState<Banner>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const loadList = useCallback(async (): Promise<void> => {
    setList({ phase: 'loading' });
    try {
      setList({ phase: 'ok', data: await listTickets(categoryFilter, statusFilter) });
    } catch (err) {
      // 401 由 client 统一拦截回登录页；此处只承载非 401 错误
      setList({ phase: 'error', message: errorCopy(err) });
    }
  }, [categoryFilter, statusFilter]);

  const loadStats = useCallback(async (): Promise<void> => {
    setStats({ phase: 'loading' });
    try {
      setStats({ phase: 'ok', data: await fetchSlaStats() });
    } catch (err) {
      setStats({ phase: 'error', message: errorCopy(err) });
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  /** 动作后刷新：列表与统计对齐（处置/建单都改变两侧数据面） */
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([loadList(), loadStats()]);
  }, [loadList, loadStats]);

  const runAction = useCallback<RunAction>(
    async (action, successText) => {
      try {
        const result = await action();
        setBanner({ kind: 'notice', text: successText(result) });
        setModal(null);
        await refresh();
      } catch (err) {
        if (isResolveConflict(err)) {
          setBanner({ kind: 'error', text: `${conflictCopy(err)}（列表已刷新）` });
          setModal(null);
          await refresh();
          return;
        }
        throw err;
      }
    },
    [refresh],
  );

  const data = list.phase === 'ok' ? list.data : null;

  return (
    <>
      <div className="ad-head">
        <div>
          <div className="h1">纠纷工单</div>
          <div className="sub">
            H3 处置面：SLA 对账差异 24h（硬·R-03）/ 其余 48h（软）· 幂等键：建单=category+ref、
            处置=工单（终态 409 CLOSED 不翻案）· 处置只透传决策，执行回调发起方（§9）
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-g btn-sm"
            onClick={() => setModal({ kind: 'create' })}
          >
            人工建单
          </button>
          <button
            type="button"
            className="btn btn-o btn-sm"
            onClick={() => void refresh()}
            disabled={list.phase === 'loading' && stats.phase === 'loading'}
          >
            <IconRefresh size={13} />
            刷新
          </button>
        </div>
      </div>

      {banner !== null ? (
        <div
          className={banner.kind === 'error' ? 'error-banner' : 'notice'}
          role={banner.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="grow">{banner.text}</span>
          <button
            type="button"
            className="banner-x"
            aria-label="关闭提示"
            onClick={() => setBanner(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      <SlaStatsBar state={stats} onRetry={() => void loadStats()} />

      <div className="row wrap" style={{ gap: 8 }}>
        <button
          type="button"
          className={`chip${categoryFilter === undefined ? ' on' : ''}`}
          aria-pressed={categoryFilter === undefined}
          onClick={() => setCategoryFilter(undefined)}
        >
          全部类目
        </button>
        {TICKET_CATEGORY_VALUES.map((c) => (
          <button
            key={c}
            type="button"
            className={`chip${categoryFilter === c ? ' on' : ''}`}
            aria-pressed={categoryFilter === c}
            onClick={() => setCategoryFilter(c)}
            title={c}
          >
            {TICKET_CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8, marginTop: -6 }}>
        <button
          type="button"
          className={`chip${statusFilter === undefined ? ' on' : ''}`}
          aria-pressed={statusFilter === undefined}
          onClick={() => setStatusFilter(undefined)}
        >
          全部状态
        </button>
        {TICKET_STATUS_VALUES.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip${statusFilter === s ? ' on' : ''}`}
            aria-pressed={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          >
            {TICKET_STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {list.phase === 'loading' ? (
        <div className="glass-card" style={{ padding: '36px 20px', textAlign: 'center' }}>
          <span className="muted">工单列表加载中…</span>
        </div>
      ) : null}

      {list.phase === 'error' ? (
        <div
          className="glass-card"
          style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="error-banner" role="alert">
            <span>列表加载失败：{list.message}</span>
          </div>
          <div>
            <button type="button" className="btn btn-g btn-sm" onClick={() => void loadList()}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {list.phase === 'ok' ? (
        data !== null && data.items.length === 0 ? (
          <div className="notice">
            <span>当前筛选下暂无工单。</span>
          </div>
        ) : (
          <div className="glass-card">
            <div className="tblwrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>工单</th>
                    <th>类目</th>
                    <th>关联</th>
                    <th>状态</th>
                    <th>SLA</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((item) => (
                    <tr
                      key={item.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setDetailId(item.id)}
                    >
                      <td>
                        <b>{item.title}</b>
                        <div className="tiny muted">
                          #{item.id} · P{item.priority}
                        </div>
                      </td>
                      <td>
                        <span className="tag gray">{categoryLabel(item.category)}</span>
                        <div className="tiny muted">{item.category}</div>
                      </td>
                      <td className="muted">
                        {item.ref_type !== null && item.ref_id !== null ? (
                          <>
                            {item.ref_type} <b>#{item.ref_id}</b>
                          </>
                        ) : (
                          '—（人工单）'
                        )}
                      </td>
                      <td>
                        <span className={TICKET_STATUS_TAG_CLASS[item.status] ?? 'tag gray'}>
                          {statusLabel(item.status)}
                        </span>
                      </td>
                      <td>
                        {isSlaOverdue(item) ? (
                          <span className="tag acc">超期</span>
                        ) : (
                          <span className="tag gray">SLA {slaWindowLabel(item.category)}</span>
                        )}
                        <div className="tiny muted">{formatDateTime(item.sla_due)}</div>
                      </td>
                      <td className="muted">{formatDateTime(item.created_at)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ gap: 6 }}>
                          {!isTicketTerminal(item.status) ? (
                            <button
                              type="button"
                              className="btn btn-o btn-xs"
                              onClick={() => setModal({ kind: 'resolve', ticket: item })}
                            >
                              处置
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setDetailId(item.id)}
                          >
                            详情
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagebar">
              <span className="tiny muted">
                新单在前（服务端 id DESC）· 超期=未结且已过 SLA（已决工单不计告警面）· SLA 锚=
                建单时刻 · 未结 dispute 工单挂起该场结算（R-04，F3 HOLD 闸）
              </span>
            </div>
          </div>
        )
      ) : null}

      {modal !== null && modal.kind === 'create' ? (
        <CreateTicketModal onClose={() => setModal(null)} runAction={runAction} />
      ) : null}
      {modal !== null && modal.kind === 'resolve' ? (
        <ResolveModal ticket={modal.ticket} onClose={() => setModal(null)} runAction={runAction} />
      ) : null}
      {detailId !== null ? (
        <TicketDetailDrawer
          key={detailId}
          ticketId={detailId}
          onClose={() => setDetailId(null)}
          onResolve={(ticket) => {
            setDetailId(null); // 处置弹层不叠抽屉之上：关抽屉开弹层
            setModal({ kind: 'resolve', ticket });
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// SLA 统计条（GET sla-stats：open/overdue 计数 + 分类计数横条——页顶数据条形态）
// ---------------------------------------------------------------------------

function SlaStatsBar(props: { state: StatsState; onRetry: () => void }) {
  const { state } = props;
  if (state.phase === 'loading') {
    return (
      <div className="glass-card" style={{ padding: '18px 16px', textAlign: 'center' }}>
        <span className="muted small">SLA 统计加载中…</span>
      </div>
    );
  }
  if (state.phase === 'error') {
    return (
      <div className="glass-card" style={{ padding: '14px 16px' }}>
        <div className="spread">
          <span className="small" style={{ color: 'var(--ljr-accent-dk)' }}>
            SLA 统计加载失败：{state.message}
          </span>
          <button type="button" className="btn btn-o btn-xs" onClick={props.onRetry}>
            重试
          </button>
        </div>
      </div>
    );
  }
  const entries = Object.entries(state.data.by_category).sort((a, b) => b[1].open - a[1].open);
  const maxOpen = Math.max(...entries.map(([, v]) => v.open), 1);
  return (
    <div className="glass-card" style={{ padding: '14px 16px' }}>
      <div className="spread">
        <div className="row" style={{ gap: 28 }}>
          <div>
            <div className="tiny muted">未结工单</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{state.data.open_total}</div>
          </div>
          <div>
            <div className="tiny muted">未结超期</div>
            <div
              className={state.data.overdue_total > 0 ? 'sla-danger' : undefined}
              style={{ fontSize: 22, fontWeight: 700 }}
            >
              {state.data.overdue_total}
            </div>
          </div>
        </div>
        <span className="tiny muted">
          SLA 口径：对账差异 24h（硬·R-03）/ 其余 48h（软）· 已决工单不计超期 ·
          分类计数仅列尚有未结工单的类目
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="small muted mt12">当前无未结工单。</div>
      ) : (
        <div className="mt12">
          {entries.map(([category, v]) => (
            <div key={category} className="spread" style={{ padding: '4px 0' }}>
              <span className="small" style={{ minWidth: 168, whiteSpace: 'nowrap' }}>
                {categoryLabel(category)} <span className="tiny muted">{category}</span>
              </span>
              <div className="grow" style={{ padding: '0 14px' }}>
                <div className="sla-track">
                  <div
                    className="sla-fill"
                    style={{ width: `${Math.round((v.open / maxOpen) * 100)}%` }}
                  />
                </div>
              </div>
              <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                未结 {v.open}
                {v.overdue > 0 ? <span className="sla-danger"> · 超期 {v.overdue}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 人工建单弹层（POST /admin/tickets：必填字段逐字对照 parseCreateTicketBody；
// 幂等键=category+ref 前端注记 + 提交中禁用防重复）
// ---------------------------------------------------------------------------

function CreateTicketModal(props: { onClose: () => void; runAction: RunAction }) {
  const { onClose, runAction } = props;
  const [category, setCategory] = useState<TicketCategory>('dispute');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [refType, setRefType] = useState('');
  const [refId, setRefId] = useState('');
  const [priority, setPriority] = useState('3');
  const [assigneeId, setAssigneeId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    // 前端防呆先行（不发请求）；服务端 parseCreateTicketBody+assertCreateInput 同规则兜底
    const built = buildCreateTicketBody({
      category,
      title,
      detail,
      refType,
      refId,
      priority,
      assigneeId,
    });
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    setSubmitting(true); // 幂等防呆：提交中禁用按钮（重复点击不发第二发）
    setError(null);
    try {
      await runAction(
        () => createTicket(built.value),
        (r: CreateTicketResult) =>
          r.created
            ? `工单 #${r.ticket_id} 已创建（${statusLabel(r.status)}）—— SLA ${slaWindowLabel(built.value.category)}`
            : `该 category+ref 工单已存在（幂等重放，不重复建单）→ 工单 #${r.ticket_id}（${statusLabel(r.status)}）`,
      );
    } catch (err) {
      setError(errorCopy(err)); // 非 409（409 已被 runAction 收口为横幅+刷新）
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" aria-label="人工建单">
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">人工建单</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="field">
          <label className="label" htmlFor="tk-category">
            类目（必填，七值词汇）
          </label>
          <select
            id="tk-category"
            className="input"
            value={category}
            disabled={submitting}
            onChange={(e) => setCategory(e.target.value as TicketCategory)}
          >
            {TICKET_CATEGORY_VALUES.map((c) => (
              <option key={c} value={c}>
                {TICKET_CATEGORY_LABELS[c]}（{c}）
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="tk-title">
            标题（必填，1-128 字）
          </label>
          <input
            id="tk-title"
            className={`input${formError !== null && title.trim() === '' ? ' invalid' : ''}`}
            value={title}
            disabled={submitting}
            placeholder="例：用户申诉场次服务质量"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="tk-detail">
            工单正文（必填，1-4000 字；禁填手机号/证件号等 PII）
          </label>
          <textarea
            id="tk-detail"
            className={`input textarea${formError !== null && detail.trim() === '' ? ' invalid' : ''}`}
            value={detail}
            disabled={submitting}
            placeholder="争议经过 / 触发事件载荷留档 / 处理线索…"
            onChange={(e) => setDetail(e.target.value)}
          />
        </div>

        <div className="row" style={{ gap: 10 }}>
          <div className="field grow">
            <label className="label" htmlFor="tk-reftype">
              关联类型 ref_type（可选）
            </label>
            <input
              id="tk-reftype"
              className="input"
              value={refType}
              disabled={submitting}
              placeholder="例：session / recon_period"
              onChange={(e) => setRefType(e.target.value)}
            />
          </div>
          <div className="field grow">
            <label className="label" htmlFor="tk-refid">
              关联 ID ref_id（可选，与 ref_type 成对）
            </label>
            <input
              id="tk-refid"
              className="input"
              value={refId}
              disabled={submitting}
              inputMode="numeric"
              placeholder="正整数"
              onChange={(e) => setRefId(e.target.value)}
            />
          </div>
        </div>

        <div className="row" style={{ gap: 10 }}>
          <div className="field grow">
            <label className="label" htmlFor="tk-priority">
              优先级 priority（1-5，缺省 3）
            </label>
            <select
              id="tk-priority"
              className="input"
              value={priority}
              disabled={submitting}
              onChange={(e) => setPriority(e.target.value)}
            >
              {['1', '2', '3', '4', '5'].map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          </div>
          <div className="field grow">
            <label className="label" htmlFor="tk-assignee">
              分派处理人 assignee_id（可选，正整数）
            </label>
            <input
              id="tk-assignee"
              className="input"
              value={assigneeId}
              disabled={submitting}
              inputMode="numeric"
              placeholder="运营用户 ID"
              onChange={(e) => setAssigneeId(e.target.value)}
            />
          </div>
        </div>

        {formError !== null ? <div className="field-error mb8">{formError}</div> : null}
        {error !== null ? (
          <div className="error-banner mt8" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        <div className="row mt12" style={{ gap: 12 }}>
          <button type="button" className="btn btn-o grow" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-g grow"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? '提交中…' : '创建工单（OPEN）'}
          </button>
        </div>
        <div className="tiny muted mt8">
          幂等键=category+ref（两者齐备才生效）：同键重复提交服务端幂等重放返回原单
          （created:false），不重复建单；无 ref 人工单无幂等锚（⚠W2-9）。SLA
          按类目自动起算：对账差异 24h（硬）/ 其余 48h（软）。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 处置弹层（POST /admin/tickets/:id/resolve：approved 二选 + action_payload 可选回调）
// ---------------------------------------------------------------------------

function ResolveModal(props: { ticket: TicketView; onClose: () => void; runAction: RunAction }) {
  const { ticket, onClose, runAction } = props;
  const [approved, setApproved] = useState(true);
  const [target, setTarget] = useState('');
  const [refId, setRefId] = useState('');
  const [armed, setArmed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = buildResolveTicketBody({ approved, category: ticket.category, target, refId });

  async function submit(): Promise<void> {
    // 前端防呆先行；服务端 parseResolveTicketBody + resolveTicket 同规则兜底（双层）
    if (!validation.ok) {
      setFormError(validation.error);
      return;
    }
    setFormError(null);
    if (!approved && !armed) {
      setArmed(true); // 危险动作二段确认门：拒绝处置（终态 REJECTED 不可翻案）
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await runAction(
        () => resolveTicket(ticket.id, validation.value),
        (r) =>
          `工单 #${ticket.id} ${statusLabel(r.status)}（终态不可再处置）${
            target === 'pricing'
              ? '；已触发 pricing 改价审批回调（C6 ①期人工兜底，approved 透传）'
              : ''
          }`,
      );
    } catch (err) {
      setError(errorCopy(err)); // 非 409（409 已被 runAction 收口为横幅+刷新）
    } finally {
      setSubmitting(false);
      setArmed(false);
    }
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" aria-label={`工单处置 #${ticket.id}`}>
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">工单处置 · #{ticket.id}</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="glass-card" style={{ padding: '12px 14px' }}>
          <div className="spread">
            <span className={TICKET_STATUS_TAG_CLASS[ticket.status] ?? 'tag gray'}>
              {statusLabel(ticket.status)}
            </span>
            <span className="tiny muted">
              {categoryLabel(ticket.category)} · P{ticket.priority} · SLA{' '}
              {slaWindowLabel(ticket.category)}
            </span>
          </div>
          <div className="small mt4">{ticket.title}</div>
          <div className="tiny muted mt4">
            创建于 {formatDateTime(ticket.created_at)} · SLA 截止 {formatDateTime(ticket.sla_due)}
            {isSlaOverdue(ticket) ? '（已超期）' : ''}
          </div>
        </div>

        {ticket.category === 'cancel_lt24h' ? (
          <div className="notice acc mt12" role="alert">
            <span>
              回调承载类工单（cancel_lt24h）：处置必须携带 action_payload.target——缺省将被服务端
              拒绝（防「审批通过而取消流未生效」）。当前已接线回调仅 pricing；d4 取消流=W2 T3
              接线位。
            </span>
          </div>
        ) : null}

        <fieldset className="field mt12" style={{ border: 0, padding: 0, marginInline: 0 }}>
          <legend className="label">处置决策（approved——终态不可翻案，幂等键=工单）</legend>
          <div className="action-list">
            <label
              className={`action-opt${approved ? ' on' : ''}`}
              onClick={() => setApproved(true)}
            >
              <input
                type="radio"
                name="resolve-approved"
                checked={approved}
                onChange={() => setApproved(true)}
              />
              <span className="grow">
                <b className="small">同意办结</b>
                <code className="tiny muted"> approved=true</code>
                <div className="tiny muted">
                  → RESOLVED：处置成立并办结；携带 pricing 回调时同步触发 C6 改价审批
                </div>
              </span>
            </label>
            <label
              className={`action-opt${!approved ? ' on' : ''}${!approved ? ' danger' : ''}`}
              onClick={() => {
                setApproved(false);
                setArmed(false); // 切决策重置确认门
              }}
            >
              <input
                type="radio"
                name="resolve-approved"
                checked={!approved}
                onChange={() => {
                  setApproved(false);
                  setArmed(false);
                }}
              />
              <span className="grow">
                <b className="small">驳回处置</b>
                <code className="tiny muted"> approved=false</code>
                <div className="tiny muted">→ REJECTED：拒绝处置（终态）；需二次确认</div>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="field">
          <label className="label" htmlFor="tk-target">
            回调目标 action_payload.target（可选——携带时处置同时回调发起方）
          </label>
          <select
            id="tk-target"
            className="input"
            value={target}
            disabled={submitting}
            onChange={(e) => {
              setTarget(e.target.value);
              if (armed) setArmed(false);
            }}
          >
            <option value="">不携带（纯记录处置，不带 action_payload）</option>
            <option value="pricing">pricing（改价审批回调 · 已接线）</option>
          </select>
          {target === 'pricing' ? (
            <div className="field mt8" style={{ marginBottom: 0 }}>
              <label className="label" htmlFor="tk-ref-id">
                {RESOLVE_TARGET_ID_FIELDS.pricing}（必填，正整数）
              </label>
              <input
                id="tk-ref-id"
                className="input"
                value={refId}
                disabled={submitting}
                inputMode="numeric"
                placeholder="改价历史记录 ID"
                onChange={(e) => {
                  setRefId(e.target.value);
                  if (armed) setArmed(false);
                }}
              />
            </div>
          ) : null}
          <div className="tiny muted mt4">
            target=pricing：approved 决策透传至 POST /pricing/change/:id/approve（C6 审批回调
            真链，目标侧幂等）；d4 取消流回调未接线（W2 T3 位，服务端对未注册 target 显式
            400），本页不提供入口。
          </div>
        </div>

        {formError !== null ? <div className="field-error mb8">{formError}</div> : null}
        {error !== null ? (
          <div className="error-banner mt8" role="alert">
            <span>{error}</span>
          </div>
        ) : null}

        <div className="row mt12" style={{ gap: 12 }}>
          <button type="button" className="btn btn-o grow" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className={`btn grow ${approved ? 'btn-g' : 'btn-danger-o'}`}
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting
              ? '提交中…'
              : armed
                ? '确认驳回（再次点击提交）'
                : approved
                  ? '同意办结'
                  : '驳回处置'}
          </button>
        </div>
        <div className="tiny muted mt8">
          处置状态机 OPEN→PROCESSING→RESOLVED/REJECTED（OPEN 直接处置自动认领）· 终态重放 → 409
          CLOSED（幂等键=工单，不翻案）· 全部处置入 ticket_actions 审计（who/when/what）·
          工单只透传决策，不内嵌资损规则（H3 §9）。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 详情抽屉（GET /admin/tickets/:id：工单字段全量 + ticket_actions 审计时间线）
// ---------------------------------------------------------------------------

function TicketDetailDrawer(props: {
  ticketId: number;
  onClose: () => void;
  onResolve: (ticket: TicketView) => void;
}) {
  const { ticketId, onClose, onResolve } = props;
  const [loaded, setLoaded] = useState<TicketDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 父级按 ticketId 挂 key（换行点击=重新挂载）；effect 依赖 ticketId 防重取兜底
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    fetchTicketDetail(ticketId)
      .then((data) => {
        if (!cancelled) setLoaded(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorCopy(err)); // 404 未知工单=如实承载错误态
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const t = loaded?.ticket;

  return (
    <div
      className="mask right"
      role="dialog"
      aria-modal="true"
      aria-label={`工单详情 #${ticketId}`}
    >
      <div className="drawer">
        <div className="spread mb16">
          <span className="h2">工单详情 · #{ticketId}</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {loaded === null && error === null ? <div className="muted small">详情加载中…</div> : null}
        {error !== null ? (
          <div className="glass-card" style={{ padding: 20 }}>
            <div className="error-banner" role="alert">
              <span>详情加载失败：{error}</span>
            </div>
            <div className="tiny muted mt8">404 = 工单不存在（ticket_id 无对应行）。</div>
          </div>
        ) : null}

        {loaded !== null && t !== undefined ? (
          <>
            <div className="glass-card" style={{ padding: '14px 16px' }}>
              <div className="spread">
                <span className={TICKET_STATUS_TAG_CLASS[t.status] ?? 'tag gray'}>
                  {statusLabel(t.status)}
                </span>
                <span className="tiny muted">
                  {categoryLabel(t.category)}（{t.category}）· P{t.priority}
                </span>
              </div>
              <div className="h3 mt8">{t.title}</div>
              <div className="hr-soft" />
              {(
                [
                  ['工单号', `#${t.id}`],
                  [
                    '关联实体',
                    t.ref_type !== null && t.ref_id !== null
                      ? `${t.ref_type} #${t.ref_id}`
                      : '—（人工单，无幂等锚）',
                  ],
                  [
                    'SLA 截止',
                    `${formatDateTime(t.sla_due)} · ${slaWindowLabel(t.category)}${isSlaOverdue(t) ? ' · 已超期' : ''}`,
                  ],
                  ['处理人', t.assignee_id === null ? '—（未认领）' : `#${t.assignee_id}`],
                  ['创建时间', formatDateTime(t.created_at)],
                  ['办结时间', formatDateTime(t.resolved_at)],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k} className="spread" style={{ padding: '5px 0' }}>
                  <span className="small muted">{k}</span>
                  <span className="small">{v}</span>
                </div>
              ))}
              <div className="hr-soft" />
              <div className="small muted mb8">工单正文</div>
              <div className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {t.detail}
              </div>
            </div>

            <div className="glass-card mt12" style={{ padding: '14px 16px' }}>
              <div className="spread mb8">
                <span className="h3">处置审计（ticket_actions）</span>
                <span className="tiny muted">{loaded.actions.length} 条</span>
              </div>
              {loaded.actions.length === 0 ? (
                <div className="small muted">
                  暂无处置记录（建单非流转不落审计——首次处置时自动认领并逐迁移记录）。
                </div>
              ) : (
                <div>
                  {loaded.actions.map((a) => (
                    <div key={a.id} className="tl-item">
                      <span className="tl-dot" />
                      <div className="grow">
                        <div className="spread">
                          <span className="small">
                            <b>{TICKET_ACTION_LABELS[a.action] ?? a.action}</b>
                          </span>
                          <span className="tiny muted">{formatDateTime(a.created_at)}</span>
                        </div>
                        <div className="tiny muted">
                          操作人 #{a.operator_id}
                          {Object.keys(a.payload).length > 0 ? (
                            <>
                              {' · '}
                              <code>{JSON.stringify(a.payload)}</code>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!isTicketTerminal(t.status) ? (
              <button type="button" className="btn btn-g btn-lg mt16" onClick={() => onResolve(t)}>
                处置该工单
              </button>
            ) : (
              <div className="notice mt12">
                <span>
                  工单已终态（{statusLabel(t.status)}）：不可再处置（409 CLOSED 幂等守卫，不翻案）。
                </span>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
