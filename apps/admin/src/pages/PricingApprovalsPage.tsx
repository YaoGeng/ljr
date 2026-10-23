/**
 * C6 改价审批台页（M3-W3 T6，#/pricing-approvals）：①期人工兜底审批面（对照 prototype
 * a-tickets 内「改价审批」语境——审批台独立成页=05 W3 行「审批台页面本批次上线」）。
 *
 * 对照 core 实码契约（price-change.controller/service/http）：
 *   - 直达输入（W3-4 核心纪律）：GET /pricing/histories?lawyer_id= 必填——跨律师「待审批
 *     列表」暂无契约面，按律师 id 直达承载（#49-① 先例），页面顶部如实注记；非法输入
 *     内联防呆（parsePositiveInt 镜像），不发请求；
 *   - 记录列表：待审批行 PENDING_APPROVAL 置顶为焦点卡（红色仅 3px 左条+tag acc 徽标+
 *     危险按钮——极小面积铁律）；已决/直效行时间线表格（服务端序 id DESC）；
 *   - 审批动作：approve true/false 二选（false=REJECTED 危险二段确认）；approval_id 必填
 *     正整数（parseApproveBody 实码：①期人工兜底=处置凭据 id）；出参含幂等重放形态——
 *     非 PENDING 重放返回既有终态不翻案，横幅按实际回包文案承载；
 *   - 三档联动注记（R-01）：kind=DOWN 类展示「快照保护+积分补偿（>10% 档加优惠券+信用
 *     -30+停接 3 天）」；不在团待审行=频率超限兜底档（生效无补偿无信用事件）——审批员
 *     处置前可见后果；
 *   - 出参无新旧价格金额/草案明细（PriceHistoryView 剥离 new_version_draft）——展示
 *     版本号与幅度，金额对照缺口列 triage 不扩面；
 *   - 409 全家族（E_CONFLICT 版本链漂移 / E_STATE_STALE_ENTITY 并发裁决 / 守卫迁移拒绝）
 *     → 横幅+刷新；三态齐全；文案映射表单源（PRICE_RESULT_LABELS/PRICE_KIND_LABELS）。
 */
import { useCallback, useState } from 'react';
import { isAdminApiError } from '../api/client';
import { formatDateTime } from '../api/lawyers';
import {
  PRICE_KIND_LABELS,
  PRICE_RESULT_LABELS,
  approvePriceChange,
  buildApproveBody,
  derivePriceChangeKind,
  listPricingHistories,
  sortHistoriesPendingFirst,
  validateLawyerIdInput,
  type ApprovePriceChangeBody,
  type PriceHistoryResultState,
  type PriceHistoryView,
} from '../api/pricing-approvals';
import { IconRefresh } from '../components/icons';

/** 409 全家族判定（版本链漂移审批作废 / 并发裁决残余 / 守卫迁移拒绝）→ 横幅+刷新承载 */
function isPricingConflict(err: unknown): boolean {
  return (
    isAdminApiError(err) &&
    (err.code === 'E_CONFLICT' ||
      err.code === 'E_STATE_STALE_ENTITY' ||
      err.code === 'E_STATE_ILLEGAL_TRANSITION')
  );
}

/** 冲突横幅文案：服务端明细优先（归一链第二源），映射表通用文案兜底 */
function conflictCopy(err: unknown): string {
  return isAdminApiError(err) ? (err.serverMessage ?? err.message) : '操作冲突，请刷新后重试';
}

function errorCopy(err: unknown): string {
  return isAdminApiError(err) ? err.message : '操作失败，请稍后重试';
}

/** 结果状态 → 展示 tag 形态（PENDING=豆沙红焦点位；EFFECTED/REJECTED=绿/灰系） */
const RESULT_TAG_CLASS: Readonly<Record<PriceHistoryResultState, string>> = {
  PENDING_APPROVAL: 'tag acc',
  EFFECTED: 'tag',
  REJECTED: 'tag gray',
};

type ListState =
  | { phase: 'idle' } // 直达查询前（无 lawyer_id 无列表——不虚构跨律师面）
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: readonly PriceHistoryView[] };

type Banner = { kind: 'error' | 'notice'; text: string } | null;

