/**
 * H7 规则中心页（M3-W3 T5，#/rules）：规则版本化管理面（对照 prototype a-rules
 * 「规则列表卡 + 版本抽屉 + 新增规则/保存发布」的信息层级）。
 *
 * 对照 core 实码契约（rule-admin.controller 五端点）：
 *   - 管理列表 GET /admin/rules（status 筛选=parseRuleStatus 合法四值；服务端排序
 *     rule_key, version DESC——同一 key 多版本行并列）——行=规则 key/版本/状态/时刻；
 *   - 单键版本视图：点行/操作列 → GET :key version DESC 时间线（tl-item 形态；状态流转
 *     标注：DRAFT→PUBLISHED→EFFECTIVE（公示期满自动生效）/ DRAFT→ABANDONED（终态留痕）；
 *     content=不透明 jsonb——如实 JSON 展示不猜结构）；
 *   - 创建草案弹层：key=自由词法串输入+防呆（core 无合法 key 枚举——§2 五域为示例非词表；
 *     wordlist.* 保留前缀本地拒=E_RULE_KEY_RESERVED 双层）；重放幂等 created:false 如实
 *     提示（不报错不重复建版）；
 *   - 提交公示 publish：影响全平台规则的危险动作——二段确认门（T2 suspend/resume 先例）+
 *     文案明示影响面（7 日公示期 + RulePublished 事件 + 届满自动生效为行为时快照版本）；
 *     重放幂等 deduplicated:true 如实提示（回读首次公示时刻）；
 *   - 废弃 abandon：DRAFT→ABANDONED 终态（留痕不删行，电商法 §34）——终态动作二段确认；
 *     非 DRAFT → 409（横幅+刷新承载）；
 *   - 409 全家族（E_RULE_PUBLISHING / E_STATE_ILLEGAL_TRANSITION / E_STATE_STALE_ENTITY）→
 *     屏顶横幅+刷新；三态齐全；状态文案映射表单源（RULE_STATUS_LABELS）。
 */
import { useCallback, useEffect, useState } from 'react';
import { isAdminApiError } from '../api/client';
import { formatDateTime } from '../api/lawyers';
import {
  RULE_PUBLISH_STATUS_VALUES,
  RULE_STATUS_LABELS,
  abandonRule,
  buildCreateDraftBody,
  buildRuleVersionBody,
  createRuleDraft,
  latestVersionOf,
  listRules,
  listRuleVersions,
  publishRule,
  type CreateRuleBody,
  type RuleDefinitionView,
  type RulePublishStatus,
} from '../api/rules';
import { IconPlus, IconRefresh } from '../components/icons';

/** 状态串 → 展示 tag 形态（橄榄绿系为主；规则状态无危险值——红位留给危险动作按钮） */
const RULE_STATUS_TAG_CLASS: Readonly<Record<string, string>> = {
  DRAFT: 'tag gray',
  PUBLISHED: 'tag',
  EFFECTIVE: 'tag',
  ABANDONED: 'tag gray',
};

function statusLabel(status: string): string {
  return RULE_STATUS_LABELS[status as RulePublishStatus]?.label ?? status;
}

/** 409 全家族判定（createDraft 内容冲突 / 非 DRAFT publish / 非 DRAFT abandon 守卫拒绝 /
 *  并发迁移残余）→ 横幅+刷新承载 */
function isRuleConflict(err: unknown): boolean {
  return (
    isAdminApiError(err) &&
    (err.code === 'E_RULE_PUBLISHING' ||
      err.code === 'E_STATE_ILLEGAL_TRANSITION' ||
      err.code === 'E_STATE_STALE_ENTITY')
  );
}

/** 冲突横幅文案：服务端明细优先（归一链第二源），映射表通用文案兜底 */
function conflictCopy(err: unknown): string {
  return isAdminApiError(err) ? (err.serverMessage ?? err.message) : '操作冲突，请刷新后重试';
}

function errorCopy(err: unknown): string {
  return isAdminApiError(err) ? err.message : '操作失败，请稍后重试';
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: readonly RuleDefinitionView[] };

type Banner = { kind: 'error' | 'notice'; text: string } | null;

