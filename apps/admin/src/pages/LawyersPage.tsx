/**
 * H1 律师与资质审核页（M3-W3 T2，#/lawyers）：入驻审核工作台。
 *
 * 对照 prototype a-lawyers（列表+审核弹层+档案抽屉的信息层级）与 core 实码契约：
 *   - 列表出参无姓名/手机号（A3a 出站 PII 红线）——以档案 id/律师用户 id/律所定位，禁发明；
 *   - SLA 剩余数据位 R-01（3 工作日）醒目展示，超期=豆沙红危险态（极小面积铁律）；
 *   - audit 动作按状态可达集裁剪（lawyer.machine 八边：SUBMITTED=[claim]、
 *     IN_REVIEW=[approve,reject]——T8 死动作裁剪，表源 lawyers.ts 头注核差注记）；
 *     reject/suspend 事由=前端防呆 +服务端校验双层；409 状态冲突 → 屏顶横幅 + 列表刷新；
 *   - 危险动作（reject/suspend）确认门=二段式按钮（首次点击进入 armed 态，二次点击才提交；
 *     W2 危险确认先例的 Web 后台形态）；
 *   - 档案聚合 GET :id/profile 按 LawyerProfileAdminView 实码分四节（A3a/A3b/G1/C1），
 *     404 未审/未知如实承载错误态；from/to 窗口参数本卡缺省（服务端缺省近 30 天）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  LAWYER_AUDIT_ACTIONS_BY_STATUS,
  LAWYER_AUDIT_ACTION_LABELS,
  LAWYER_STATUS_LABELS,
  MERCHANT_STATUS_LABELS,
  WORKBENCH_FILTERS,
  auditLawyer,
  fetchLawyerProfile,
  formatDateTime,
  formatRate,
  formatSlaRemaining,
  listLawyers,
  resumeLawyer,
  suspendLawyer,
  validateAuditReason,
  validateSuspendReason,
  type LawyerAuditAction,
  type LawyerProfileAdminView,
  type WorkbenchItem,
  type WorkbenchListResult,
  type WorkbenchStatus,
} from '../api/lawyers';
import { isAdminApiError } from '../api/client';
import { IconRefresh } from '../components/icons';

/** 状态串 → 展示 tag 形态（橄榄绿系为主；驳回/停用=红点缀极小面积） */
function statusTagClass(status: string): string {
  if (status === 'PASSED' || status === 'IN_REVIEW') return 'tag';
  if (status === 'REJECTED' || status === 'SUSPENDED') return 'tag acc';
  return 'tag gray'; // SUBMITTED（及表外防御位）
}

/** 状态串 → 中文（映射表单源；表外值原样透传不吞不造） */
function statusLabel(status: string): string {
  return LAWYER_STATUS_LABELS[status as keyof typeof LAWYER_STATUS_LABELS] ?? status;
}

/** 409 状态冲突判定（E_STATE_ILLEGAL_TRANSITION / E_STATE_STALE_ENTITY → 横幅+刷新承载） */
function isStateConflict(err: unknown): boolean {
  return (
    isAdminApiError(err) &&
    (err.code === 'E_STATE_ILLEGAL_TRANSITION' || err.code === 'E_STATE_STALE_ENTITY')
  );
}

function errorCopy(err: unknown): string {
  return isAdminApiError(err) ? err.message : '操作失败，请稍后重试';
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: WorkbenchListResult };

type Banner = { kind: 'error' | 'notice'; text: string } | null;

/** 行级弹层：审核动作（五枚）/ 停用（专端点，事由必填）/ 恢复（专端点，二次确认） */
type Modal =
  | { kind: 'audit'; item: WorkbenchItem }
  | { kind: 'suspend'; item: WorkbenchItem }
  | { kind: 'resume'; item: WorkbenchItem }
  | null;

/** 动作统一收口（弹层调用）：成功 → notice 横幅+关弹层+刷新；409 → error 横幅+关弹层+刷新；
 *  其余错误 rethrow 由弹层就地内联展示（不上横幅）。 */
type RunAction = (action: () => Promise<{ status: string }>, successText: string) => Promise<void>;

