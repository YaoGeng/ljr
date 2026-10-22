/**
 * AI 草稿审查页（M3-W2 T6，新推栈页 lawyerDrafts——落 T5 占位键；对照原型 l-room 草稿
 * 气泡区）：律师端草稿气泡审查 UI（E1 三动作=send/edit_send/discard——R-05 审查不可省略，
 * 每张草稿独立动作，无「全部发送」批量捷径）。
 *
 *   ① 列表=GET /agent/drafts?room_id=&status=（W2-2：HTTP 轮询承载——手动刷新+回前台重拉
 *      （T4 N-5 先例）+**前台态 20s 低频 interval 重拉**（评审修复环 I-3：屏幕常开期间可
 *      见更新；非秒级——dev 单实例低频面；卸载清表针/后台态不烧请求）；WSS 推送帧不依赖）。
 *      PENDING 优先置顶（sortAgentDraftsPendingFirst）+ 五态筛选 chip（映射表单源）；
 *      room_id 从看板跳转 params 带入（parseAgentDraftsRoomParam：number/数字串双收——
 *      评审修复环 I-5），屏内可改号直达（沿看板直达形态——session→room 无查询面缺口，T5 登记）；
 *   ② 草稿卡=question_digest（脱敏后摘要，占位符形态）/content（**R-04 标记
 *      「【AI 辅助，仅供参考】」原样展示禁剥离**）/placeholders 占位符→原文映射**还原显示
 *      （仅律师端可见性——E1 §3 注记）**：以「还原原文」toggle 承载（占位符↔原文对照，
 *      最简可验收形态——决策见任务报告）/target_user/created_at/latency_ms；
 *   ③ 三动作（R-05 每动作独立确认或直接钮）：
 *      send=危险级确认面板（内容将作为律师消息进公屏）→ POST {action:'send'}；
 *      edit_send=编辑器（预填还原后草稿正文+**编辑器注记行**——评审修复环 I-1/I-2：
 *      「公屏可见+含个人信息请按需保留+如保留 AI 标记请勿删除」非阻断提示：core 对
 *      edited_content 无 R-04 标记校验=core 缺口+待澄清（T9 登记 04 §8），UI 不硬拦不发明）
 *      → POST {action:'edit_send', edited_content}；
 *      discard=直接钮（原型同形态）→ POST {action:'discard'}；
 *   ④ 状态处理：409 EXPIRED（已被处理/超时置换）→错误横幅+列表刷新对齐；幂等重放
 *      （deduplicated=true）→结果横幅注记（core 幂等返回同态）；动作后列表刷新+结果回显
 *      （send/edit_send 后 SENT/EDITED_SENT 徽标——消息可见性由看板消息段承载，本页注记入口）；
 *   ⑤ 降级=GET /agent/health degraded 时屏顶显式「AI 辅助不可用，手打不受阻」条
 *      （T2 先例复用）+草稿列表照常（已有草稿仍可审）。
 *
 * 设计铁律：红点缀=PENDING 焦点卡一张（accentCard，列表首张待审卡）+发送主按钮（小面积）
 * +危险确认面板主钮+降级条；其余橄榄绿系。
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ErrorCode } from '@ljr/shared';
import {
  agentDraftActionNote,
  agentDraftStatusCopy,
  fetchAgentDrafts,
  parseAgentDraftsRoomParam,
  restorePlaceholders,
  sendDraftAction,
  sortAgentDraftsPendingFirst,
  type AgentDraftStatus,
  type AgentDraftView,
} from '../api/agent-drafts';
import { isAppApiError } from '../api/client';
import { agentHealthCopy } from '../api/lawyer-copy';
import { fetchAgentHealth } from '../api/lawyer-stats';
import { useResource } from '../api/useResource';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { formatDateTime } from '../utils/date';

/** 直达输入本地校验：正整数（core parse-positive-int 镜像） */
function parseDirectId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const isForbidden = (e: unknown): boolean => isAppApiError(e) && e.code === ErrorCode.RoleForbidden;