export function PricingApprovalsPage() {
  const [lawyerIdInput, setLawyerIdInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  /** 已生效的直达查询（刷新按钮与审批后 reload 的锚；null=尚未查询） */
  const [queried, setQueried] = useState<number | null>(null);
  const [list, setList] = useState<ListState>({ phase: 'idle' });
  const [banner, setBanner] = useState<Banner>(null);

  const load = useCallback(async (lawyerId: number): Promise<void> => {
    setList({ phase: 'loading' });
    try {
      setList({ phase: 'ok', data: await listPricingHistories(lawyerId) });
    } catch (err) {
      // 401 由 client 统一拦截回登录页；此处只承载非 401 错误（如 400 防呆漏网/网络）
      setList({ phase: 'error', message: errorCopy(err) });
    }
  }, []);

  /** 直达查询收口：前端防呆先行（不发请求）；通过后锚定 lawyerId 并拉取列表 */
  function submitQuery(): void {
    const parsed = validateLawyerIdInput(lawyerIdInput.trim());
    if (!parsed.ok) {
      setInputError(parsed.error);
      return;
    }
    setInputError(null);
    setBanner(null);
    setQueried(parsed.value);
    void load(parsed.value);
  }

  /**
   * 审批动作收口：成功（含幂等重放）→ notice+刷新（行就地流转：焦点卡消失、表格内出
   * EFFECTED/REJECTED 终态）；409 → error+刷新；其余（404/400/网络）rethrow 由卡内就地内联
   */
  const runApprove = useCallback(
    async (
      row: PriceHistoryView,
      approved: boolean,
      body: ApprovePriceChangeBody,
    ): Promise<void> => {
      try {
        const result = await approvePriceChange(row.history_id, body);
        // 幂等重放判定：approved 与回包终态相悖 = 该行已被并发处置（重放返回既有终态不翻案）
        const replayed = result.result !== (approved ? 'EFFECTED' : 'REJECTED');
        setBanner({
          kind: 'notice',
          text: replayed
            ? `幂等重放：改价 #${row.history_id} 已被处置为「${PRICE_RESULT_LABELS[result.result].label}」（终态不翻案，本次零副作用）`
            : approved
              ? row.has_active_group
                ? `审批通过：改价 #${row.history_id} 已生效（EFFECTED · approval_source=MANUAL）——版本经 B3 落版，信用/补偿/话术按档位联动（G1/F4/I1）`
                : `审批通过：改价 #${row.history_id} 已生效（EFFECTED · approval_source=MANUAL）——版本经 B3 落版（不在团行无补偿与信用联动）`
              : `已否决：改价 #${row.history_id} → REJECTED（终态不翻案；版本不生效，无信用事件无补偿）`,
        });
        if (queried !== null) await load(queried);
      } catch (err) {
        if (isPricingConflict(err)) {
          setBanner({
            kind: 'error',
            text: `${conflictCopy(err)}（列表已刷新——该行已被并发处置或版本链漂移）`,
          });
          if (queried !== null) await load(queried);
          return;
        }
        throw err;
      }
    },
    [load, queried],
  );

  const rows = list.phase === 'ok' ? sortHistoriesPendingFirst(list.data) : [];
  const pending = rows.filter((r) => r.result === 'PENDING_APPROVAL');
  const decided = rows.filter((r) => r.result !== 'PENDING_APPROVAL');

  return (
    <>
      <div className="ad-head">
        <div>
          <div className="h1">改价审批台</div>
          <div className="sub">
            C6 改价与补偿 · ①期人工兜底（approve 归源 approval_source=MANUAL——H3 工单回调 ②期
            接入）· R-01 三档：涨价 信用-5 / 在团降价 ≤10% 审批+积分补偿 -15 / 降价 &gt;10%
            审批+积分+券 -30+停接 3 天 · R-03 频率 30 天 3 次超限亦入审批 · 24h 内可撤销
          </div>
        </div>
        <button
          type="button"
          className="btn btn-o btn-sm"
          disabled={queried === null || list.phase === 'loading'}
          onClick={() => queried !== null && void load(queried)}
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

      {/* ---------------- 直达输入区（W3-4：lawyer_id 必填=「直达输入」承载） ---------------- */}

      <div className="glass-card" style={{ padding: '16px 18px' }}>
        <div className="spread mb12">
          <div>
            <span className="h3">按律师直达查询</span>
            <div className="tiny muted mt4">
              跨律师「待审批列表」暂无契约面——GET /pricing/histories 以 lawyer_id 必填直达承载
              （W3-4 拍板，#49-① 先例）；输入律师 id 查询其全部改价记录，待审批行置顶为焦点卡。
            </div>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="pricing-lawyer-id">
            律师 id（必填，十进制正整数）
          </label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="pricing-lawyer-id"
              className={`input${inputError !== null ? ' invalid' : ''}`}
              style={{ maxWidth: 260 }}
              value={lawyerIdInput}
              inputMode="numeric"
              placeholder="例：42"
              onChange={(e) => {
                setLawyerIdInput(e.target.value);
                if (inputError !== null) setInputError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitQuery();
              }}
            />
            <button type="button" className="btn btn-g btn-sm" onClick={submitQuery}>
              查询记录
            </button>
          </div>
          {inputError !== null ? <div className="field-error mt4">{inputError}</div> : null}
        </div>
      </div>

      {/* ---------------- 列表三态 ---------------- */}

      {list.phase === 'loading' ? (
        <div className="glass-card" style={{ padding: '36px 20px', textAlign: 'center' }}>
          <span className="muted">改价记录加载中…</span>
        </div>
      ) : null}

      {list.phase === 'error' ? (
        <div
          className="glass-card"
          style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="error-banner" role="alert">
            <span>记录加载失败：{list.message}</span>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-g btn-sm"
              onClick={() => queried !== null && void load(queried)}
            >
              重试
            </button>
          </div>
        </div>
      ) : null}

      {list.phase === 'ok' ? (
        list.data.length === 0 ? (
          <div className="notice">
            <span>
              律师 {queried} 暂无改价记录（pricing_histories 空集——首配置走 B3 PUT 不留历史行，
              不在团改价直效后才逐行累积）。
            </span>
          </div>
        ) : (
          <>
            {pending.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="h3">
                  待审批（{pending.length}）——PENDING_APPROVAL
                  <span className="tiny muted" style={{ marginLeft: 8 }}>
                    置顶焦点卡 · 幂等键=history（终态不翻案）
                  </span>
                </div>
                {pending.map((row) => (
                  <PendingApproveCard key={row.history_id} row={row} onApprove={runApprove} />
                ))}
              </div>
            ) : (
              <div className="notice">
                <span>
                  当前律师无待审批行（PENDING_APPROVAL 空集）——已决/直效行时间线见下表；
                  待审请求由律师端发起（POST /lawyer/pricing/change 在团降价/超限档）。
                </span>
              </div>
            )}

            {decided.length > 0 ? (
              <div className="glass-card">
                <div className="tblwrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>历史</th>
                        <th>方向 · 幅度</th>
                        <th>档位</th>
                        <th>版本</th>
                        <th>在团</th>
                        <th>信用</th>
                        <th>结果</th>
                        <th>审批归源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {decided.map((r) => {
                        const kind = derivePriceChangeKind(r);
                        return (
                          <tr key={r.history_id}>
                            <td>
                              <b>#{r.history_id}</b>
                              <div className="tiny muted">{formatDateTime(r.created_at)}</div>
                            </td>
                            <td>
                              <span className={r.direction === 'DOWN' ? 'tag' : 'tag gray'}>
                                {r.direction === 'DOWN' ? '降' : '涨'}{' '}
                                {r.direction === 'DOWN' ? '-' : '+'}
                                {r.change_pct}%
                              </span>
                            </td>
                            <td className="muted small">
                              {kind === null ? '—' : PRICE_KIND_LABELS[kind].label}
                            </td>
                            <td className="muted">
                              v{r.old_version} → v{r.new_version}
                            </td>
                            <td className="muted small">
                              {r.has_active_group ? '在团' : '不在团'}
                            </td>
                            <td className="muted small">{r.credit_penalty}</td>
                            <td>
                              <span className={RESULT_TAG_CLASS[r.result]}>
                                {PRICE_RESULT_LABELS[r.result].label}
                              </span>
                              {r.revoked_at !== null ? (
                                <div className="tiny muted mt4">
                                  已撤销 {formatDateTime(r.revoked_at)}（R-04，revoked_at 承载）
                                </div>
                              ) : null}
                            </td>
                            <td className="tiny muted">
                              {r.approval_source === 'MANUAL' && r.approval_id !== null
                                ? `#${r.approval_id} · MANUAL`
                                : '—（直效）'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="pagebar">
                  <span className="tiny muted">
                    服务端排序 id DESC（新在前）· 待审批行置顶为焦点卡（上区）· 直效行（不在团任意
                    方向 / 在团涨价）不经审批即 EFFECTED · 出参无新旧价格金额与草案明细（金额对照
                    缺口列 triage，展示版本号+幅度）
                  </span>
                </div>
              </div>
            ) : null}
          </>
        )
      ) : null}

      {list.phase === 'idle' ? (
        <div className="notice">
          <span>
            输入律师 id 发起查询后展示其改价记录（本台数据面 GET /pricing/histories 为公开 GET， 经
            admin 会话统一带 Authorization 调用；审批动作 approve 要求 admin 角色）。
          </span>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 待审批焦点卡（PENDING_APPROVAL 行：三档联动注记 + approve true/false 二选动作）
// ---------------------------------------------------------------------------

function PendingApproveCard(props: {
  readonly row: PriceHistoryView;
  readonly onApprove: (
    row: PriceHistoryView,
    approved: boolean,
    body: ApprovePriceChangeBody,
  ) => Promise<void>;
}) {
  const { row, onApprove } = props;
  const [approvalId, setApprovalId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 否决二段确认门（approve false=REJECTED 终态危险动作——T2 suspend/T5 publish 先例） */
  const [armed, setArmed] = useState(false);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);

  const kind = derivePriceChangeKind(row);

  async function act(approved: boolean): Promise<void> {
    if (!approved && !armed) {
      setArmed(true); // 危险二段确认：首次点击只进入 armed 态
      return;
    }
    // 前端防呆先行（不发请求）；服务端 parseApproveBody 同规则 400 兜底
    const built = buildApproveBody({ approved, approvalId });
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    setError(null);
    setActing(approved ? 'approve' : 'reject');
    try {
      await onApprove(row, approved, built.value);
    } catch (err) {
      setError(errorCopy(err)); // 409 已被 runApprove 收口为横幅+刷新（行随刷新流转）
    } finally {
      setActing(null);
      setArmed(false);
    }
  }

  return (
    <div
      className="glass-card"
      style={{ padding: '14px 16px', borderLeft: '3px solid var(--ljr-accent)' }}
    >
      <div className="spread mb12">
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="tag acc">{PRICE_RESULT_LABELS.PENDING_APPROVAL.label}</span>
          {kind !== null ? <span className="tag gray">{PRICE_KIND_LABELS[kind].label}</span> : null}
          <span className="tag">
            {row.direction === 'DOWN' ? '降' : '涨'} {row.direction === 'DOWN' ? '-' : '+'}
            {row.change_pct}%
          </span>
          <span className="small muted">
            v{row.old_version} → v{row.new_version} · {row.has_active_group ? '在团' : '不在团'} ·
            信用 {row.credit_penalty}
          </span>
        </div>
        <span className="tiny muted">
          #{row.history_id} · 发起 {formatDateTime(row.created_at)}
        </span>
      </div>

      {/* 三档联动注记（R-01）：审批员处置前可见后果；不在团待审行=频率超限兜底档 */}
      <div className="notice" style={{ alignItems: 'flex-start' }}>
        <span>
          {row.has_active_group
            ? kind !== null
              ? PRICE_KIND_LABELS[kind].note
              : '档位数据表外（credit_penalty 越值域）——不猜档；生效后果以服务端 approve 精判联动为准'
            : '不在团改价本直效无惩罚——本行因 R-03 频率超限（30 天 3 次）入审批兜底档；生效无补偿、无信用事件'}
        </span>
      </div>

      {/* 审批动作：approval_id 必填（parseApproveBody 实码）+ true/false 二选 */}
      <div className="field mt12">
        <label className="label" htmlFor={`approval-id-${row.history_id}`}>
          approval_id（必填正整数——①期人工兜底=处置凭据 id；H3 工单 id ②期接入）
        </label>
        <div className="row wrap" style={{ gap: 8 }}>
          <input
            id={`approval-id-${row.history_id}`}
            className={`input${formError !== null ? ' invalid' : ''}`}
            style={{ maxWidth: 200 }}
            value={approvalId}
            inputMode="numeric"
            placeholder="处置凭据 id"
            disabled={acting !== null}
            onChange={(e) => {
              setApprovalId(e.target.value);
              if (formError !== null) setFormError(null);
              if (armed) setArmed(false); // 改输入即解除二段确认
            }}
          />
          <button
            type="button"
            className="btn btn-g btn-sm"
            disabled={acting !== null}
            onClick={() => void act(true)}
          >
            {acting === 'approve' ? '处置中…' : '通过（EFFECTED）'}
          </button>
          <button
            type="button"
            className="btn btn-danger-o btn-sm"
            disabled={acting !== null}
            onClick={() => void act(false)}
          >
            {acting === 'reject'
              ? '处置中…'
              : armed
                ? '确认否决（再次点击提交）'
                : '否决（REJECTED）'}
          </button>
        </div>
        {formError !== null ? <div className="field-error mt4">{formError}</div> : null}
      </div>

      {error !== null ? (
        <div className="error-banner mt8" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      <div className="tiny muted mt8">
        幂等键=history：非 PENDING 重放返回既有终态不翻案；通过时版本链漂移 → 409 审批作废须
        律师重新发起。
      </div>
    </div>
  );
}
