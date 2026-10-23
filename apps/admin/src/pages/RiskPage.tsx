/**
 * H5 风控与敏感词页（M3-W3 T4，#/risk）：两段式——词库管理 + 人审队列（对照原型 a-risk
 * 「双词库卡在上、人审队列在下」的信息层级）。
 *
 * 对照 core 实码契约：
 *   - 词库段 GET /admin/risk/dictionaries（当前生效版本视图；无版本库 version=0/words=[]
 *     如实注记）→ 选库 → 词集 tag 展示；编辑=新增/移除词（本地暂存）→ PUT 提交（幂等键=
 *     dict+base_version——base_version 取当前版本；重放 created:false 如实提示；E_DUP_WORD
 *     本地防呆+服务端 400 双层）；版本 diff 面板（新增 N/移除 N——按 {word,action} 全等
 *     对比：action 变更词条计入两列=词条替换，双空才是真重放「无词集变化」）；
 *   - 队列段 GET /admin/risk/queue（dict_type/action 筛选 + offset 轻量翻页，无 total 契约；
 *     行=命中记录要素——word_hits 只有命中词+词库版本锚，无用户原文/发送者字段=出参形态
 *     如实展示，不发明脱敏形态）；处置 POST /admin/risk/records/:id/review（verdict 三值；
 *     CONFIRM_BLOCK=危险值二段确认——对照原型「拦截」红位；note 可选 ≤500）；处置成功行
 *     自动跌出（列表刷新）；
 *   - 409（DONE 已处置不翻案 / base_version 过期）→ 横幅+刷新承载（T2/T3 模式）；
 *   - 三态齐全；文案映射表单源；批量导入=M2 后置机制不建入口（禁发明）。
 */
import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '../api/lawyers';
import { isAdminApiError } from '../api/client';
import {
  DICT_TYPE_LABELS,
  DICT_TYPE_VALUES,
  REVIEW_VERDICT_LABELS,
  REVIEW_VERDICT_VALUES,
  WORD_ACTION_LABELS,
  WORD_ACTION_VALUES,
  buildPutDictionaryBody,
  buildReviewBody,
  diffWordEntries,
  listDictionaries,
  listRiskQueue,
  normalizeWord,
  parseWordHits,
  putDictionary,
  reviewRiskRecord,
  type DictionaryView,
  type DictType,
  type RiskQueueItem,
  type WordAction,
} from '../api/risk';
import { IconRefresh } from '../components/icons';

/** 队列轻量翻页页宽（core listQueue 缺省 limit=50 封顶 200——缺省不传，按 50 判定翻页尾） */
const QUEUE_PAGE_SIZE = 50;

/** 词级 action → tag 形态（BLOCK=最高 severity 红点缀极小面积；表外值灰防御位） */
const WORD_ACTION_TAG_CLASS: Readonly<Record<string, string>> = {
  BLOCK: 'tag acc',
  REVIEW: 'tag',
  MARK: 'tag gray',
};

function actionLabel(action: string): string {
  return WORD_ACTION_LABELS[action as WordAction] ?? action;
}

/** 409 判定：DONE（E_CONFLICT）+ 并发竞态（E_RULE_PUBLISHING）→ 横幅+刷新承载 */
function isRiskConflict(err: unknown): boolean {
  return isAdminApiError(err) && (err.code === 'E_CONFLICT' || err.code === 'E_RULE_PUBLISHING');
}

/** 冲突横幅文案：服务端已处置/版本过期的明细优先（归一链第二源），映射表通用文案兜底 */
function conflictCopy(err: unknown): string {
  return isAdminApiError(err) ? (err.serverMessage ?? err.message) : '操作冲突，请刷新后重试';
}

function errorCopy(err: unknown): string {
  return isAdminApiError(err) ? err.message : '操作失败，请稍后重试';
}

type DictsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: readonly DictionaryView[] };

type QueueState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: { items: readonly RiskQueueItem[] } };

type Banner = { kind: 'error' | 'notice'; text: string } | null;