export function LawyersPage() {
  const [filter, setFilter] = useState<WorkbenchStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [banner, setBanner] = useState<Banner>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [drawerItem, setDrawerItem] = useState<WorkbenchItem | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setList({ phase: 'loading' });
    try {
      const data = await listLawyers(filter, page);
      // 末页清空孤岛钳制：请求页超出实际末页（末条被处置后行数收缩/筛选切换残留陈旧页码）
      // → 钳回实际末页重载（page 变化经 effect 依赖自动触发）；第 1 页空=正常空态不进此
      // 分支（total=0 时钳制值 Math.max(1, …)=1 与当前页相同不重载，无循环）
      if (data.items.length === 0 && data.page > 1) {
        setPage(Math.max(1, Math.ceil(data.total / Math.max(1, data.page_size))));
        return;
      }
      setList({ phase: 'ok', data });
    } catch (err) {
      // 401 由 client 统一拦截回登录页；此处只承载非 401 错误
      setList({ phase: 'error', message: errorCopy(err) });
    }
  }, [filter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function switchFilter(next: WorkbenchStatus | undefined): void {
    setFilter(next);
    setPage(1); // 切筛选回第 1 页（分页语义单源）
  }

  const runAction = useCallback<RunAction>(
    async (action, successText) => {
      try {
        const result = await action();
        setBanner({
          kind: 'notice',
          text: `${successText} · 档案状态 → ${statusLabel(result.status)}（已入审计日志）`,
        });
        setModal(null);
        await load(); // 成功后列表与真实状态对齐
      } catch (err) {
        if (isStateConflict(err)) {
          setBanner({ kind: 'error', text: errorCopy(err) });
          setModal(null);
          await load(); // 冲突即列表已陈旧，强制对齐服务端
          return;
        }
        throw err;
      }
    },
    [load],
  );

  const data = list.phase === 'ok' ? list.data : null;
  const totalPages =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / Math.max(1, data.page_size)));

  return (
    <>
      <div className="ad-head">
        <div>
          <div className="h1">律师与资质审核</div>
          <div className="sub">
            入驻审核 SLA 3 个工作日（R-01）· 状态机归 A3a，本页编排 + 全操作审计（H9）· 列表以档案
            ID 定位（出参不含姓名/手机号——A3a 出站口径）
          </div>
        </div>
        <button
          type="button"
          className="btn btn-o btn-sm"
          onClick={() => void load()}
          disabled={list.phase === 'loading'}
        >
          <IconRefresh size={13} />
          刷新
        </button>
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

      <div className="row wrap" style={{ gap: 8 }}>
        {WORKBENCH_FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            className={`chip${filter === f.status ? ' on' : ''}`}
            aria-pressed={filter === f.status}
            onClick={() => switchFilter(f.status)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.phase === 'loading' ? (
        <div className="glass-card" style={{ padding: '36px 20px', textAlign: 'center' }}>
          <span className="muted">工作台加载中…</span>
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
            <button type="button" className="btn btn-g btn-sm" onClick={() => void load()}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {list.phase === 'ok' ? (
        data !== null && data.items.length === 0 ? (
          <div className="notice">
            <span>当前筛选下暂无记录。</span>
          </div>
        ) : (
          <div className="glass-card">
            <div className="tblwrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>档案 / 律师用户</th>
                    <th>律所</th>
                    <th>材料版本</th>
                    <th>提交时间</th>
                    <th>SLA 剩余（R-01）</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((item) => (
                    <tr
                      key={item.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setDrawerItem(item)}
                    >
                      <td>
                        <b>#{item.id}</b>
                        <div className="tiny muted">用户 {item.lawyer_user_id}</div>
                      </td>
                      <td className="muted">{item.firm_name ?? '—'}</td>
                      <td className="muted">v{item.material_version}</td>
                      <td className="muted">{formatDateTime(item.submitted_at)}</td>
                      <td>
                        {item.sla_remaining_ms === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <span className={item.sla_overdue ? 'sla-danger' : 'sla-ok'}>
                            {formatSlaRemaining(item.sla_remaining_ms)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={statusTagClass(item.audit_status)}>
                          {statusLabel(item.audit_status)}
                        </span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ gap: 6 }}>
                          {item.audit_status === 'SUBMITTED' ||
                          item.audit_status === 'IN_REVIEW' ? (
                            <button
                              type="button"
                              className="btn btn-o btn-xs"
                              onClick={() => setModal({ kind: 'audit', item })}
                            >
                              审核
                            </button>
                          ) : null}
                          {item.audit_status === 'PASSED' ? (
                            <button
                              type="button"
                              className="btn btn-danger-o btn-xs"
                              onClick={() => setModal({ kind: 'suspend', item })}
                            >
                              停用
                            </button>
                          ) : null}
                          {item.audit_status === 'SUSPENDED' ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs"
                              onClick={() => setModal({ kind: 'resume', item })}
                            >
                              恢复
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setDrawerItem(item)}
                          >
                            档案
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagebar">
              <button
                type="button"
                className="btn btn-o btn-sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <span className="tiny muted">
                第 {page} / {totalPages} 页 · 共 {data?.total ?? 0} 条 · 每页{' '}
                {data?.page_size ?? 20} 条 · 提交时间升序（最久在审在前）
              </span>
              <button
                type="button"
                className="btn btn-o btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )
      ) : null}

      {modal !== null && modal.kind === 'audit' ? (
        <AuditModal item={modal.item} onClose={() => setModal(null)} runAction={runAction} />
      ) : null}
      {modal !== null && modal.kind === 'suspend' ? (
        <SuspendModal item={modal.item} onClose={() => setModal(null)} runAction={runAction} />
      ) : null}
      {modal !== null && modal.kind === 'resume' ? (
        <ResumeModal item={modal.item} onClose={() => setModal(null)} runAction={runAction} />
      ) : null}
      {drawerItem !== null ? (
        <ProfileDrawer key={drawerItem.id} item={drawerItem} onClose={() => setDrawerItem(null)} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 审核动作弹层（五枚词汇 + 事由防呆 + 危险二段确认）
// ---------------------------------------------------------------------------

function AuditModal(props: { item: WorkbenchItem; onClose: () => void; runAction: RunAction }) {
  const { item, onClose, runAction } = props;
  // 当前状态可达动作集（lawyer.machine 八边裁剪，T8）：弹层只对 SUBMITTED|IN_REVIEW 行开，
  // 表外终态=空数组防御位（理论不可达）；死动作（claim 于 IN_REVIEW / suspend / resume 等）
  // 不再渲染，误触非法组合仍有服务端 409 横幅+强制刷新兜底
  const legalActions: readonly LawyerAuditAction[] =
    item.audit_status === 'SUBMITTED' || item.audit_status === 'IN_REVIEW'
      ? LAWYER_AUDIT_ACTIONS_BY_STATUS[item.audit_status]
      : [];
  const [action, setAction] = useState<LawyerAuditAction>(legalActions[0]!);
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [showError, setShowError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = LAWYER_AUDIT_ACTION_LABELS[action];
  const needsReason = action === 'reject' || action === 'suspend';
  const validation = validateAuditReason(action, reason);

  function pick(next: LawyerAuditAction): void {
    setAction(next);
    setArmed(false); // 切动作重置确认门
    setShowError(false);
  }

  async function submit(): Promise<void> {
    // 前端防呆先行（不发请求）；服务端 parseAuditActionBody 同规则兜底（双层）
    if (!validation.ok) {
      setShowError(true);
      return;
    }
    if (meta.danger && !armed) {
      setArmed(true); // 危险动作二段确认门：首次点击只进入 armed 态
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await runAction(
        () => auditLawyer(item.id, action, needsReason ? reason : undefined),
        `已执行「${meta.label}」（档案 #${item.id}）`,
      );
    } catch (err) {
      setError(errorCopy(err)); // 非 409（409 已被 runAction 收口为横幅+刷新）
    } finally {
      setSubmitting(false);
      setArmed(false);
    }
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" aria-label={`资质审核 档案 #${item.id}`}>
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">资质审核 · 档案 #{item.id}</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="glass-card" style={{ padding: '12px 14px' }}>
          <div className="spread">
            <span className={statusTagClass(item.audit_status)}>
              {statusLabel(item.audit_status)}
            </span>
            <span className="small muted">
              律师用户 {item.lawyer_user_id} · {item.firm_name ?? '未登记律所'} · v
              {item.material_version}
            </span>
          </div>
          <div className="tiny muted mt4">
            提交于 {formatDateTime(item.submitted_at)} · SLA{' '}
            {formatSlaRemaining(item.sla_remaining_ms)}
          </div>
        </div>

        <fieldset className="field mt12" style={{ border: 0, padding: 0, marginInline: 0 }}>
          <legend className="label">审核动作（= 当前状态可达词汇，lawyer.machine 八边裁剪）</legend>
          <div className="action-list">
            {legalActions.map((a) => {
              const m = LAWYER_AUDIT_ACTION_LABELS[a];
              const checked = action === a;
              return (
                <label
                  key={a}
                  className={`action-opt${checked ? ' on' : ''}${m.danger ? ' danger' : ''}`}
                >
                  <input
                    type="radio"
                    name="audit-action"
                    value={a}
                    checked={checked}
                    onChange={() => pick(a)}
                  />
                  <span className="grow">
                    <b className="small">{m.label}</b>
                    <code className="tiny muted"> {a}</code>
                    <div className="tiny muted">{m.note}</div>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {needsReason ? (
          <div className="field">
            <label className="label" htmlFor="audit-reason">
              {action === 'reject'
                ? '拒绝事由（必填，本人可见，可补充材料重提）'
                : '停用事由（必填，事件载荷携带）'}
            </label>
            <textarea
              id="audit-reason"
              className={`input textarea${showError && !validation.ok ? ' invalid' : ''}`}
              value={reason}
              disabled={submitting}
              placeholder={
                action === 'reject'
                  ? '说明驳回原因与需补充的材料…（1-1000 字）'
                  : '说明停用原因…（1-256 字）'
              }
              onChange={(e) => {
                setReason(e.target.value);
                if (armed) setArmed(false);
              }}
            />
            {showError && !validation.ok ? (
              <div className="field-error">{validation.error}</div>
            ) : null}
          </div>
        ) : null}

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
            className={`btn grow ${meta.danger ? 'btn-danger-o' : 'btn-g'}`}
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting
              ? '提交中…'
              : armed
                ? `确认执行「${meta.label}」（再次点击提交）`
                : meta.label}
          </button>
        </div>
        <div className="tiny muted mt8">
          动作合法性由服务端状态机守卫兜底（非法迁移 409
          透传→屏顶横幅+列表刷新）；通过/停用发领域事件联动 C3
          可见性与在途场次；全部动作入审计日志（who/when/what）。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 停用确认弹层（专端点 /suspend：reason 必填 + 危险二段确认）
// ---------------------------------------------------------------------------

function SuspendModal(props: { item: WorkbenchItem; onClose: () => void; runAction: RunAction }) {
  const { item, onClose, runAction } = props;
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [showError, setShowError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validation = validateSuspendReason(reason);

  async function submit(): Promise<void> {
    if (!validation.ok) {
      setShowError(true);
      return;
    }
    if (!armed) {
      setArmed(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await runAction(() => suspendLawyer(item.id, reason), `已停用档案 #${item.id}`);
    } catch (err) {
      setError(errorCopy(err));
    } finally {
      setSubmitting(false);
      setArmed(false);
    }
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" aria-label={`停用律师档案 #${item.id}`}>
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">停用律师 · 档案 #{item.id}</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="notice acc" role="alert">
          <span>
            停用将发 LawyerSuspended：公开列表立即隐藏、在途场次收到影响通知（恢复可再经
            resume）。律师用户 {item.lawyer_user_id} · {item.firm_name ?? '未登记律所'}。
          </span>
        </div>
        <div className="field mt12">
          <label className="label" htmlFor="suspend-reason">
            停用事由（必填，1-256 字）
          </label>
          <textarea
            id="suspend-reason"
            className={`input textarea${showError && !validation.ok ? ' invalid' : ''}`}
            value={reason}
            disabled={submitting}
            placeholder="说明停用原因（例：资质材料存疑，待复核…）"
            onChange={(e) => {
              setReason(e.target.value);
              if (armed) setArmed(false);
            }}
          />
          {showError && !validation.ok ? (
            <div className="field-error">{validation.error}</div>
          ) : null}
        </div>
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
            className="btn btn-danger-o grow"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? '提交中…' : armed ? '确认停用（再次点击提交）' : '停用'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 恢复确认弹层（专端点 /resume：二次确认，无事由）
// ---------------------------------------------------------------------------

function ResumeModal(props: { item: WorkbenchItem; onClose: () => void; runAction: RunAction }) {
  const { item, onClose, runAction } = props;
  const [armed, setArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!armed) {
      setArmed(true); // 二次确认门
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await runAction(() => resumeLawyer(item.id), `已恢复档案 #${item.id}`);
    } catch (err) {
      setError(errorCopy(err));
    } finally {
      setSubmitting(false);
      setArmed(false);
    }
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" aria-label={`恢复律师档案 #${item.id}`}>
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">恢复律师 · 档案 #{item.id}</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="notice">
          <span>
            将把档案从「已停用」恢复为「已通过」（SUSPENDED →
            PASSED，不发事件），公开列表可见性随之恢复。 律师用户 {item.lawyer_user_id} ·{' '}
            {item.firm_name ?? '未登记律所'}。
          </span>
        </div>
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
            {submitting ? '提交中…' : armed ? '确认恢复（再次点击提交）' : '恢复'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 档案聚合抽屉（GET :id/profile 四节：A3a 资质 / A3b 进件 / G1 信用 / C1 服务面）
// ---------------------------------------------------------------------------

function ProfileDrawer(props: { item: WorkbenchItem; onClose: () => void }) {
  const { item, onClose } = props;
  const [loaded, setLoaded] = useState<LawyerProfileAdminView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 父级按 item.id 挂 key（换行点击=重新挂载）；effect 依赖 item.id 防重取兜底
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    fetchLawyerProfile(item.id)
      .then((data) => {
        if (!cancelled) setLoaded(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorCopy(err)); // 404 未审/未知=如实承载（文案走映射表）
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  const q = loaded?.qualification;

  return (
    <div className="mask right" role="dialog" aria-modal="true" aria-label={`律师档案 #${item.id}`}>
      <div className="drawer">
        <div className="spread mb16">
          <span className="h2">律师档案 · #{item.id}</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {loaded === null && error === null ? (
          <div className="muted small">档案聚合加载中…（A3a + A3b + G1 + C1）</div>
        ) : null}
        {error !== null ? (
          <div className="glass-card" style={{ padding: 20 }}>
            <div className="error-banner" role="alert">
              <span>档案加载失败：{error}</span>
            </div>
            <div className="tiny muted mt8">404 = 档案不存在（未提交资质材料的律师无档案行）。</div>
          </div>
        ) : null}

        {loaded !== null && q !== undefined ? (
          <>
            <div className="glass-card" style={{ padding: '14px 16px' }}>
              <div className="spread">
                <span className="h3">资质审核（A3a）</span>
                <span className={statusTagClass(q.audit_status)}>
                  {statusLabel(q.audit_status)}
                </span>
              </div>
              <div className="hr-soft" />
              {(
                [
                  ['律师用户', `#${q.lawyer_user_id}`],
                  ['律所', q.firm_name ?? '—'],
                  ['律所 ID（进件回填）', q.firm_id === null ? '未绑定' : `#${q.firm_id}`],
                  ['执业城市', q.city],
                  ['材料版本', `v${q.material_version}`],
                  ['提交时间', formatDateTime(q.submitted_at)],
                  ['审核时刻', formatDateTime(q.audited_at)],
                  ['审核人', q.auditor_id === null ? '—（历史行）' : `#${q.auditor_id}`],
                ] as [string, string][]
              )
                .concat(
                  q.reject_reason !== undefined && q.reject_reason !== null
                    ? [['拒绝事由', q.reject_reason]]
                    : [],
                )
                .map(([k, v]) => (
                  <div key={k} className="spread" style={{ padding: '5px 0' }}>
                    <span className="small muted">{k}</span>
                    <span className="small">{v}</span>
                  </div>
                ))}
              <div className="tiny muted mt8">
                执业证号列加密存储，本视图不出证明文（PII 红线）。
              </div>
            </div>

            <div className="glass-card mt12" style={{ padding: '14px 16px' }}>
              <div className="spread">
                <span className="h3">进件 / 对公（A3b）</span>
                <span className="tiny muted">{loaded.merchants.length} 条通道记录</span>
              </div>
              {loaded.merchants.length === 0 ? (
                <div className="small muted mt8">
                  未进件（无 A3b 商户行；进件前 firm_id=null、不可分账）。
                </div>
              ) : (
                <div className="mt8">
                  {loaded.merchants.map((m) => (
                    <div key={m.id} className="spread" style={{ padding: '5px 0' }}>
                      <span className="small">
                        {m.channel}
                        <span className="tiny muted"> · {m.sub_mchid ?? '子商户号待发'}</span>
                      </span>
                      <span className="small">
                        <span className="tag gray">{MERCHANT_STATUS_LABELS[m.status]}</span>
                        <span className="tiny muted">
                          {' '}
                          复验 {m.reverify_due === null ? '—' : m.reverify_due.slice(0, 10)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="tiny muted mt8">进件状态机归支付网关（A3b），此处只读。</div>
            </div>

            <div className="glass-card mt12" style={{ padding: '14px 16px' }}>
              <div className="spread">
                <span className="h3">信用快照（G1）</span>
                <span className="small">
                  信用分 <b style={{ fontSize: 18 }}>{loaded.credit.score}</b>
                </span>
              </div>
              {loaded.credit.restrictions.length > 0 ? (
                <div className="notice acc mt8">
                  <span>
                    {loaded.credit.restrictions
                      .map((r) => `【${r.kind}】${r.reason}（至 ${r.until.slice(0, 10)}）`)
                      .join('；')}
                  </span>
                </div>
              ) : (
                <div className="small muted mt8">无活跃限制令。</div>
              )}
              <div className="hr-soft" />
              <div className="small muted mb8">最近信用事件</div>
              {loaded.credit.recent_events.length === 0 ? (
                <div className="small muted">暂无流水。</div>
              ) : (
                loaded.credit.recent_events.slice(0, 5).map((e) => (
                  <div key={e.id} className="spread" style={{ padding: '4px 0' }}>
                    <span className="small">
                      {e.action}
                      <span className="tiny muted">
                        {' '}
                        · {e.ref_type} #{e.ref_id}
                      </span>
                    </span>
                    <span className={`small${e.delta < 0 ? ' sla-danger' : ''}`}>
                      {e.delta > 0 ? `+${e.delta}` : e.delta} · {formatDateTime(e.created_at)}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="glass-card mt12" style={{ padding: '14px 16px' }}>
              <div className="spread">
                <span className="h3">服务面统计（C1）</span>
                <span className="tiny muted">
                  窗口 {loaded.session_stats_window.from} ~ {loaded.session_stats_window.to}
                  （服务端缺省近 30 天）
                </span>
              </div>
              <div className="kpi4 mt8">
                {(
                  [
                    ['报名率', formatRate(loaded.session_stats.enroll_rate)],
                    ['成团率', formatRate(loaded.session_stats.group_rate)],
                    ['到场率', formatRate(loaded.session_stats.attendance_rate)],
                    ['1对1转化', formatRate(loaded.session_stats.ooo_rate)],
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k} className="tc">
                    <div className="small">
                      <b>{v}</b>
                    </div>
                    <div className="tiny muted">{k}</div>
                  </div>
                ))}
              </div>
              <div className="tiny muted mt8">
                null=窗口内缺数据（非 0）；统计口径归 C1 履约聚合导出面，禁跨 schema join。
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
