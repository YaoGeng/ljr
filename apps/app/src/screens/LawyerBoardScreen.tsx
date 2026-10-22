/**
 * 场次看板（M3-W2 T5，新推栈页；对照原型 l-sessd）：律师视角 HTTP 只读聚合
 * （W2-5：房间音视频/RTC 不做）——详情头（任意态）+ 房间段（出席/公告/草稿入口）+
 * 会话消息段（只读+after_seq 增量）+ 关房/取消两动作。
 *
 *   ① 详情头=GET /sessions/{id}（任意态可达——十态徽标/时间/价格/容量/已报名/剩余席位）；
 *   ② 房间段=GET /rooms/{room_id}/attendance + GET /rooms/{id}/notice——⚠契约缺口如实
 *      承载：场次详情出参不含 room_id，全 HTTP 面亦无「按场次查房间」端点（任务核对结论，
 *      禁发明）——以「房间号直达输入」承载，输入后两段同时聚合；404=房间未开放如实态；
 *   ③ 消息段=GET /conversations/{id}/messages（只读；成员门=JWT 本人=场次律师/PAID 报名）
 *      ——⚠同族缺口：无「按房间查会话」端点，conversation_id 以直达输入承载；
 *      分页=after_seq 独占下界+seq 升序=向新翻页（首页缺省=最早一页 50 条，逐页「加载较新
 *      消息」锚=已载末条 seq，尾页=返回数<limit——修复环 I-1 方向语义钉）；
 *   ④ 动作：POST /rooms/{session_id}/close（D1 §5 律师端关房——危险确认；409 NOT_OPEN=
 *      已终态语义经错误横幅承载）/ POST /sessions/{session_id}/cancel {role:"lawyer"}
 *      （D4 §5+core 实文律师可取消：≥24h 全退+信用-10；<24h 平台审批——结果横幅按
 *      result 三支单源文案）。
 *
 * 设计铁律：红点缀=价格数字+危险动作描边钮+确认面板主按钮；动作失败横幅=危险态小面积。
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ErrorCode } from '@ljr/shared';
import {
  attendanceStatusCopy,
  cancelSessionAsLawyer,
  closeRoom,
  fetchConversationMessages,
  fetchRoomAttendance,
  fetchRoomNotice,
  lawyerCancelResultNote,
  nextPageAfterSeq,
  senderRoleCopy,
  MESSAGES_LIMIT_DEFAULT,
  type AttendanceView,
  type MessageView,
  type RoomNoticeView,
} from '../api/lawyer-board';
import { isAppApiError } from '../api/client';
import { formatMoney } from '../api/money';
import { fetchSessionDetail } from '../api/sessions';
import {
  isSessionTerminal,
  priceModeCopy,
  roomModeCopy,
  sessionStatusCopy,
  specialtyCopy,
} from '../api/session-copy';
import { useResource } from '../api/useResource';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { SessionStatusBadge } from '../components/session-card';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTime, formatDateTimeFull } from '../utils/date';

/** 直达输入本地校验：正整数（core parse-positive-int 镜像） */
function parseDirectId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const isNotFound = (e: unknown): boolean => isAppApiError(e) && e.code === ErrorCode.NotFound;
const isForbidden = (e: unknown): boolean => isAppApiError(e) && e.code === ErrorCode.RoleForbidden;

type MsgPhase = 'idle' | 'loading' | 'ready' | 'error';