export function RulesPage() {
  const [statusFilter, setStatusFilter] = useState<RulePublishStatus | undefined>(undefined);
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [banner, setBanner] = useState<Banner>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [versionKey, setVersionKey] = useState<string | null>(null);
  /** 抽屉刷新信号：动作（发布/废弃/建草案）后自增，抽屉 effect 依赖重取该 key 版本视图 */
  const [drawerReload, setDrawerReload] = useState(0);
  const [publishTarget, setPublishTarget] = useState<RuleDefinitionView | null>(null);
  const [abandonTarget, setAbandonTarget] = useState<RuleDefinitionView | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setList({ phase: 'loading' });
    try {
      setList({ phase: 'ok', data: await listRules(undefined, statusFilter) });
    } catch (err) {
      // 401 由 client 统一拦截回登录页；此处只承载非 401 错误
      setList({ phase: 'error', message: errorCopy(err) });
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 动作后刷新：管理列表 + 打开中的版本视图同步对齐（同一 key 的行状态已变） */
  const refresh = useCallback(async (): Promise<void> => {
    await load();
    setDrawerReload((n) => n + 1);
  }, [load]);

  /** 创建草案收口：成功（含 created:false 重放）→ notice+关弹层+刷新；409 → error+关+刷新；
   *  其余（400 防呆漏网/500/网络）rethrow 由弹层就地内联 */
  const runCreate = useCallback(
    async (body: CreateRuleBody): Promise<void> => {
      try {
        const result = await createRuleDraft(body);
        setBanner({
          kind: 'notice',
          text: result.created
            ? `草案已创建：${result.ruleKey} v${result.version}（DRAFT）——提交公示前不影响任何现行判定`
            : `幂等重放：${result.ruleKey} v${result.version} 已在册且内容全等（created:false）——不重复建版`,
        });
        setCreateOpen(false);
        await refresh();
      } catch (err) {
        if (isRuleConflict(err)) {
          setBanner({ kind: 'error', text: `${conflictCopy(err)}（列表已刷新）` });
          setCreateOpen(false);
          await refresh();
          return;
        }
        throw err;
      }
    },
    [refresh],
  );

  /** 提交公示收口：成功（含 deduplicated:true 重放）→ notice+关弹层+刷新；409 → error+关+刷新 */
  const runPublish = useCallback(
    async (rule: RuleDefinitionView): Promise<void> => {
      const built = buildRuleVersionBody(rule.version);
      if (!built.ok) {
        // 行内版本号恒为服务端正整数——防御位（不发请求，横幅明示）
        setBanner({ kind: 'error', text: built.error });
        return;
      }
      try {
        const result = await publishRule(rule.ruleKey, built.value);
        setBanner({
          kind: 'notice',
          text: result.deduplicated
            ? `幂等重放：${result.ruleKey} v${result.version} 已在公示中（deduplicated:true）——不重发事件/不重注册生效 job，首次公示 ${formatDateTime(result.publishedAt)}`
            : `已提交公示：${result.ruleKey} v${result.version}——公示期至 ${formatDateTime(result.effectiveAt)} 届满自动生效（RulePublished 已发：I1 公示通知 / D5 须知刷新 / 消费方缓存失效）`,
        });
        setPublishTarget(null);
        await refresh();
      } catch (err) {
        if (isRuleConflict(err)) {
          setBanner({ kind: 'error', text: `${conflictCopy(err)}（列表已刷新）` });
          setPublishTarget(null);
          await refresh();
          return;
        }
        throw err;
      }
    },
    [refresh],
  );

  /** 废弃草案收口：成功 → notice+关弹层+刷新；非 DRAFT 409 → error+关+刷新 */
  const runAbandon = useCallback(
    async (rule: RuleDefinitionView): Promise<void> => {
      const built = buildRuleVersionBody(rule.version);
      if (!built.ok) {
        setBanner({ kind: 'error', text: built.error }); // 防御位同 runPublish
        return;
      }
      try {
        const result = await abandonRule(rule.ruleKey, built.value);
        setBanner({
          kind: 'notice',
          text: `已废弃草案：${result.ruleKey} v${result.version}（终态留痕不删行，变更历史可查）`,
        });
        setAbandonTarget(null);
        await refresh();
      } catch (err) {
        if (isRuleConflict(err)) {
          setBanner({ kind: 'error', text: `${conflictCopy(err)}（列表已刷新）` });
          setAbandonTarget(null);
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
          <div className="h1">规则中心</div>
          <div className="sub">
            rule_definitions 版本化（幂等键=key+version）· 变更流 DRAFT → PUBLISHED（公示 ≥7 日）→
            EFFECTIVE / DRAFT → ABANDONED（终态留痕）· 行为时快照由各消费方按生效版本执行（H7
            不做规则执行）· 房间须知内容块（room_notice）D5 进房拉取
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-o btn-sm"
            onClick={() => void load()}
            disabled={list.phase === 'loading'}
          >
            <IconRefresh size={13} />
            刷新
          </button>
          <button type="button" className="btn btn-g btn-sm" onClick={() => setCreateOpen(true)}>
            <IconPlus size={13} />
            创建草案
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

      {/* ---------------- 管理列表（status 筛选=parseRuleStatus 四值） ---------------- */}

      <div className="row wrap" style={{ gap: 8 }}>
        <button
          type="button"
          className={`chip${statusFilter === undefined ? ' on' : ''}`}
          aria-pressed={statusFilter === undefined}
          onClick={() => setStatusFilter(undefined)}
        >
          全部状态
        </button>
        {RULE_PUBLISH_STATUS_VALUES.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip${statusFilter === s ? ' on' : ''}`}
            aria-pressed={statusFilter === s}
            title={s}
            onClick={() => setStatusFilter(s)}
          >
            {RULE_STATUS_LABELS[s].label}（{s}）
          </button>
        ))}
      </div>

      {list.phase === 'loading' ? (
        <div className="glass-card" style={{ padding: '36px 20px', textAlign: 'center' }}>
          <span className="muted">规则版本列表加载中…</span>
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
        data !== null && data.length === 0 ? (
          <div className="notice">
            <span>
              暂无规则版本（当前筛选=
              {statusFilter === undefined ? '全部' : statusLabel(statusFilter)}）——
              「创建草案」起步，草案提交公示前不影响任何现行判定。
            </span>
          </div>
        ) : (
          <div className="glass-card">
            <div className="tblwrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>规则 key</th>
                    <th>版本</th>
                    <th>状态</th>
                    <th>创建时间</th>
                    <th>公示 / 生效时刻</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.map((r) => (
                    <tr
                      key={r.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setVersionKey(r.ruleKey)}
                    >
                      <td>
                        <b>{r.ruleKey}</b>
                        <div className="tiny muted">#{r.id}</div>
                      </td>
                      <td className="muted">v{r.version}</td>
                      <td>
                        <span className={RULE_STATUS_TAG_CLASS[r.publishStatus] ?? 'tag gray'}>
                          {statusLabel(r.publishStatus)}
                        </span>
                      </td>
                      <td className="muted">{formatDateTime(r.createdAt)}</td>
                      <td className="muted tiny">
                        {r.publishStatus === 'PUBLISHED' && r.effectiveAt !== null
                          ? `公示至 ${formatDateTime(r.effectiveAt)}`
                          : r.publishStatus === 'EFFECTIVE' && r.effectiveAt !== null
                            ? `生效于 ${formatDateTime(r.effectiveAt)}`
                            : '—'}
                        {r.publishedAt !== null ? (
                          <>
                            <br />
                            提交公示 {formatDateTime(r.publishedAt)}
                          </>
                        ) : null}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ gap: 6 }}>
                          {r.publishStatus === 'DRAFT' ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-danger-o btn-xs"
                                onClick={() => setPublishTarget(r)}
                              >
                                提交公示
                              </button>
                              <button
                                type="button"
                                className="btn btn-o btn-xs"
                                onClick={() => setAbandonTarget(r)}
                              >
                                废弃
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setVersionKey(r.ruleKey)}
                          >
                            版本
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
                服务端排序 rule_key, version DESC（同一 key 多版本行并列）· limit 缺省 100 封顶 500
                · 幂等键=key+version（同键内容全等重放 created:false）
              </span>
            </div>
          </div>
        )
      ) : null}

      {createOpen ? (
        <CreateDraftModal
          rows={data ?? []}
          onClose={() => setCreateOpen(false)}
          runCreate={runCreate}
        />
      ) : null}
      {publishTarget !== null ? (
        <PublishModal
          rule={publishTarget}
          onClose={() => setPublishTarget(null)}
          runPublish={runPublish}
        />
      ) : null}
      {abandonTarget !== null ? (
        <AbandonModal
          rule={abandonTarget}
          onClose={() => setAbandonTarget(null)}
          runAbandon={runAbandon}
        />
      ) : null}
      {versionKey !== null ? (
        <RuleVersionsDrawer
          ruleKey={versionKey}
          reloadToken={drawerReload}
          onClose={() => setVersionKey(null)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 创建草案弹层（POST /admin/rules：key 自由词法串 + version + content JSON——
// 必填字段逐字对照 parseCreateRuleBody；防呆=buildCreateDraftBody 单源）
// ---------------------------------------------------------------------------

function CreateDraftModal(props: {
  rows: readonly RuleDefinitionView[];
  onClose: () => void;
  runCreate: (body: CreateRuleBody) => Promise<void>;
}) {
  const { rows, onClose, runCreate } = props;
  const [ruleKey, setRuleKey] = useState('');
  const [version, setVersion] = useState('1');
  const [contentText, setContentText] = useState('{\n  \n}');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 同 key 已有版本时的「下一版」建议（纯展示建议——version 由运营显式填写） */
  const known = ruleKey.trim() === '' ? 0 : latestVersionOf(rows, ruleKey.trim());

  async function submit(): Promise<void> {
    // 前端防呆先行（不发请求）；服务端 parseCreateRuleBody+assertNotReservedRuleKey 同规则兜底
    const built = buildCreateDraftBody({ ruleKey: ruleKey.trim(), version, contentText });
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    setSubmitting(true); // 幂等防呆：提交中禁用（重复点击不发第二发）
    setError(null);
    try {
      await runCreate(built.value);
    } catch (err) {
      setError(errorCopy(err)); // 409 已被 runCreate 收口为横幅+刷新（弹层已关）
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" aria-label="创建规则草案">
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">创建规则草案</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="field">
          <label className="label" htmlFor="rule-key">
            规则 key（必填，1-32 位字母/数字/下划线/点）
          </label>
          <input
            id="rule-key"
            className={`input${formError !== null && !/^[A-Za-z0-9_.]{1,32}$/.test(ruleKey.trim()) ? ' invalid' : ''}`}
            value={ruleKey}
            disabled={submitting}
            placeholder="例：price_change"
            onChange={(e) => {
              setRuleKey(e.target.value);
              if (formError !== null) setFormError(null);
            }}
          />
          <div className="tiny muted mt4">
            自由词法串无枚举词表——§2 规则域示例：price_change / credit / cancellation / disclaimer /
            room_notice；wordlist.* 为词库保留前缀（须经 H5 词库管理面写入）。
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="rule-version">
            版本 version（必填，正整数——幂等键=key+version）
          </label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="rule-version"
              className="input grow"
              value={version}
              disabled={submitting}
              inputMode="numeric"
              placeholder="正整数"
              onChange={(e) => {
                setVersion(e.target.value);
                if (formError !== null) setFormError(null);
              }}
            />
            {known > 0 ? (
              <button
                type="button"
                className="btn btn-o btn-sm"
                disabled={submitting}
                onClick={() => setVersion(String(known + 1))}
              >
                填入建议 v{known + 1}
              </button>
            ) : null}
          </div>
          {known > 0 ? (
            <div className="tiny muted mt4">
              当前列表内 {ruleKey.trim()} 最高版本 v{known}（建议下一版 v{known + 1}）； 重放同
              key+version 须内容全等（created:false 幂等回读），内容不等 → 409。
            </div>
          ) : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="rule-content">
            内容 content（必填，JSON 对象——非数组/null）
          </label>
          <textarea
            id="rule-content"
            className={`input textarea${formError !== null && (contentText.trim() === '' || contentText.trim().startsWith('[')) ? ' invalid' : ''}`}
            value={contentText}
            disabled={submitting}
            placeholder='{"tier_deltas":[-5,-15,-30]}'
            style={{ minHeight: 120, fontFamily: 'ui-monospace, monospace' }}
            onChange={(e) => {
              setContentText(e.target.value);
              if (formError !== null) setFormError(null);
            }}
          />
          <div className="tiny muted mt4">
            不透明 jsonb 如实存储；room_notice 须为 {'{title, paragraphs, disclosures 非空}'}
            （R-02，
            服务端按配置键校验——披露须含「法律意见由执业律师作出，平台提供信息技术撮合」）。
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
            {submitting ? '提交中…' : '创建草案（DRAFT）'}
          </button>
        </div>
        <div className="tiny muted mt8">
          草案创建即入版本台账（状态机留痕）；公示前不影响任何现行判定——影响面在「提交公示」
          确认门明示。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 提交公示弹层（POST /admin/rules/:key/publish：DRAFT→PUBLISHED——影响全平台规则的
// 危险动作，二段确认门 + 影响面文案明示）
// ---------------------------------------------------------------------------

function PublishModal(props: {
  rule: RuleDefinitionView;
  onClose: () => void;
  runPublish: (rule: RuleDefinitionView) => Promise<void>;
}) {
  const { rule, onClose, runPublish } = props;
  const [armed, setArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!armed) {
      setArmed(true); // 危险动作二段确认门：首次点击只进入 armed 态
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await runPublish(rule);
    } catch (err) {
      setError(errorCopy(err)); // 409 已被 runPublish 收口为横幅+刷新
    } finally {
      setSubmitting(false);
      setArmed(false);
    }
  }

  return (
    <div
      className="mask"
      role="dialog"
      aria-modal="true"
      aria-label={`提交公示 ${rule.ruleKey} v${rule.version}`}
    >
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">
            提交公示 · {rule.ruleKey} v{rule.version}
          </span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="notice acc" role="alert">
          <span>
            <b>影响全平台规则的危险动作。</b>
            提交后进入公示期（缺省 7 日），届满自动生效为行为时快照版本——C6/G1/D4/H5
            等消费方按生效版本执行；RulePublished 事件同事务发出（I1 公示通知 / D5 房间须知刷新 /
            消费方缓存失效）。请确认草案内容无误。
          </span>
        </div>
        <div className="glass-card mt12" style={{ padding: '12px 14px' }}>
          <div className="spread">
            <span className="tag gray">草案（DRAFT）</span>
            <span className="tiny muted">
              创建于 {formatDateTime(rule.createdAt)} · 行 #{rule.id}
            </span>
          </div>
          <pre
            className="tiny"
            style={{
              margin: '8px 0 0',
              padding: '8px 10px',
              background: 'rgba(62, 92, 58, 0.06)',
              borderRadius: 8,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {JSON.stringify(rule.content, null, 2)}
          </pre>
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
            {submitting ? '提交中…' : armed ? '确认提交公示（再次点击提交）' : '提交公示'}
          </button>
        </div>
        <div className="tiny muted mt8">
          重放（已 PUBLISHED）→ deduplicated:true 幂等短路（不重发事件/不重注册生效
          job，回读首次公示时刻）；非 DRAFT 状态 → 409（横幅+刷新）。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 废弃草案弹层（POST /admin/rules/:key/abandon：DRAFT→ABANDONED 终态——二段确认）
// ---------------------------------------------------------------------------

function AbandonModal(props: {
  rule: RuleDefinitionView;
  onClose: () => void;
  runAbandon: (rule: RuleDefinitionView) => Promise<void>;
}) {
  const { rule, onClose, runAbandon } = props;
  const [armed, setArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!armed) {
      setArmed(true); // 终态动作二段确认门
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await runAbandon(rule);
    } catch (err) {
      setError(errorCopy(err)); // 409（非 DRAFT 守卫拒绝）已被 runAbandon 收口为横幅+刷新
    } finally {
      setSubmitting(false);
      setArmed(false);
    }
  }

  return (
    <div
      className="mask"
      role="dialog"
      aria-modal="true"
      aria-label={`废弃草案 ${rule.ruleKey} v${rule.version}`}
    >
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">
            废弃草案 · {rule.ruleKey} v{rule.version}
          </span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="notice">
          <span>
            废弃为终态留痕（不删行——变更历史可查，电商法 §34）：不可再提交公示，同版本
            只能以新版本重来。创建于 {formatDateTime(rule.createdAt)} · 行 #{rule.id}。
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
            className="btn btn-danger-o grow"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? '提交中…' : armed ? '确认废弃（再次点击提交）' : '废弃草案'}
          </button>
        </div>
        <div className="tiny muted mt8">
          非 DRAFT（公示中/已生效/已废弃）→ 409 守卫拒绝：公示中版本只能被新版本取代，
          已生效为快照事实不可回退。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 单键版本视图抽屉（GET /admin/rules/:key：version DESC 时间线 + 状态流转标注）
// ---------------------------------------------------------------------------

function RuleVersionsDrawer(props: {
  ruleKey: string;
  /** 页面动作后自增的刷新信号（发布/废弃/建草案改变该 key 的版本行） */
  reloadToken: number;
  onClose: () => void;
}) {
  const { ruleKey, reloadToken, onClose } = props;
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ok'; data: readonly RuleDefinitionView[] }
  >({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    listRuleVersions(ruleKey)
      .then((data) => {
        if (!cancelled) setState({ phase: 'ok', data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ phase: 'error', message: errorCopy(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [ruleKey, reloadToken]);

  return (
    <div className="mask right" role="dialog" aria-modal="true" aria-label={`规则版本 ${ruleKey}`}>
      <div className="drawer">
        <div className="spread mb16">
          <div>
            <span className="h2">{ruleKey}</span>
            <div className="tiny muted mt4">
              版本 DESC 时间线 · 流转 DRAFT → PUBLISHED（公示 ≥7 日）→ EFFECTIVE / DRAFT → ABANDONED
              · content=不透明 jsonb 如实展示
            </div>
          </div>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {state.phase === 'loading' ? <div className="muted small">版本视图加载中…</div> : null}
        {state.phase === 'error' ? (
          <div className="glass-card" style={{ padding: 20 }}>
            <div className="error-banner" role="alert">
              <span>版本视图加载失败：{state.message}</span>
            </div>
            <div className="tiny muted mt8">
              rule_key 词法非法 → 400（列表行 key 恒合法——防御位）。
            </div>
          </div>
        ) : null}

        {state.phase === 'ok' ? (
          state.data.length === 0 ? (
            <div className="notice">
              <span>该 key 尚无任何版本（含历史草案——UNIQUE(key, version) 台账为空）。</span>
            </div>
          ) : (
            <div className="glass-card" style={{ padding: '14px 16px' }}>
              {state.data.map((v) => (
                <div key={v.id} className="tl-item">
                  <span className="tl-dot" />
                  <div className="grow">
                    <div className="spread">
                      <span className="small">
                        <b>v{v.version}</b>
                        <span
                          className={RULE_STATUS_TAG_CLASS[v.publishStatus] ?? 'tag gray'}
                          style={{ marginLeft: 8 }}
                        >
                          {statusLabel(v.publishStatus)}
                        </span>
                      </span>
                      <span className="tiny muted">创建 {formatDateTime(v.createdAt)}</span>
                    </div>
                    {/* 状态流转标注（RULE_STATUS_LABELS.note 单源 + 行内时刻） */}
                    <div className="tiny muted">
                      {v.publishStatus === 'PUBLISHED' &&
                      v.publishedAt !== null &&
                      v.effectiveAt !== null
                        ? `提交公示 ${formatDateTime(v.publishedAt)} · 公示期满 ${formatDateTime(v.effectiveAt)} 自动生效`
                        : v.publishStatus === 'EFFECTIVE' && v.effectiveAt !== null
                          ? `生效于 ${formatDateTime(v.effectiveAt)}（现行版——行为时快照命中）`
                          : (RULE_STATUS_LABELS[v.publishStatus]?.note ?? v.publishStatus)}
                    </div>
                    <pre
                      className="tiny"
                      style={{
                        margin: '6px 0 0',
                        padding: '8px 10px',
                        background: 'rgba(62, 92, 58, 0.06)',
                        borderRadius: 8,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {JSON.stringify(v.content, null, 2)}
                    </pre>
                    <div className="tiny muted mt4">行 #{v.id}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