/**
 * 前台态低频重拉间隔（评审修复环 I-3）：20s 量级——屏幕常开期间草稿可自动出现/流转，
 * 非秒级（W2-2「不做秒级 ticker」口径保留）；后台态/卸载不烧请求（interval 门+清理）。
 */
const DRAFT_POLL_INTERVAL_MS = 20_000;

/** 筛选 chip 值域：全部 + 五态（映射表单源 agentDraftStatusCopy） */
type DraftFilter = 'ALL' | AgentDraftStatus;

const DRAFT_FILTERS: readonly DraftFilter[] = [
  'ALL',
  'PENDING',
  'SENT',
  'EDITED_SENT',
  'DISCARDED',
  'EXPIRED',
];

function filterCopy(f: DraftFilter): string {
  return f === 'ALL' ? '全部' : agentDraftStatusCopy(f);
}

interface ActionErrorView {
  readonly message: string;
  readonly code: string;
}

export function LawyerDraftsScreen({
  params,
}: {
  readonly params?: Readonly<Record<string, unknown>>;
}) {
  const paramRoomId = parseAgentDraftsRoomParam(params?.['room_id']);

  // ---- 房间过滤（params 带入 or 屏内直达输入；tick=同号重提交也触发重拉——T5 I-3 先例） ----
  const [roomInput, setRoomInput] = useState('');
  const [roomError, setRoomError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<number | null>(paramRoomId);
  const [roomTick, setRoomTick] = useState(0);

  // ---- 五态筛选（缺省全态——PENDING 置顶由排序承载） ----
  const [filter, setFilter] = useState<DraftFilter>('ALL');

  const drafts = useResource(
    () =>
      fetchAgentDrafts({
        ...(roomId !== null ? { room_id: roomId } : {}),
        ...(filter !== 'ALL' ? { status: filter } : {}),
      }),
    [roomId, roomTick, filter],
  );
  const health = useResource(() => fetchAgentHealth(), []);

  // 最近一次就绪行（评审修复环 I-3 配套）：低频重拉的 loading 相不闪空白——就绪后有旧
  // 数据时渲染旧列表（静默换新），无旧数据（首载/换过滤条件）才显 LoadingHint
  const [lastRows, setLastRows] = useState<readonly AgentDraftView[] | null>(null);
  useEffect(() => {
    if (drafts.state.phase === 'ready') setLastRows(drafts.state.data);
  }, [drafts.state]);
  // 换过滤条件（房间/筛选）=语义切换，旧条件数据不留作过渡（避免跨过滤态误导）
  useEffect(() => {
    setLastRows(null);
  }, [roomId, roomTick, filter]);

  // 前台态跟踪（回前台重拉 T4 N-5 先例 + interval 门共用一个 ref）
  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      appStateRef.current = s;
      if (s === 'active') {
        drafts.reload();
        health.reload();
      }
    });
    return () => sub.remove();
  }, []);

  // 低频 interval 重拉（评审修复环 I-3：挂载且前台态每 20s 重拉——屏幕常开期间草稿可见
  // 更新；后台态不发（门 ref）；卸载清表针）。reload 引用稳定（useCallback），effect 恒装一次
  useEffect(() => {
    const timer = setInterval(() => {
      if (appStateRef.current === 'active') {
        drafts.reload();
        health.reload();
      }
    }, DRAFT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // ---- 三动作（R-05：每张独立；编辑器/危险确认面板互斥单开） ----
  const [confirmSend, setConfirmSend] = useState<AgentDraftView | null>(null);
  const [editing, setEditing] = useState<{ readonly draft: AgentDraftView; text: string } | null>(
    null,
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionErrorView | null>(null);

  function submitRoom(): void {
    const rid = parseDirectId(roomInput);
    if (rid === null) {
      setRoomError('请输入正整数房间号');
      return;
    }
    setRoomError(null);
    setRoomId(rid);
    setRoomTick((t) => t + 1); // 同号重提交=重拉
  }

  function toActionError(e: unknown, fallbackAction: string): ActionErrorView {
    if (isAppApiError(e)) {
      // 409 EXPIRED 专项文案（E1 §5：已被处理/被同用户新问题置换——刷新对齐口径）
      if (e.code === ErrorCode.Conflict) {
        return {
          message:
            '草稿已被处理或已失效（409 EXPIRED）——同用户最新提问会自动置换旧草稿；列表已刷新对齐最新状态',
          code: e.code,
        };
      }
      return { message: e.message, code: e.code };
    }
    return { message: `${fallbackAction}失败，请稍后重试`, code: 'UNKNOWN' };
  }

  /** 动作收口（T5 runAction 同形）：成功=结果横幅+列表刷新；失败=错误横幅+列表刷新（态可能已迁） */
  async function runAction(
    draftId: number,
    actionLabel: string,
    job: () => Promise<void>,
  ): Promise<void> {
    setBusyId(draftId);
    setActionError(null);
    try {
      await job();
      drafts.reload();
    } catch (e) {
      setActionError(toActionError(e, actionLabel));
      drafts.reload();
    } finally {
      setBusyId(null);
    }
  }

  function runSend(draft: AgentDraftView): void {
    void runAction(draft.draft_id, '发送', async () => {
      setResult(agentDraftActionNote(await sendDraftAction(draft.draft_id, 'send')));
    });
  }

  function runEditSend(): void {
    const current = editing;
    if (current === null) return;
    if (current.text.trim().length === 0) {
      setEditError('修改稿不能为空——请输入回复内容（或改用直接发送）');
      return;
    }
    setEditError(null);
    void runAction(current.draft.draft_id, '修改后发送', async () => {
      setResult(
        agentDraftActionNote(
          await sendDraftAction(current.draft.draft_id, 'edit_send', current.text),
        ),
      );
      setEditing(null);
    });
  }

  function runDiscard(draft: AgentDraftView): void {
    void runAction(draft.draft_id, '丢弃', async () => {
      setResult(agentDraftActionNote(await sendDraftAction(draft.draft_id, 'discard')));
    });
  }

  const healthReady = health.state.phase === 'ready' ? health.state.data : null;
  // 展示行：就绪=当前数据；低频重拉中=最近就绪行（评审 I-3 静默换新——不闪空白）；首载=空
  const listRows =
    drafts.state.phase === 'ready'
      ? drafts.state.data
      : drafts.state.phase === 'loading' && lastRows !== null
        ? lastRows
        : [];
  const rows = sortAgentDraftsPendingFirst(listRows);
  // PENDING 焦点卡一张（设计铁律）：置顶排序后首张待审卡
  const focusDraftId = rows.find((d) => d.status === 'PENDING')?.draft_id ?? null;

  return (
    <View style={styles.screenWrap}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel="AI 草稿审查"
      >
        {/* ⑤ AI 辅助降级条（T2 先例复用：degraded=红条显式不可用；探针失败=状态未知中性灰） */}
        {health.state.phase === 'ready' && healthReady !== null ? (
          healthReady.status === 'degraded' ? (
            <View style={styles.aiDegradedBar}>
              <Text style={styles.aiDegradedText}>
                {agentHealthCopy(healthReady.status)}——AI
                草稿暂不会新生成，手动回复不受阻；已有草稿仍可审查
              </Text>
            </View>
          ) : (
            <View style={styles.aiOkBar}>
              <Text style={styles.aiOkText}>{agentHealthCopy(healthReady.status)}</Text>
            </View>
          )
        ) : health.state.phase === 'error' ? (
          <View style={styles.aiUnknownBar}>
            <Text style={styles.aiUnknownText}>AI 辅助状态未知</Text>
            <Button label="重试" variant="ghost" small onPress={health.reload} />
          </View>
        ) : null}

        {/* 动作结果横幅（幂等重放注记含在 agentDraftActionNote 单源文案内） */}
        {result !== null ? (
          <GlassCard style={styles.resultCard}>
            <Text style={styles.resultTitle}>{result}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭结果提示"
              onPress={() => setResult(null)}
              style={styles.resultClose}
              hitSlop={8}
            >
              <Text style={styles.resultCloseText}>知道了</Text>
            </Pressable>
          </GlassCard>
        ) : null}

        {/* 动作失败横幅（409 EXPIRED 专项文案在 toActionError 单点收口） */}
        {actionError !== null ? (
          <GlassCard style={styles.errorBanner}>
            <Text style={styles.errorBannerTitle}>操作未完成</Text>
            <Text style={styles.errorBannerText}>{actionError.message}</Text>
            {actionError.code !== 'UNKNOWN' ? (
              <Text style={styles.errorBannerMeta}>{`code=${actionError.code}`}</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭错误提示"
              onPress={() => setActionError(null)}
              style={styles.resultClose}
              hitSlop={8}
            >
              <Text style={styles.resultCloseText}>知道了</Text>
            </Pressable>
          </GlassCard>
        ) : null}

        {/* ---- ① 列表段头：房间直达 + 手动刷新 + 五态筛选 ---- */}
        <SectionHeader
          title="草稿气泡 · 仅你可见"
          note="Agent 输出永不直进公屏——每张草稿须经你的动作（R-05 审查不可省略）"
          actionLabel="刷新"
          onAction={() => {
            drafts.reload();
            health.reload();
          }}
        />
        <GlassCard style={styles.card}>
          <View style={styles.directRow}>
            <Field
              accessibilityLabel="房间号输入"
              placeholder={`房间号${roomId !== null ? `（当前 ${roomId}）` : '，留空=全部房间'}`}
              keyboardType="number-pad"
              value={roomInput}
              onChangeText={(t) => {
                setRoomInput(t);
                setRoomError(null);
              }}
              onSubmitEditing={submitRoom}
              style={styles.directField}
              invalid={roomError !== null}
            />
            <Button label="筛选房间" variant="secondary" small onPress={submitRoom} />
          </View>
          <ErrorText>{roomError ?? ''}</ErrorText>
          <MutedText>
            {roomId === null
              ? '当前=全部房间的草稿（房号直达与看板跳转携带房号时按房过滤——场次接口暂不返回房间号，缺口已登记）'
              : `当前=房间 #${roomId} 的草稿；数据面=HTTP 拉取（手动刷新/回前台自动重拉）`}
          </MutedText>
          <View style={styles.chipRow}>
            {DRAFT_FILTERS.map((f) => (
              <Pressable
                key={f}
                accessibilityRole="button"
                accessibilityLabel={`筛选${filterCopy(f)}`}
                accessibilityState={{ selected: filter === f }}
                onPress={() => setFilter(f)}
                style={[styles.chip, filter === f && styles.chipOn]}
              >
                <Text style={[styles.chipText, filter === f && styles.chipTextOn]}>
                  {filterCopy(f)}
                </Text>
              </Pressable>
            ))}
          </View>
          <MutedText>
            待审查置顶；已失效=同用户更新提问到达时旧草稿自动作废（R-06 去重置换）。
          </MutedText>
        </GlassCard>

        {/* ---- ② 草稿卡列表 ---- */}
        {/* 首载/换过滤才显 LoadingHint；低频重拉中静默换新（旧列表在场——评审 I-3 配套） */}
        {drafts.state.phase === 'loading' && lastRows === null ? (
          <LoadingHint label="草稿加载中…" />
        ) : null}
        {drafts.state.phase === 'error' && isForbidden(drafts.state.error) ? (
          <EmptyHint text="非该房间参与方（403 成员门：场次律师 / PAID 报名用户可查草稿）" />
        ) : drafts.state.phase === 'error' ? (
          <ErrorPanel error={drafts.state.error} onRetry={drafts.reload} />
        ) : null}
        {drafts.state.phase === 'ready' && rows.length === 0 ? (
          <EmptyHint
            text={
              filter === 'PENDING'
                ? '暂无待审查草稿——房间内用户提问后自动生成（AI 辅助正常时）'
                : '暂无草稿记录'
            }
          />
        ) : null}
        {rows.length > 0
          ? rows.map((d) => (
              <DraftCard
                key={d.draft_id}
                draft={d}
                focused={d.draft_id === focusDraftId}
                editing={editing?.draft.draft_id === d.draft_id ? editing : null}
                busy={busyId === d.draft_id}
                editError={editing?.draft.draft_id === d.draft_id ? editError : null}
                onToggleEdit={() => {
                  // 打开编辑器：预填还原后草稿正文（占位符→原文——仅律师端可见的映射，报告决策）
                  setEditing({ draft: d, text: restorePlaceholders(d.content, d.placeholders) });
                  setEditError(null);
                }}
                onCancelEdit={() => {
                  setEditing(null);
                  setEditError(null);
                }}
                onEditText={(t) =>
                  setEditing((prev) => (prev === null ? prev : { ...prev, text: t }))
                }
                onSubmitEdit={runEditSend}
                onAskSend={() => setConfirmSend(d)}
                onDiscard={() => runDiscard(d)}
              />
            ))
          : null}

        <MutedText>
          发送/修改后发送的内容将作为你的律师消息进入会话（经风控与发号链路——与手打完全同
          路径）；消息内容可在「场次看板 → 会话消息」查看。丢弃仅留审查痕迹，不产生消息。
        </MutedText>
      </ScrollView>

      {/* send 危险确认面板（R-05：内容进公屏前显式确认——绝对定位覆盖层，T4/T5 同形态） */}
      {confirmSend !== null ? (
        <View style={styles.panelOverlay}>
          <GlassCard style={styles.panelCardDanger}>
            <Text style={styles.panelTitle}>以你的名义发送该草稿？</Text>
            <MutedText>
              草稿内容（含「【AI 辅助，仅供参考】」标注）将作为你的律师消息进入会话公屏，
              全体成员可见。Agent 输出不直接上屏——本次发送即你的审查确认动作（R-05）。
            </MutedText>
            <Text style={styles.panelExcerpt} numberOfLines={4}>
              {confirmSend.content}
            </Text>
            <View style={styles.panelBtns}>
              <Button label="再想想" variant="ghost" small onPress={() => setConfirmSend(null)} />
              <Button
                label="确认发送"
                variant="primary"
                small
                busy={busyId === confirmSend.draft_id}
                onPress={() => {
                  const target = confirmSend;
                  setConfirmSend(null);
                  runSend(target);
                }}
              />
            </View>
          </GlassCard>
        </View>
      ) : null}
    </View>
  );
}

/** 单卡（原型 draftCard 对照：ctx 行 + 正文 + AI 标记 + 三动作；PENDING 外只读态） */
function DraftCard({
  draft,
  focused,
  editing,
  busy,
  editError,
  onToggleEdit,
  onCancelEdit,
  onEditText,
  onSubmitEdit,
  onAskSend,
  onDiscard,
}: {
  readonly draft: AgentDraftView;
  /** PENDING 焦点卡（accentCard 一张铁律位） */
  readonly focused: boolean;
  readonly editing: { readonly draft: AgentDraftView; readonly text: string } | null;
  readonly busy: boolean;
  readonly editError: string | null;
  readonly onToggleEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onEditText: (text: string) => void;
  readonly onSubmitEdit: () => void;
  readonly onAskSend: () => void;
  readonly onDiscard: () => void;
}) {
  // 占位符还原显示（仅律师端——E1 §3）：toggle 逐卡持有（本组件内 useState）
  const [showOriginal, setShowOriginal] = useState(false);
  const hasPlaceholders = Object.keys(draft.placeholders).length > 0;
  const displayQuestion = showOriginal
    ? restorePlaceholders(draft.question_digest, draft.placeholders)
    : draft.question_digest;
  const displayContent = showOriginal
    ? restorePlaceholders(draft.content, draft.placeholders)
    : draft.content;
  const isEditing = editing !== null;
  const pending = draft.status === 'PENDING';

  return (
    <GlassCard
      style={[styles.card, focused && styles.focusCard, isEditing && styles.editingCard]}
      accessibilityLabel={`草稿卡 ${draft.draft_id} ${agentDraftStatusCopy(draft.status)}`}
    >
      {/* ctx 行：草稿号 + 目标用户 + 状态徽标 */}
      <View style={styles.draftCtxRow}>
        <Text style={styles.draftCtx} numberOfLines={1}>
          {`草稿 #${draft.draft_id} · 回复用户 #${draft.target_user_id} · 房间 #${draft.room_id}`}
        </Text>
        <View style={[styles.statusPill, focused && styles.statusPillFocus]}>
          <Text style={[styles.statusText, focused && styles.statusTextFocus]}>
            {agentDraftStatusCopy(draft.status)}
          </Text>
        </View>
      </View>

      {/* 问题摘要（脱敏后——占位符形态/还原态 toggle） */}
      <View>
        <Text style={styles.draftQuestion}>{displayQuestion}</Text>
        {hasPlaceholders ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showOriginal ? '隐藏占位符原文' : '还原占位符原文'}
            onPress={() => setShowOriginal((v) => !v)}
            hitSlop={6}
          >
            <Text style={styles.toggleText}>
              {showOriginal ? '〔隐藏原文（脱敏态）〕' : '〔还原原文 · 仅律师可见〕'}
            </Text>
          </Pressable>
        ) : null}
        {showOriginal ? (
          <View style={styles.mapBlock}>
            {Object.entries(draft.placeholders).map(([token, original]) => (
              <Text key={token} style={styles.mapRow}>{`${token} → ${original}`}</Text>
            ))}
          </View>
        ) : null}
      </View>

      {/* 草稿正文（R-04 标记原样展示禁剥离——直接渲染 content） */}
      {isEditing ? (
        <>
          {/* 编辑器注记行（评审修复环 I-1/I-2：公屏可见+个人信息最小化+标记保留——非阻断提示，
              core 对 edited_content 无标记校验=core 缺口+待澄清，UI 不硬拦不发明） */}
          <View style={styles.editNoteBlock}>
            <Text style={styles.editNoteText}>
              编辑稿将以你的律师消息发送至房间公屏（全体成员可见）；草稿原文含用户个人信息，
              请按需保留。如需保留 AI 辅助标记（【AI 辅助，仅供参考】）请勿删除。
            </Text>
          </View>
          <Field
            accessibilityLabel="修改草稿正文"
            multiline
            value={editing.text}
            onChangeText={onEditText}
            style={styles.editField}
          />
        </>
      ) : (
        <View style={styles.draftContentBlock}>
          <Text style={styles.draftContent}>{displayContent}</Text>
        </View>
      )}
      {editError !== null && isEditing ? <ErrorText>{editError}</ErrorText> : null}

      {/* meta 行 + 动作行 */}
      <View style={styles.metaRow}>
        <Text style={styles.metaText}>
          {`生成 ${formatDateTime(draft.created_at)}${
            draft.latency_ms !== null ? ` · 管线 ${draft.latency_ms}ms` : ''
          }${draft.replied_at !== null ? ` · 处理 ${formatDateTime(draft.replied_at)}` : ''}`}
        </Text>
      </View>
      <View style={styles.actionRow}>
        <Text style={styles.aiTag}>AI 辅助 · 仅供参考</Text>
        {isEditing ? (
          <>
            <Button label="取消" variant="ghost" small onPress={onCancelEdit} disabled={busy} />
            <Button
              label="发送修改稿"
              variant="primary"
              small
              busy={busy}
              disabled={busy}
              onPress={onSubmitEdit}
            />
          </>
        ) : pending ? (
          <>
            <Button
              label="丢弃"
              variant="ghost"
              small
              busy={busy}
              disabled={busy}
              onPress={onDiscard}
            />
            <Button
              label="修改后发送"
              variant="secondary"
              small
              busy={busy}
              disabled={busy}
              onPress={() => onToggleEdit()}
            />
            <Button
              label="发送"
              variant="primary"
              small
              busy={busy}
              disabled={busy}
              onPress={onAskSend}
            />
          </>
        ) : (
          <Text style={styles.doneNote}>
            已处理（{agentDraftStatusCopy(draft.status)}）——留档可查
          </Text>
        )}
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  screenWrap: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  card: { padding: spacing.lg, gap: spacing.sm },
  /** PENDING 焦点卡（一组仅一张——accentCard 红点缀铁律位） */
  focusCard: { backgroundColor: colors.accentCard, borderColor: colors.dangerLine },
  editingCard: { borderColor: colors.primary2 },
  aiOkBar: {
    borderRadius: radius.pill,
    backgroundColor: colors.primary2A15,
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
  },
  aiOkText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  aiUnknownBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A15,
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
  },
  aiUnknownText: { color: colors.ink2, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  /** 降级条（T2 aiDegradedBar 同形：红浅底+危险描边——小面积点缀位） */
  aiDegradedBar: {
    borderRadius: radius.md,
    backgroundColor: colors.accentCard,
    borderWidth: 1,
    borderColor: colors.dangerLine,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  aiDegradedText: { color: colors.accentDk, fontSize: fontSize.sm, lineHeight: 18 },
  resultCard: { padding: spacing.lg, gap: spacing.sm },
  resultTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  resultClose: { alignSelf: 'flex-start' },
  resultCloseText: { color: colors.primary, fontSize: fontSize.sm },
  errorBanner: { padding: spacing.lg, gap: spacing.xs, borderColor: colors.dangerLine },
  errorBannerTitle: {
    color: colors.accentDk,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
  },
  errorBannerText: { color: colors.accentDk, fontSize: fontSize.sm, lineHeight: 18 },
  errorBannerMeta: { color: colors.ink2, fontSize: fontSize.xs },
  directRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  directField: { flex: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginVertical: spacing.xs },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.glass,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  chipOn: {
    backgroundColor: colors.primary2A15,
    borderColor: colors.primary2,
  },
  chipText: { color: colors.ink2, fontSize: fontSize.sm },
  chipTextOn: { color: colors.primary, fontWeight: fontWeight.medium },
  draftCtxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  draftCtx: { color: colors.ink2, fontSize: fontSize.xs, flexShrink: 1 },
  statusPill: {
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A15,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
  },
  /** 焦点卡状态徽标=绿底（红已占卡面点缀位——徽标不叠第二红） */
  statusPillFocus: { backgroundColor: colors.primary2A15 },
  statusText: { color: colors.ink2, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  statusTextFocus: { color: colors.primary },
  draftQuestion: { color: colors.ink, fontSize: fontSize.sm, lineHeight: 18 },
  toggleText: { color: colors.primary, fontSize: fontSize.xs, marginTop: 2 },
  /** 占位符映射对照块（仅律师端还原显示——E1 §3 注记） */
  mapBlock: {
    marginTop: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.ghostFill,
    padding: spacing.md,
    gap: 2,
  },
  mapRow: { color: colors.ink2, fontSize: fontSize.xs, lineHeight: 16 },
  draftContentBlock: {
    borderRadius: radius.md,
    backgroundColor: colors.ghostFill,
    padding: spacing.md,
  },
  draftContent: { color: colors.ink, fontSize: fontSize.base, lineHeight: 21 },
  /** 编辑器注记块（评审 I-1/I-2：浅底描边小字——公屏可见/个人信息/标记保留三句） */
  editNoteBlock: {
    borderRadius: radius.md,
    backgroundColor: colors.ghostFill,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.md,
  },
  editNoteText: { color: colors.ink2, fontSize: fontSize.xs, lineHeight: 16 },
  editField: {
    minHeight: 110,
    textAlignVertical: 'top',
    paddingTop: spacing.md,
  },
  metaRow: { flexDirection: 'row' },
  metaText: { color: colors.ink2, fontSize: fontSize.xs },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  aiTag: {
    color: colors.primary,
    fontSize: fontSize.xs,
    marginRight: 'auto',
  },
  doneNote: { color: colors.ink2, fontSize: fontSize.xs },
  panelOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(244,246,241,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  panelCardDanger: {
    padding: spacing.lg,
    gap: spacing.sm,
    width: '100%',
    maxWidth: 330,
    borderColor: colors.dangerLine,
  },
  panelTitle: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  panelExcerpt: {
    color: colors.ink2,
    fontSize: fontSize.sm,
    lineHeight: 18,
    maxHeight: 76,
    overflow: 'hidden',
  },
  panelBtns: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