export function LawyerBoardScreen({
  params,
}: {
  readonly params?: Readonly<Record<string, unknown>>;
}) {
  const nav = useNavigation();
  const rawId = params?.['id'];
  const id = typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  const detail = useResource(
    () => (id === null ? Promise.reject(new InvalidBoardIdError(rawId)) : fetchSessionDetail(id)),
    [id],
  );

  // ---- 房间段（出席+公告共用 room_id 直达输入；tick=同号重提交也触发重聚合——修复环 I-3） ----
  const [roomInput, setRoomInput] = useState('');
  const [roomError, setRoomError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [roomTick, setRoomTick] = useState(0);
  const attendance = useResource(
    () => (roomId === null ? Promise.resolve<AttendanceView[]>([]) : fetchRoomAttendance(roomId)),
    [roomId, roomTick],
  );
  const notice = useResource(
    () =>
      roomId === null ? Promise.resolve<RoomNoticeView | null>(null) : fetchRoomNotice(roomId),
    [roomId, roomTick],
  );

  // ---- 消息段（conversation_id 直达 + after_seq 手动增量） ----
  const [convInput, setConvInput] = useState('');
  const [convError, setConvError] = useState<string | null>(null);
  const [convId, setConvId] = useState<number | null>(null);
  const [messages, setMessages] = useState<readonly MessageView[]>([]);
  const [msgPhase, setMsgPhase] = useState<MsgPhase>('idle');
  const [msgError, setMsgError] = useState<unknown>(null);
  const [msgMoreBusy, setMsgMoreBusy] = useState(false);
  const [msgDone, setMsgDone] = useState(false);

  // ---- 动作（关房/取消） ----
  const [panel, setPanel] = useState<'close' | 'cancel' | null>(null);
  const [busyAction, setBusyAction] = useState<'close' | 'cancel' | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    readonly action: string;
    readonly message: string;
    readonly code: string;
  } | null>(null);

  function submitRoom(): void {
    const rid = parseDirectId(roomInput);
    if (rid === null) {
      setRoomError('请输入正整数房间号（房间开房后生成）');
      return;
    }
    setRoomError(null);
    setRoomId(rid);
    setRoomTick((t) => t + 1); // 同号重提交=重聚合（useResource deps 变化——修复环 I-3）
  }

  async function loadMessages(conversationId: number, afterSeq: number): Promise<void> {
    if (afterSeq === 0) {
      setMsgPhase('loading');
      setMessages([]);
      setMsgDone(false);
    } else {
      setMsgMoreBusy(true);
    }
    setMsgError(null);
    try {
      const page = await fetchConversationMessages(
        conversationId,
        afterSeq === 0 ? {} : { after_seq: afterSeq },
      );
      setMessages((prev) => (afterSeq === 0 ? page : [...prev, ...page]));
      if (page.length < MESSAGES_LIMIT_DEFAULT) setMsgDone(true);
      setMsgPhase('ready');
    } catch (e) {
      if (afterSeq === 0) setMsgPhase('error');
      setMsgError(e);
    } finally {
      setMsgMoreBusy(false);
    }
  }

  function submitConv(): void {
    const cid = parseDirectId(convInput);
    if (cid === null) {
      setConvError('请输入正整数会话号（房间会话 id）');
      return;
    }
    setConvError(null);
    setConvId(cid);
    void loadMessages(cid, 0);
  }

  function loadMoreMessages(): void {
    if (convId === null) return;
    // 向新翻页锚=已载末条 seq（修复环 I-1：core 升序+独占下界——追加拉到的是更新的消息）
    const anchor = nextPageAfterSeq(messages);
    if (anchor === null) return;
    void loadMessages(convId, anchor);
  }

  function toActionError(
    action: string,
    e: unknown,
  ): { action: string; message: string; code: string } {
    if (isAppApiError(e)) return { action, message: e.message, code: e.code };
    return { action, message: '操作失败，请稍后重试', code: 'UNKNOWN' };
  }

  /** 动作收口：成功=结果横幅+详情/出席刷新；失败=错误横幅+刷新（状态可能已在服务端迁移） */
  async function runAction(action: 'close' | 'cancel', job: () => Promise<string>): Promise<void> {
    setPanel(null);
    setBusyAction(action);
    setActionError(null);
    try {
      setActionResult(await job());
      detail.reload();
      if (roomId !== null) attendance.reload();
    } catch (e) {
      setActionError(toActionError(action === 'close' ? '关房' : '取消场次', e));
      detail.reload();
    } finally {
      setBusyAction(null);
    }
  }

  function runClose(): void {
    if (id === null) return;
    void runAction('close', async () => {
      const r = await closeRoom(id);
      return `房间已关闭（${formatDateTimeFull(r.closed_at)}）——进入结算流程，迟到/缺席判定照常补判`;
    });
  }

  function runCancel(): void {
    if (id === null) return;
    void runAction('cancel', async () => lawyerCancelResultNote(await cancelSessionAsLawyer(id)));
  }

  if (detail.state.phase === 'loading') {
    return <LoadingHint label="场次看板加载中…" />;
  }
  if (detail.state.phase === 'error') {
    return (
      <View style={styles.errorWrap}>
        <ErrorPanel error={detail.state.error} onRetry={detail.reload} />
        <Button label="返回" variant="ghost" small onPress={nav.pop} />
      </View>
    );
  }

  const s = detail.state.data;
  const roomOpenable = s.status === 'OPEN' || s.status === 'IN_SERVICE';
  const cancellable = !isSessionTerminal(s.status);

  return (
    <View style={styles.screenWrap}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel={`场次看板 ${s.id}`}
      >
        {/* 动作失败横幅（屏顶承载——409 后状态已迁移，详情已刷新对齐） */}
        {actionError !== null ? (
          <GlassCard style={styles.errorBanner}>
            <Text style={styles.errorBannerTitle}>{actionError.action}未完成</Text>
            <Text style={styles.errorBannerText}>{actionError.message}</Text>
            <Text style={styles.errorBannerMeta}>
              场次 #{s.id}
              {actionError.code !== 'UNKNOWN' ? ` · code=${actionError.code}` : ''} · 详情已刷新对齐
              最新状态
            </Text>
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

        {/* 动作结果横幅 */}
        {actionResult !== null ? (
          <GlassCard style={styles.resultCard}>
            <Text style={styles.resultTitle}>{actionResult}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭结果提示"
              onPress={() => setActionResult(null)}
              style={styles.resultClose}
              hitSlop={8}
            >
              <Text style={styles.resultCloseText}>知道了</Text>
            </Pressable>
          </GlassCard>
        ) : null}

        {/* ---- ① 详情头（任意态可达） ---- */}
        <GlassCard style={styles.headCard}>
          <View style={styles.tagRow}>
            <View style={styles.tagGroup}>
              <Text style={styles.tagPrimary}>{specialtyCopy(s.specialty)}</Text>
              <Text style={styles.tag}>{s.city}</Text>
              <Text style={styles.tag}>{roomModeCopy(s.room_mode)}咨询</Text>
              <Text style={styles.tag}>{`场次 #${s.id}`}</Text>
            </View>
            <SessionStatusBadge status={s.status} />
          </View>
          <Text style={styles.headline}>{formatDateTime(s.slot_start)} 开场</Text>
          <View style={styles.divider} />
          <View style={styles.grid}>
            <InfoRow label="开场时间" value={formatDateTimeFull(s.slot_start)} />
            <InfoRow label="报名截止" value={formatDateTimeFull(s.enroll_deadline)} />
            <InfoRow label="已报名 / 容量" value={`${s.joined} / ${s.capacity} 人`} />
            <InfoRow label="剩余席位" value={`${s.remaining} 人`} />
            <InfoRow label="计价方式" value={priceModeCopy(s.price_mode)} />
            <InfoRow
              label={s.price_mode === 'per_head' ? '每人份价格' : '场次总价'}
              value={formatMoney(s.price_mode === 'per_head' ? s.unit_price : s.session_total)}
            />
          </View>
          <View style={styles.progressTextRow}>
            <Text style={styles.progressLabel}>
              报名进度 · 已报 {s.joined}/{s.capacity}（剩余席位 {s.remaining}）
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.min(100, (s.joined / s.capacity) * 100)}%` },
              ]}
            />
          </View>
        </GlassCard>

        {/* ---- ② 房间段：出席 + 公告 + 草稿入口（room_id 直达承载） ---- */}
        <SectionHeader
          title="房间 · 出席名单与须知"
          note="场次接口暂不返回房间号（平台无按场次查房间的接口——缺口已登记）：输入房间号聚合出席与须知"
        />
        <GlassCard style={styles.card}>
          <View style={styles.directRow}>
            <Field
              accessibilityLabel="房间号输入"
              placeholder={`房间号${roomId !== null ? `（当前 ${roomId}）` : '，如 1'}`}
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
            <Button label="聚合出席/须知" variant="secondary" small onPress={submitRoom} />
          </View>
          <ErrorText>{roomError ?? ''}</ErrorText>

          {roomId === null ? (
            <MutedText>
              房间到点自动开放（约定开始时刻）；开房后输入房间号可查看出席判定、房间须知与 AI 草稿。
            </MutedText>
          ) : (
            <>
              {/* 出席子段 */}
              <View style={styles.subBlock}>
                <Text style={styles.subTitle}>{`出席判定（房间 #${roomId}）`}</Text>
                {attendance.state.phase === 'loading' ? (
                  <LoadingHint label="出席名单加载中…" />
                ) : null}
                {attendance.state.phase === 'error' && isNotFound(attendance.state.error) ? (
                  <EmptyHint text="房间未开放——尚未到点开房，或房间号有误（404）" />
                ) : attendance.state.phase === 'error' && isForbidden(attendance.state.error) ? (
                  <EmptyHint text="非本场参与方（403 成员门：场次律师 / PAID 报名用户可查）" />
                ) : attendance.state.phase === 'error' ? (
                  <ErrorPanel error={attendance.state.error} onRetry={attendance.reload} />
                ) : attendance.state.phase === 'ready' ? (
                  attendance.state.data.length === 0 ? (
                    <EmptyHint text="暂无出席判定记录——宽限结束/迟到窗判定后生成" />
                  ) : (
                    <View style={styles.attRows}>
                      {attendance.state.data.map((a) => (
                        <View key={a.user_id} style={styles.attRow}>
                          <View style={styles.attWho}>
                            <Text
                              style={styles.attId}
                            >{`#${a.user_id} · ${senderRoleCopy(a.role)}`}</Text>
                            <Text style={styles.attJoin}>
                              {a.join_at === null
                                ? '未进入'
                                : `首次进入 ${formatDateTimeFull(a.join_at)}`}
                            </Text>
                          </View>
                          <Text
                            style={[
                              styles.attStatus,
                              a.status === 'ABSENT' && styles.attStatusAbsent,
                            ]}
                          >
                            {attendanceStatusCopy(a.status)}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )
                ) : null}
                <MutedText>
                  判定口径：宽限 5 分钟内进入=正常；超宽限 ≤15 分钟=迟到（旁听）；逾 15 分钟或未进=
                  缺席（费用不退）。
                </MutedText>
              </View>

              {/* 公告子段 */}
              <View style={styles.subBlock}>
                <Text style={styles.subTitle}>房间须知</Text>
                {notice.state.phase === 'loading' ? <LoadingHint label="须知加载中…" /> : null}
                {notice.state.phase === 'error' && isNotFound(notice.state.error) ? (
                  <EmptyHint text="须知暂不可用（房间不存在或尚无生效版本）" />
                ) : notice.state.phase === 'error' ? (
                  <ErrorPanel error={notice.state.error} onRetry={notice.reload} />
                ) : notice.state.phase === 'ready' && notice.state.data !== null ? (
                  <View style={styles.noticeBlock}>
                    <Text style={styles.noticeTitle}>{notice.state.data.content.title}</Text>
                    {notice.state.data.content.paragraphs.map((p, i) => (
                      <MutedText key={i}>{p}</MutedText>
                    ))}
                    {notice.state.data.content.disclosures.length > 0 ? (
                      <View style={styles.noticeDisc}>
                        <Text style={styles.noticeDiscTitle}>风险披露</Text>
                        {notice.state.data.content.disclosures.map((d, i) => (
                          <Text key={i} style={styles.noticeDiscText}>
                            {`· ${d}`}
                          </Text>
                        ))}
                      </View>
                    ) : null}
                    <Text style={styles.noticeMeta}>
                      {`版本 v${notice.state.data.version} · 生效 ${formatDateTime(notice.state.data.effectiveAt, { weekday: false })}`}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* 草稿入口（T6 已落位：跳转携带当前房间号——屏内可改号直达） */}
              <Button
                label="AI 草稿审查"
                variant="secondary"
                small
                onPress={() =>
                  nav.push({
                    key: 'lawyerDrafts',
                    ...(roomId !== null ? { params: { room_id: roomId } } : {}),
                  })
                }
              />
            </>
          )}
        </GlassCard>

        {/* ---- ③ 会话消息段（只读 + after_seq 增量；conversation_id 直达承载） ---- */}
        <SectionHeader
          title="会话消息 · 只读"
          note="消息接口按会话号读取（暂无按房间查会话的接口——缺口已登记）；成员门=本场律师/PAID 报名"
        />
        <GlassCard style={styles.card}>
          <View style={styles.directRow}>
            <Field
              accessibilityLabel="会话号输入"
              placeholder={`会话号${convId !== null ? `（当前 ${convId}）` : ''}`}
              keyboardType="number-pad"
              value={convInput}
              onChangeText={(t) => {
                setConvInput(t);
                setConvError(null);
              }}
              onSubmitEditing={submitConv}
              style={styles.directField}
              invalid={convError !== null}
            />
            <Button
              label="拉取消息"
              variant="secondary"
              small
              busy={msgPhase === 'loading'}
              onPress={submitConv}
            />
          </View>
          <ErrorText>{convError ?? ''}</ErrorText>

          {msgPhase === 'idle' ? (
            <MutedText>
              只读查看房间会话历史（律师发送与 AI 草稿经审查后的消息可见）；首次拉取会话最早的
              {` ${MESSAGES_LIMIT_DEFAULT} `}条，之后按序号向新翻页（每页
              {` ${MESSAGES_LIMIT_DEFAULT} `}条）。
            </MutedText>
          ) : null}
          {msgPhase === 'loading' ? <LoadingHint label="消息拉取中…" /> : null}
          {msgPhase === 'error' && isNotFound(msgError) ? (
            <EmptyHint text="会话不存在——请核对话号（404）" />
          ) : msgPhase === 'error' && isForbidden(msgError) ? (
            <EmptyHint text="非本场成员（403 成员门：场次律师 / PAID 报名用户可读）" />
          ) : msgPhase === 'error' ? (
            <ErrorPanel
              error={msgError}
              onRetry={() => convId !== null && void loadMessages(convId, 0)}
            />
          ) : null}
          {msgPhase === 'ready' && messages.length === 0 ? (
            <EmptyHint text="该会话暂无消息" />
          ) : null}
          {msgPhase === 'ready' && messages.length > 0 ? (
            <View style={styles.msgList}>
              {messages.map((m) => (
                <View
                  key={m.message_id}
                  style={[styles.msgRow, m.type === 'system' && styles.msgRowSystem]}
                >
                  <Text style={styles.msgMeta}>
                    {`#${m.seq} · ${senderRoleCopy(m.sender_role)} · ${formatDateTime(m.created_at)}`}
                  </Text>
                  <Text style={m.type === 'system' ? styles.msgContentSystem : styles.msgContent}>
                    {m.content}
                  </Text>
                </View>
              ))}
              {msgDone ? (
                <MutedText>
                  {`已到最新消息（序号 #${messages[messages.length - 1]?.seq ?? '?'} 止）`}
                </MutedText>
              ) : (
                <Button
                  label="加载较新消息"
                  variant="ghost"
                  small
                  busy={msgMoreBusy}
                  disabled={msgMoreBusy}
                  onPress={loadMoreMessages}
                />
              )}
            </View>
          ) : null}
        </GlassCard>

        {/* ---- ④ 动作区（关房=房间生命周期位；取消=D4 律师矩阵；终态隐藏——core 权威闸） ---- */}
        <SectionHeader
          title="场次动作"
          note="关房=结束房间进入结算；取消=按 D4 矩阵（时间窗×后果）"
        />
        <View style={styles.actionRow}>
          {roomOpenable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭房间"
              onPress={() => setPanel('close')}
              disabled={busyAction !== null}
              style={({ pressed }) => [
                styles.dangerBtn,
                (pressed || busyAction !== null) && styles.dangerPressed,
              ]}
            >
              <Text style={styles.dangerText}>关闭房间</Text>
            </Pressable>
          ) : (
            <MutedText>房间未开放（非 OPEN/IN_SERVICE 态无关闭动作——到点自动开房）</MutedText>
          )}
          {cancellable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="取消场次"
              onPress={() => setPanel('cancel')}
              disabled={busyAction !== null}
              style={({ pressed }) => [
                styles.dangerBtn,
                (pressed || busyAction !== null) && styles.dangerPressed,
              ]}
            >
              <Text style={styles.dangerText}>取消场次</Text>
            </Pressable>
          ) : (
            <MutedText>场次已终态（{sessionStatusCopy(s.status).label}）——不可取消</MutedText>
          )}
        </View>

        <MutedText>
          关房作用于房间（幂等键=场次）；取消作用于场次（幂等键=场次+角色）。房间号/会话号的
          自动关联接口补齐前，看板以直达输入承载（缺口已登记平台侧 triage）。
        </MutedText>
      </ScrollView>

      {/* 关房/取消确认面板（危险确认——绝对定位覆盖层，T4 同形态） */}
      {panel !== null ? (
        <View style={styles.panelOverlay}>
          <GlassCard style={styles.panelCardDanger}>
            {panel === 'close' ? (
              <>
                <Text style={styles.panelTitle}>关闭该房间？</Text>
                <MutedText>
                  房间关闭后成员不可再进入，场次进入结算流程（到场判定照常补判——判定与房间
                  生命周期正交）。已终态房间将返回 409（不可重复关闭）。
                </MutedText>
                <View style={styles.panelBtns}>
                  <Button label="再想想" variant="ghost" small onPress={() => setPanel(null)} />
                  <Button
                    label="确认关闭房间"
                    variant="primary"
                    small
                    busy={busyAction === 'close'}
                    onPress={runClose}
                  />
                </View>
              </>
            ) : (
              <>
                <Text style={styles.panelTitle}>取消该场次？</Text>
                {/* 矩阵参数（24h/-10/-30/20%/30 天窗）=rule_definitions cancel.matrix 版本化
                    参数——文案为 D4 模块文档口径快照，参数漂移时以规则中心现行版为准（修复环 I-2） */}
                <MutedText>
                  距开始 ≥24 小时：可直接取消——用户全额退款，信用 -10。距开始 &lt;24 小时：须
                  平台审批——通过后全额退款、信用 -30，并以场次总价 20% 违约金按支付占比补偿 用户。30
                  天内连续 2 次取消/缺席将暂停接单 7 天。
                </MutedText>
                <View style={styles.panelBtns}>
                  <Button label="再想想" variant="ghost" small onPress={() => setPanel(null)} />
                  <Button
                    label="确认取消场次"
                    variant="primary"
                    small
                    busy={busyAction === 'cancel'}
                    onPress={runCancel}
                  />
                </View>
              </>
            )}
          </GlassCard>
        </View>
      ) : null}
    </View>
  );
}

function InfoRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

/** 路由参数非法（无 id/非整数）：本地错误（不发出请求） */
class InvalidBoardIdError extends Error {
  constructor(raw: unknown) {
    super(`场次看板路由参数无效：${JSON.stringify(raw)}`);
    this.name = 'InvalidBoardIdError';
  }
}

const styles = StyleSheet.create({
  screenWrap: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  errorWrap: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
  headCard: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.sm },
  tagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tagGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  tagPrimary: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  tag: { color: colors.ink2, fontSize: fontSize.sm },
  headline: { color: colors.ink, fontSize: fontSize.xxl, fontWeight: fontWeight.semibold },
  divider: { height: 1, backgroundColor: colors.line },
  grid: { gap: spacing.sm },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  infoLabel: { color: colors.ink2, fontSize: fontSize.base },
  infoValue: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  progressTextRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  progressTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A18,
    overflow: 'hidden',
  },
  progressFill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.primary2 },
  directRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  directField: { flex: 1 },
  subBlock: { gap: spacing.xs },
  subTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  attRows: { gap: spacing.xs },
  attRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  attWho: { flexShrink: 1, gap: 2 },
  attId: { color: colors.ink, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  attJoin: { color: colors.ink2, fontSize: fontSize.xs },
  attStatus: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  /** 缺席=危险态小面积点缀（红深阶文字） */
  attStatusAbsent: { color: colors.accentDk },
  noticeBlock: { gap: spacing.xs },
  noticeTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  noticeDisc: { gap: 2, marginTop: spacing.xs },
  noticeDiscTitle: { color: colors.ink2, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  noticeDiscText: { color: colors.ink2, fontSize: fontSize.xs, lineHeight: 16 },
  noticeMeta: { color: colors.ink2, fontSize: fontSize.xs },
  msgList: { gap: spacing.sm },
  msgRow: { gap: 2 },
  msgRowSystem: { opacity: 0.85 },
  msgMeta: { color: colors.ink2, fontSize: fontSize.xs },
  msgContent: { color: colors.ink, fontSize: fontSize.sm, lineHeight: 19 },
  msgContentSystem: { color: colors.ink2, fontSize: fontSize.sm, lineHeight: 18 },
  actionRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  /** 危险动作钮=红描边（危险态点缀；主按钮位留给确认面板） */
  dangerBtn: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.dangerLine,
    paddingVertical: 7,
    paddingHorizontal: 16,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerPressed: { opacity: 0.7 },
  dangerText: { color: colors.accentDk, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  /** 动作失败横幅（危险描边+红深阶小字——小面积点缀位） */
  errorBanner: { padding: spacing.lg, gap: spacing.xs, borderColor: colors.dangerLine },
  errorBannerTitle: {
    color: colors.accentDk,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
  },
  errorBannerText: { color: colors.accentDk, fontSize: fontSize.sm, lineHeight: 18 },
  errorBannerMeta: { color: colors.ink2, fontSize: fontSize.xs },
  resultCard: { padding: spacing.lg, gap: spacing.sm },
  resultTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  resultClose: { alignSelf: 'flex-start' },
  resultCloseText: { color: colors.primary, fontSize: fontSize.sm },
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
  panelBtns: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