export function RiskPage() {
  // ---- 词库段状态 ----
  const [dicts, setDicts] = useState<DictsState>({ phase: 'loading' });
  const [selectedDict, setSelectedDict] = useState<DictType>(DICT_TYPE_VALUES[0]!);
  const [editingDict, setEditingDict] = useState(false);

  // ---- 队列段状态 ----
  const [dictFilter, setDictFilter] = useState<DictType | undefined>(undefined);
  const [actionFilter, setActionFilter] = useState<WordAction | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [queue, setQueue] = useState<QueueState>({ phase: 'loading' });

  const [banner, setBanner] = useState<Banner>(null);
  const [reviewTarget, setReviewTarget] = useState<RiskQueueItem | null>(null);

  const loadDicts = useCallback(async (): Promise<void> => {
    setDicts({ phase: 'loading' });
    try {
      setDicts({ phase: 'ok', data: await listDictionaries() });
    } catch (err) {
      setDicts({ phase: 'error', message: errorCopy(err) });
    }
  }, []);

  const loadQueue = useCallback(async (): Promise<void> => {
    setQueue({ phase: 'loading' });
    try {
      setQueue({
        phase: 'ok',
        data: await listRiskQueue(dictFilter, actionFilter, undefined, offset),
      });
    } catch (err) {
      setQueue({ phase: 'error', message: errorCopy(err) });
    }
  }, [dictFilter, actionFilter, offset]);

  useEffect(() => {
    void loadDicts();
  }, [loadDicts]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  /** 动作后刷新：两段数据面对齐（处置→队列；词库提交→版本视图） */
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([loadDicts(), loadQueue()]);
  }, [loadDicts, loadQueue]);

  /** 处置统一收口：成功 → notice+关弹层+刷新（行自动跌出）；409 DONE → error+关+刷新 */
  const runReview = useCallback(
    async (record: RiskQueueItem, body: { verdict: string; note?: string }): Promise<void> => {
      try {
        const result = await reviewRiskRecord(
          record.id,
          body as Parameters<typeof reviewRiskRecord>[1],
        );
        setBanner({
          kind: 'notice',
          text: `记录 #${result.record_id} 已处置（${REVIEW_VERDICT_LABELS[result.verdict]!.label}，操作人 #${result.reviewed_by}，${formatDateTime(result.reviewed_at)}）——已跌出队列`,
        });
        setReviewTarget(null);
        await loadQueue();
      } catch (err) {
        if (isRiskConflict(err)) {
          setBanner({ kind: 'error', text: `${conflictCopy(err)}（队列已刷新）` });
          setReviewTarget(null);
          await loadQueue();
          return;
        }
        throw err; // 非 409（400/404）由弹层就地内联
      }
    },
    [loadQueue],
  );

  /** 词库提交统一收口：成功（含 created:false 重放）→ notice+退出编辑+刷新；409 → error+刷新 */
  const runPutDict = useCallback(
    async (body: Parameters<typeof putDictionary>[0]): Promise<void> => {
      try {
        const result = await putDictionary(body);
        setBanner({
          kind: 'notice',
          text: result.created
            ? `词库已提交：${result.ruleKey} v${result.version}（${result.wordCount} 词）——免公示通道提交即生效（自动机即时重建）`
            : `幂等重放：${result.ruleKey} v${result.version} 已在册且内容全等（created:false）——不重复建版本`,
        });
        setEditingDict(false);
        await loadDicts();
      } catch (err) {
        if (isRiskConflict(err)) {
          setBanner({
            kind: 'error',
            text: `${conflictCopy(err)}（词库已刷新，请基于最新版本重新编辑）`,
          });
          setEditingDict(false);
          await loadDicts();
          return;
        }
        throw err; // 400 E_DUP_WORD/E_INVALID_ARGUMENT 由编辑器就地内联
      }
    },
    [loadDicts],
  );

  const dictView =
    dicts.phase === 'ok' ? (dicts.data.find((d) => d.dictType === selectedDict) ?? null) : null;
  const queueItems = queue.phase === 'ok' ? queue.data.items : null;

  return (
    <>
      <div className="ad-head">
        <div>
          <div className="h1">风控与敏感词</div>
          <div className="sub">
            H5 处置面：双词库（illegal_content 违法信息 / legal_industry 行业话术）· 词级三级
            BLOCK/REVIEW/MARK · 词库热更新走版本化（免公示通道，幂等键=dict+base_version）·
            人审处置幂等键=record（409 DONE 不翻案）· 队列行无用户原文/发送者字段（出参形态如实）
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-o btn-sm"
            onClick={() => void refresh()}
            disabled={dicts.phase === 'loading' && queue.phase === 'loading'}
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

      {/* ---------------- 词库管理段（原型 a-risk 上半：双词库卡 + 词条编辑） ---------------- */}

      <div className="row wrap" style={{ gap: 8 }}>
        {DICT_TYPE_VALUES.map((d) => (
          <button
            key={d}
            type="button"
            className={`chip${selectedDict === d ? ' on' : ''}`}
            aria-pressed={selectedDict === d}
            onClick={() => {
              setSelectedDict(d);
              setEditingDict(false); // 切库丢弃编辑暂存（本地态未提交不发 PUT）
            }}
          >
            {DICT_TYPE_LABELS[d]}（{d}）
          </button>
        ))}
      </div>

      {dicts.phase === 'loading' ? (
        <div className="glass-card" style={{ padding: '36px 20px', textAlign: 'center' }}>
          <span className="muted">词库视图加载中…</span>
        </div>
      ) : null}

      {dicts.phase === 'error' ? (
        <div
          className="glass-card"
          style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="error-banner" role="alert">
            <span>词库加载失败：{dicts.message}</span>
          </div>
          <div>
            <button type="button" className="btn btn-g btn-sm" onClick={() => void loadDicts()}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {dicts.phase === 'ok' && dictView !== null ? (
        editingDict ? (
          <WordDictEditor
            view={dictView}
            onSubmit={runPutDict}
            onCancel={() => setEditingDict(false)}
          />
        ) : (
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div className="spread">
              <div>
                <div className="h3">
                  {DICT_TYPE_LABELS[dictView.dictType]} · {dictView.ruleKey}
                </div>
                <div className="tiny muted mt4">
                  当前生效 v{dictView.version}
                  {dictView.version === 0
                    ? '（尚无版本——首版提交 base_version=0 即建 v1）'
                    : ` · 生效于 ${formatDateTime(dictView.effectiveAt)}`}{' '}
                  · {dictView.words.length} 词
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-g btn-sm"
                  onClick={() => setEditingDict(true)}
                >
                  编辑词库
                </button>
              </div>
            </div>
            <div className="hr-soft" />
            {dictView.words.length === 0 ? (
              <div className="small muted">
                当前版本词集为空（空 words 合法=清空词库的版本；词库判定=零命中放行）。
              </div>
            ) : (
              <div className="row wrap" style={{ gap: 8 }}>
                {dictView.words.map((w) => (
                  <span key={w.word} className="tag gray" style={{ gap: 8 }}>
                    <b>{w.word}</b>
                    <span className={WORD_ACTION_TAG_CLASS[w.action] ?? 'tag gray'}>
                      {actionLabel(w.action)}
                    </span>
                  </span>
                ))}
              </div>
            )}
            <div className="tiny muted mt12">
              词统一小写规范形（匹配大小写不敏感）· 词级三级：BLOCK=同步拦截 / REVIEW=放行+入人审
              队列 / MARK=放行+标记 · 批量导入=M2 后置机制（本页不建入口）。
            </div>
          </div>
        )
      ) : null}

      {/* ---------------- 人审队列段（原型 a-risk 下半：待处置行 + 处置动作） ---------------- */}

      <div className="ad-head" style={{ marginTop: 4 }}>
        <div>
          <div className="h2">人审队列</div>
          <div className="sub">
            待处置记录（reviewed_at IS NULL 面，处置后自动跌出）· 新在前（created_at DESC）· 行内
            word_hits=该库命中词+判定时词库版本（审计锚）· message/conversation 锚点 V1 可空（D5
            关联后置）
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <button
          type="button"
          className={`chip${dictFilter === undefined ? ' on' : ''}`}
          aria-pressed={dictFilter === undefined}
          onClick={() => {
            setDictFilter(undefined);
            setOffset(0);
          }}
        >
          全部词库
        </button>
        {DICT_TYPE_VALUES.map((d) => (
          <button
            key={d}
            type="button"
            className={`chip${dictFilter === d ? ' on' : ''}`}
            aria-pressed={dictFilter === d}
            title={d}
            onClick={() => {
              setDictFilter(d);
              setOffset(0);
            }}
          >
            {DICT_TYPE_LABELS[d]}
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8, marginTop: -8 }}>
        <button
          type="button"
          className={`chip${actionFilter === undefined ? ' on' : ''}`}
          aria-pressed={actionFilter === undefined}
          onClick={() => {
            setActionFilter(undefined);
            setOffset(0);
          }}
        >
          全部处置级
        </button>
        {WORD_ACTION_VALUES.map((a) => (
          <button
            key={a}
            type="button"
            className={`chip${actionFilter === a ? ' on' : ''}`}
            aria-pressed={actionFilter === a}
            title={a}
            onClick={() => {
              setActionFilter(a);
              setOffset(0);
            }}
          >
            {actionLabel(a)}（{a}）
          </button>
        ))}
      </div>

      {queue.phase === 'loading' ? (
        <div className="glass-card" style={{ padding: '36px 20px', textAlign: 'center' }}>
          <span className="muted">队列加载中…</span>
        </div>
      ) : null}

      {queue.phase === 'error' ? (
        <div
          className="glass-card"
          style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <div className="error-banner" role="alert">
            <span>队列加载失败：{queue.message}</span>
          </div>
          <div>
            <button type="button" className="btn btn-g btn-sm" onClick={() => void loadQueue()}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {queue.phase === 'ok' ? (
        queueItems !== null && queueItems.length === 0 ? (
          <div className="notice">
            <span>当前筛选下暂无待处置记录（全部处置完毕或无 REVIEW 命中入队）。</span>
          </div>
        ) : (
          <div className="glass-card">
            <div className="tblwrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>记录</th>
                    <th>词库</th>
                    <th>机审处置</th>
                    <th>命中词（词库版本）</th>
                    <th>锚点</th>
                    <th>入队时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {queueItems?.map((item) => {
                    const hits = parseWordHits(item.word_hits);
                    return (
                      <tr key={item.id}>
                        <td>
                          <b>#{item.id}</b>
                        </td>
                        <td>
                          <span className="tag gray">
                            {DICT_TYPE_LABELS[item.dict_type] ?? item.dict_type}
                          </span>
                          <div className="tiny muted">{item.dict_type}</div>
                        </td>
                        <td>
                          <span className={WORD_ACTION_TAG_CLASS[item.action] ?? 'tag gray'}>
                            {actionLabel(item.action)}
                          </span>
                        </td>
                        <td>
                          {hits.length === 0 ? (
                            <span className="tiny muted">—（空命中集）</span>
                          ) : (
                            <div className="row wrap" style={{ gap: 6 }}>
                              {hits.map((h, i) => (
                                <span key={`${item.id}-${i}`} className="tag">
                                  {h.word}
                                  <span className="tiny muted">·v{h.rule_version ?? '—'}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="muted tiny">
                          会话 {item.conversation_id === null ? '—' : `#${item.conversation_id}`}
                          <br />
                          消息{' '}
                          {item.message_id === null ? '—（判定先于落库）' : `#${item.message_id}`}
                        </td>
                        <td className="muted">{formatDateTime(item.created_at)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-o btn-xs"
                            onClick={() => setReviewTarget(item)}
                          >
                            处置
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pagebar">
              <span className="tiny muted">
                轻量翻页（limit 缺省 {QUEUE_PAGE_SIZE} 封顶 200，无 total 计数契约）· 处置=终态回填
                verdict/note/by/at + audit_logs 同事务（双面审计）
              </span>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-o btn-xs"
                  disabled={offset <= 0}
                  onClick={() => setOffset(Math.max(0, offset - QUEUE_PAGE_SIZE))}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="btn btn-o btn-xs"
                  disabled={queueItems !== null && queueItems.length < QUEUE_PAGE_SIZE}
                  onClick={() => setOffset(offset + QUEUE_PAGE_SIZE)}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        )
      ) : null}

      {reviewTarget !== null ? (
        <ReviewModal
          record={reviewTarget}
          onClose={() => setReviewTarget(null)}
          runReview={runReview}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 词库编辑器（段内嵌展开：本地暂存词集 → 新增/移除 → diff 面板 → PUT 提交）
// ---------------------------------------------------------------------------

function WordDictEditor(props: {
  view: DictionaryView;
  onSubmit: (body: Parameters<typeof putDictionary>[0]) => Promise<void>;
  onCancel: () => void;
}) {
  const { view, onSubmit, onCancel } = props;
  // 本地暂存（进入编辑=当前生效词集副本；提交体构造/查重统一走 buildPutDictionaryBody）
  const [entries, setEntries] = useState<readonly { word: string; action: WordAction }[]>(() =>
    view.words.map((w) => ({ word: w.word, action: w.action })),
  );
  const [newWord, setNewWord] = useState('');
  const [newAction, setNewAction] = useState<WordAction>('REVIEW');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diff = diffWordEntries(view.words, entries);

  /** 新增词条：本地防呆先行（trim 1..64 + 规范形查重——服务端 E_DUP_WORD 同规则双层） */
  function addWord(): void {
    const word = newWord.trim();
    if (word === '') {
      setFormError('词条不得为空（trim 后 1-64 字符）');
      return;
    }
    if (word.length > 64) {
      setFormError('词条不得超过 64 字符');
      return;
    }
    const norm = normalizeWord(word);
    if (entries.some((e) => e.word === norm)) {
      setFormError(`词库内已存在「${norm}」（大小写不敏感）——E_DUP_WORD，请勿重复添加`);
      return;
    }
    setEntries((prev) =>
      [...prev, { word: norm, action: newAction }].sort((a, b) =>
        a.word < b.word ? -1 : a.word > b.word ? 1 : 0,
      ),
    );
    setNewWord('');
    setFormError(null);
  }

  async function submit(): Promise<void> {
    // 前端防呆先行（全量校验）；服务端 parsePutDictionaryBody+normalizeWordEntries 同规则兜底
    const built = buildPutDictionaryBody({
      dictType: view.dictType,
      baseVersion: view.version,
      words: entries,
    });
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    setSubmitting(true); // 幂等防呆：提交中禁用（重复点击不发第二发）
    setError(null);
    try {
      await onSubmit(built.value);
    } catch (err) {
      setError(errorCopy(err)); // 409 已被 onSubmit 收口为横幅+刷新（编辑态已退出）
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="glass-card" style={{ padding: '16px 18px' }}>
      <div className="spread">
        <div>
          <div className="h3">
            编辑词库 · {DICT_TYPE_LABELS[view.dictType]}（{view.ruleKey}）
          </div>
          <div className="tiny muted mt4">
            基于 v{view.version}（base_version={view.version}）编辑 · 提交写入 v{view.version + 1} ·
            幂等键=dict+base_version（重放 created:false）· 词统一小写规范形
          </div>
        </div>
        <span className="tag gray">{entries.length} 词</span>
      </div>

      <div className="row mt12" style={{ gap: 8 }}>
        <input
          className="input grow"
          value={newWord}
          disabled={submitting}
          placeholder="新增词条后回车或点击添加（小写规范形自动收口）"
          aria-label="新增词条"
          onChange={(e) => setNewWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addWord();
          }}
        />
        <select
          className="input"
          style={{ width: 150 }}
          value={newAction}
          disabled={submitting}
          aria-label="词条处置级"
          onChange={(e) => setNewAction(e.target.value as WordAction)}
        >
          {WORD_ACTION_VALUES.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}（{a}）
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-g btn-sm" disabled={submitting} onClick={addWord}>
          添加
        </button>
      </div>

      <div className="hr-soft" />
      {entries.length === 0 ? (
        <div className="small muted">
          暂存词集为空——空 words 合法（=清空词库的版本：提交后该库判定零命中放行）。
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 8 }}>
          {entries.map((w) => (
            <span key={w.word} className="tag gray" style={{ gap: 8 }}>
              <b>{w.word}</b>
              <span className={WORD_ACTION_TAG_CLASS[w.action] ?? 'tag gray'}>
                {actionLabel(w.action)}
              </span>
              <button
                type="button"
                aria-label={`移除词条 ${w.word}`}
                style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }}
                disabled={submitting}
                onClick={() => setEntries((prev) => prev.filter((e) => e.word !== w.word))}
              >
                <span className="tiny" style={{ color: 'var(--ljr-accent-dk)' }}>
                  ×
                </span>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 版本 diff 面板：新增 N / 移除 N（词集集合语义；action 变更计为新增+移除） */}
      <div className="mt12 glass-card" style={{ padding: '10px 14px' }}>
        <div className="spread">
          <span className="small">
            版本 diff（v{view.version} → 提交稿）：
            <span className="tag" style={{ marginLeft: 6 }}>
              新增 {diff.added.length}
            </span>
            <span className="tag acc" style={{ marginLeft: 6 }}>
              移除 {diff.removed.length}
            </span>
          </span>
          <span className="tiny muted">
            {diff.added.length === 0 && diff.removed.length === 0
              ? '无词集变化（重放=内容全等幂等回读 created:false）'
              : '提交即生效（免公示通道，自动机即时重建）'}
          </span>
        </div>
        {diff.added.length > 0 ? (
          <div className="row wrap mt8" style={{ gap: 6 }}>
            {diff.added.map((w) => (
              <span key={`add-${w.word}`} className="tag">
                +{w.word}
              </span>
            ))}
          </div>
        ) : null}
        {diff.removed.length > 0 ? (
          <div className="row wrap mt8" style={{ gap: 6 }}>
            {diff.removed.map((w) => (
              <span key={`rm-${w.word}`} className="tag acc">
                −{w.word}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {formError !== null ? <div className="field-error mt8">{formError}</div> : null}
      {error !== null ? (
        <div className="error-banner mt8" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      <div className="row mt12" style={{ gap: 12 }}>
        <button type="button" className="btn btn-o grow" onClick={onCancel} disabled={submitting}>
          取消（丢弃暂存）
        </button>
        <button
          type="button"
          className="btn btn-g grow"
          disabled={submitting}
          onClick={() => void submit()}
        >
          {submitting
            ? '提交中…'
            : `提交 v${view.version + 1}（${entries.length} 词${
                diff.added.length + diff.removed.length > 0
                  ? ` · 新增 ${diff.added.length} / 移除 ${diff.removed.length}`
                  : ''
              }）`}
        </button>
      </div>
      <div className="tiny muted mt8">
        词库提交驱动全站风控判定（E1 硬拦词表同源）——提交前请核对 diff；并发窗口 base_version 过期 →
        409（页面自动刷新词库，需基于最新版本重编辑）。
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 处置弹层（POST /admin/risk/records/:id/review：verdict 三选 + note 可选 +
// CONFIRM_BLOCK 危险值二段确认）
// ---------------------------------------------------------------------------

function ReviewModal(props: {
  record: RiskQueueItem;
  onClose: () => void;
  runReview: (record: RiskQueueItem, body: { verdict: string; note?: string }) => Promise<void>;
}) {
  const { record, onClose, runReview } = props;
  const [verdict, setVerdict] = useState<string>('MARK_ONLY');
  const [note, setNote] = useState('');
  const [armed, setArmed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hits = parseWordHits(record.word_hits);
  const danger =
    REVIEW_VERDICT_LABELS[verdict as keyof typeof REVIEW_VERDICT_LABELS]?.danger ?? false;

  async function submit(): Promise<void> {
    // 前端防呆先行；服务端 parseReviewBody 同规则兜底（双层）
    const built = buildReviewBody(verdict, note);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    if (danger && !armed) {
      setArmed(true); // 危险值二段确认门：确认拦截=终态回填不可翻案（幂等键=record）
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await runReview(record, built.value);
    } catch (err) {
      setError(errorCopy(err)); // 409 已被 runReview 收口为横幅+刷新
    } finally {
      setSubmitting(false);
      setArmed(false);
    }
  }

  return (
    <div className="mask" role="dialog" aria-modal="true" aria-label={`人审处置 #${record.id}`}>
      <div className="modal">
        <div className="spread mb12">
          <span className="h2">人审处置 · #{record.id}</span>
          <button type="button" className="m-x" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="glass-card" style={{ padding: '12px 14px' }}>
          <div className="spread">
            <span className={WORD_ACTION_TAG_CLASS[record.action] ?? 'tag gray'}>
              机审{actionLabel(record.action)}
            </span>
            <span className="tiny muted">
              {DICT_TYPE_LABELS[record.dict_type] ?? record.dict_type} · {record.dict_type}
            </span>
          </div>
          <div className="row wrap mt8" style={{ gap: 6 }}>
            {hits.length === 0 ? (
              <span className="tiny muted">空命中集</span>
            ) : (
              hits.map((h, i) => (
                <span key={`${record.id}-hit-${i}`} className="tag">
                  {h.word}
                  <span className="tiny muted">·v{h.rule_version ?? '—'}</span>
                </span>
              ))
            )}
          </div>
          <div className="tiny muted mt8">
            入队 {formatDateTime(record.created_at)} · 会话{' '}
            {record.conversation_id === null ? '—' : `#${record.conversation_id}`} · 消息{' '}
            {record.message_id === null ? '—（判定先于落库）' : `#${record.message_id}`}
          </div>
        </div>

        <fieldset className="field mt12" style={{ border: 0, padding: 0, marginInline: 0 }}>
          <legend className="label">
            处置结论（verdict 三值——终态回填不可翻案，幂等键=record）
          </legend>
          <div className="action-list">
            {REVIEW_VERDICT_VALUES.map((v) => (
              <label
                key={v}
                className={`action-opt${verdict === v ? ' on' : ''}${
                  verdict === v && REVIEW_VERDICT_LABELS[v]!.danger ? ' danger' : ''
                }`}
                onClick={() => {
                  setVerdict(v);
                  setArmed(false); // 切结论重置确认门
                }}
              >
                <input
                  type="radio"
                  name="review-verdict"
                  checked={verdict === v}
                  onChange={() => {
                    setVerdict(v);
                    setArmed(false);
                  }}
                />
                <span className="grow">
                  <b className="small">{REVIEW_VERDICT_LABELS[v]!.label}</b>
                  <code className="tiny muted"> {v}</code>
                  <div className="tiny muted">{REVIEW_VERDICT_LABELS[v]!.note}</div>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label className="label" htmlFor="rk-note">
            处置备注 note（可选，≤500 字——审计留痕不静默截断）
          </label>
          <textarea
            id="rk-note"
            className={`input textarea${formError !== null && note.trim() !== '' && note.length > 500 ? ' invalid' : ''}`}
            value={note}
            disabled={submitting}
            placeholder="处置依据 / 上下文注记…（空=不留备注）"
            onChange={(e) => {
              setNote(e.target.value);
              if (armed) setArmed(false);
            }}
          />
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
            className={`btn grow ${danger ? 'btn-danger-o' : 'btn-g'}`}
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting
              ? '提交中…'
              : armed
                ? `确认${REVIEW_VERDICT_LABELS[verdict as keyof typeof REVIEW_VERDICT_LABELS]!.label}（再次点击提交）`
                : `提交处置（${REVIEW_VERDICT_LABELS[verdict as keyof typeof REVIEW_VERDICT_LABELS]!.label}）`}
          </button>
        </div>
        <div className="tiny muted mt8">
          已处置记录重放 → 409 DONE（首次 verdict 保留，不再审计）；处置回填 verdict/note/by/at
          行内留痕 + audit_logs 操作审计同事务（双面审计）——队列刷新后该行自动跌出。
        </div>
      </div>
    </div>
  );
}
