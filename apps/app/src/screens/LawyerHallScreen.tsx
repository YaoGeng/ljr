/**
 * 接单大厅（M3-W2 T4，tab 屏替换 T1 占位；对照原型 l-hall「拼团指定」档）：C2B 响应链
 * 两面 + 三动作——
 *   ① 待响应（GET /lawyer/group-buys?status=PENDING_LAWYER）：指定自己的已成团待确认任务
 *      （12h 确认窗倒计时=lawyer_confirm_by 锚经 formatConfirmWindow，回前台重算——评审 N-5）
 *      ——确认接单（POST confirm → 生成 mode=C2B 履约场次）/ 婉拒（POST reject，确认面板
 *      ——用户全额退款+信用 -5，R-01）；首卡=accentCard 焦点卡（一组仅 1 张）；
 *   ② 大厅 · 拼团中的 C2B 团（GET /group-buys 公开列表=PUBLISHED）按归属分流（评审 I-1：
 *      core convert 归属守卫=非本人 lawyer_id 恒 404——group-buy-response.service
 *      lockRowForUpdate 404 分支）：指定给我的团（lawyer_id===me.id）显认领转化钮
 *      （POST convert → 新 B2C 场次；确认面板承载 R-02/R-03 迁移语义），其他律师的团
 *      隐藏钮+「已指定律师」标注（仅展示）；转化成功 push sessionDetail（T3 接缝复用）；
 *   ③ 我的响应：/lawyer/group-buys 即「待我响应」面（§5 仅 PENDING_LAWYER 一档）——
 *      已响应历史（CONFIRMED/REJECTED/CONVERTED）无列表端点（契约缺口，与 #48-④ 同族），
 *      以注记如实告知；响应统计在工作台（T2 已接，不同端点勿混）。
 *
 * 409 语义（C4 §5）：E_NOT_REACHED/E_NOT_PENDING/E_NOT_CONVERTIBLE=状态不符（已被响应/
 * 超窗/未成团）→ error-messages 映射文案 + 双列表自动刷新收口（幂等重放=同键同果非错）。
 * 动作失败反馈=屏顶错误横幅（评审 I-2：409 意味着该团已离开待确认面——刷新后卡片消失，
 * 卡内错误行无处挂载；横幅不依赖卡片存活）。
 * 设计铁律：红点缀=首张待响应焦点卡+价格数字+确认主按钮+婉拒危险描边，余橄榄绿系。
 */
import { useEffect, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { isAppApiError } from '../api/client';
import { fetchGroupBuys, type GroupBuyView } from '../api/group-buys';
import { splitMoney } from '../api/money';
import {
  confirmGroupBuy,
  convertGroupBuy,
  fetchLawyerHallGroupBuys,
  formatConfirmWindow,
  rejectGroupBuy,
} from '../api/lawyer-group-buys';
import { specialtyCopy } from '../api/session-copy';
import { lawyerGroupBuyStatusCopy } from '../api/trade-copy';
import { useResource } from '../api/useResource';
import { useSession } from '../api/useSession';
import { TradeBadge } from '../components/enrollment-row';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { Button, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTime } from '../utils/date';

/** 动作确认面板（婉拒=危险确认；认领转化=迁移语义确认——原型 confirm2 对应物） */
type ActionPanel =
  | { readonly kind: 'reject'; readonly gb: GroupBuyView }
  | { readonly kind: 'convert'; readonly gb: GroupBuyView };

/** 动作结果横幅（确认/转化带 session_id 可跳场次详情——T3 接缝） */
type HallResult =
  | { readonly kind: 'confirmed'; readonly gbId: number; readonly sessionId: number }
  | { readonly kind: 'rejected'; readonly gbId: number }
  | { readonly kind: 'converted'; readonly gbId: number; readonly sessionId: number };

interface ActionErrorView {
  readonly id: number;
  readonly message: string;
  readonly code: string;
}

export function LawyerHallScreen() {
  const nav = useNavigation();
  const me = useSession().me;

  const pending = useResource(() => fetchLawyerHallGroupBuys(), []);
  const openHall = useResource(() => fetchGroupBuys(), []);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [panel, setPanel] = useState<ActionPanel | null>(null);
  const [result, setResult] = useState<HallResult | null>(null);
  const [actionError, setActionError] = useState<ActionErrorView | null>(null);

  // 回前台重算 12h 倒计时（评审 N-5）：AppState active → 触发重渲染即按当前钟重算
  // formatConfirmWindow（render 时求值）；不做秒级 ticker——窗尺度 12h，报告 §二-6 决策
  const [, setFocusTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setFocusTick((t) => t + 1);
    });
    return () => sub.remove();
  }, []);

  if (!me) {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <GlassCard style={styles.card}>
          <Text style={styles.missingTitle}>登录态缺失</Text>
          <MutedText>请退出后重新登录再使用接单大厅</MutedText>
        </GlassCard>
      </ScrollView>
    );
  }

  function toActionError(id: number, e: unknown): ActionErrorView {
    if (isAppApiError(e)) return { id, message: e.message, code: e.code };
    return { id, message: '操作失败，请稍后重试', code: 'UNKNOWN' };
  }

  /** 动作收口：成功=结果横幅+双列表刷新；失败=错误视图+刷新（409=列表已陈旧，刷新对齐） */
  async function runAction(id: number, job: () => Promise<HallResult>): Promise<void> {
    setBusyId(id);
    setActionError(null);
    try {
      const r = await job();
      setResult(r);
      pending.reload();
      openHall.reload();
    } catch (e) {
      setActionError(toActionError(id, e));
      pending.reload();
      openHall.reload();
    } finally {
      setBusyId(null);
    }
  }

  function runConfirm(gb: GroupBuyView): void {
    void runAction(gb.id, async () => {
      const { session_id } = await confirmGroupBuy(gb.id);
      return { kind: 'confirmed', gbId: gb.id, sessionId: session_id };
    });
  }

  function runReject(gb: GroupBuyView): void {
    setPanel(null);
    void runAction(gb.id, async () => {
      await rejectGroupBuy(gb.id);
      return { kind: 'rejected', gbId: gb.id };
    });
  }

  function runConvert(gb: GroupBuyView): void {
    setPanel(null);
    void runAction(gb.id, async () => {
      const { session_id } = await convertGroupBuy(gb.id);
      return { kind: 'converted', gbId: gb.id, sessionId: session_id };
    });
  }

  const pendingRows = pending.state.phase === 'ready' ? pending.state.data : [];
  // 归属分流（评审 I-1）：公开面仅指定给我的团可认领转化（core convert 非本人恒 404）；
  // 其他律师的团=浏览行（已指定律师标注）——W1 filterInitiatedBy 客户端过滤同款先例
  const hallMine =
    openHall.state.phase === 'ready'
      ? openHall.state.data.filter((g) => g.lawyer_id === me.id)
      : [];
  const hallOthers =
    openHall.state.phase === 'ready'
      ? openHall.state.data.filter((g) => g.lawyer_id !== me.id)
      : [];

  return (
    <View style={styles.screenWrap}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel="接单大厅"
      >
        {/* 动作失败横幅（评审 I-2：屏顶承载不依赖卡片存活——409 后刷新该团已离列） */}
        {actionError !== null ? (
          <GlassCard style={styles.errorBanner}>
            <Text style={styles.errorBannerTitle}>操作未完成</Text>
            <Text style={styles.errorBannerText}>{actionError.message}</Text>
            <Text style={styles.errorBannerMeta}>
              拼团 #{actionError.id}
              {actionError.code !== 'UNKNOWN' ? ` · code=${actionError.code}` : ''} ·
              列表已刷新对齐最新状态
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

        {/* 动作结果横幅（确认/转化可跳场次详情；婉拒=退款+信用后果回执） */}
        {result !== null ? (
          <GlassCard style={styles.resultCard}>
            <Text style={styles.resultTitle}>{resultCopy(result)}</Text>
            {result.kind !== 'rejected' ? (
              <Button
                label={result.kind === 'confirmed' ? '查看履约场次' : '查看 B2C 场次'}
                variant="secondary"
                small
                onPress={() => nav.push({ key: 'sessionDetail', params: { id: result.sessionId } })}
              />
            ) : null}
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

        {/* ---- ① 待响应（指定我的拼团；12h 确认窗） ---- */}
        <SectionHeader
          title="待响应 · 指定我的拼团"
          note="成团后 12h 内须确认（超时=自动拒绝：全额退款用户+信用 -5，R-01）；响应统计见工作台"
          actionLabel="刷新"
          onAction={pending.reload}
        />
        {pending.state.phase === 'loading' ? <LoadingHint label="待响应列表加载中…" /> : null}
        {pending.state.phase === 'error' ? (
          <ErrorPanel error={pending.state.error} onRetry={pending.reload} />
        ) : null}
        {pending.state.phase === 'ready' ? (
          pendingRows.length === 0 ? (
            <EmptyHint text="暂无待响应的拼团——用户发起的拼团成团后将出现在这里" />
          ) : (
            <View style={styles.list}>
              {pendingRows.map((gb, i) => (
                <PendingCard
                  key={gb.id}
                  gb={gb}
                  focal={i === 0}
                  busy={busyId === gb.id}
                  onConfirm={() => runConfirm(gb)}
                  onReject={() => setPanel({ kind: 'reject', gb })}
                />
              ))}
            </View>
          )
        ) : null}

        {/* ---- ② 指定给我的拼团中团（公开面 PUBLISHED；未成团即可提前认领转化——评审 I-1） ---- */}
        <SectionHeader
          title="指定给我的拼团中团 · 可提前转化"
          note="未成团即可认领转为你的公开 B2C 场次（提前接单口径）；成团后进入上方「待响应」面"
          actionLabel="刷新"
          onAction={openHall.reload}
        />
        {openHall.state.phase === 'loading' ? <LoadingHint label="大厅列表加载中…" /> : null}
        {openHall.state.phase === 'error' ? (
          <ErrorPanel error={openHall.state.error} onRetry={openHall.reload} />
        ) : null}
        {openHall.state.phase === 'ready' ? (
          hallMine.length === 0 ? (
            <EmptyHint text="暂无指定给你的拼团中团——用户对你发起拼团后将出现在这里" />
          ) : (
            <View style={styles.list}>
              {hallMine.map((gb) => (
                <HallCard
                  key={gb.id}
                  gb={gb}
                  convertible
                  busy={busyId === gb.id}
                  onConvert={() => setPanel({ kind: 'convert', gb })}
                />
              ))}
            </View>
          )
        ) : null}

        {/* ---- ③ 其他律师的拼团中团（浏览行——已指定律师，转化归属非本人 404） ---- */}
        {openHall.state.phase === 'ready' && hallOthers.length > 0 ? (
          <>
            <SectionHeader
              title="其他律师的拼团中团"
              note="全平台公开 C2B 团（已指定律师——仅展示，不可代接/代转化）"
            />
            <View style={styles.list}>
              {hallOthers.map((gb) => (
                <HallCard
                  key={gb.id}
                  gb={gb}
                  convertible={false}
                  busy={false}
                  onConvert={() => undefined}
                />
              ))}
            </View>
          </>
        ) : null}

        <MutedText>
          已响应历史（已接单/已婉拒/已转化）列表接口未开放——已确认/已转化的履约场次请从工作台
          近期场次与场次管理进入；参与者维持快照价迁移、新加入按 B2C 定价（R-02）。
        </MutedText>
      </ScrollView>

      {/* 婉拒/认领转化确认面板（绝对定位覆盖层——T2 I-4 形态） */}
      {panel !== null ? (
        <View style={styles.panelOverlay}>
          <GlassCard style={panel.kind === 'reject' ? styles.panelCardDanger : styles.panelCard}>
            {panel.kind === 'reject' ? (
              <>
                <Text style={styles.panelTitle}>婉拒该拼团？</Text>
                <MutedText>
                  婉拒后：用户全额退款；你的信用分 -5；时间段占用锁释放；该任务转为已拒绝，用户可
                  改投其他律师（超时未响应同后果：自动拒绝，R-01）。
                </MutedText>
                <View style={styles.panelBtns}>
                  <Button label="再想想" variant="ghost" small onPress={() => setPanel(null)} />
                  <Button
                    label="确认婉拒（信用 -5）"
                    variant="primary"
                    small
                    busy={busyId === panel.gb.id}
                    onPress={() => runReject(panel.gb)}
                  />
                </View>
              </>
            ) : (
              <>
                <Text style={styles.panelTitle}>认领转化为 B2C 场次？</Text>
                <MutedText>
                  该团将转为你的公开 B2C 场次：原参与者维持快照价迁移（不搬家款）；新加入者按你的
                  B2C 定价；被迁移用户 24h 内可申请退款（R-02/R-03）。容量缺省=该团子范围上限
                  {` ${panel.gb.sub_max} `}人，价格缺省=你的默认价格。
                </MutedText>
                <View style={styles.panelBtns}>
                  <Button label="取消" variant="ghost" small onPress={() => setPanel(null)} />
                  <Button
                    label="确认认领转化"
                    variant="primary"
                    small
                    busy={busyId === panel.gb.id}
                    onPress={() => runConvert(panel.gb)}
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

/** 结果横幅文案（单源小函数——状态文案禁散写三元的同款纪律） */
function resultCopy(r: HallResult): string {
  if (r.kind === 'confirmed') return `已接单 · 履约场次 #${r.sessionId} 已生成，时间段已锁定`;
  if (r.kind === 'converted') return `已认领转化 · B2C 场次 #${r.sessionId} 已生成`;
  return '已婉拒 · 用户全额退款已发起，信用 -5 已记录';
}

/** 12h 确认窗行（PENDING_LAWYER 恒有 lawyer_confirm_by；null=形态漂移显 '—' 不造假） */
function confirmWindowLine(gb: GroupBuyView): string {
  return gb.lawyer_confirm_by === null
    ? '确认窗信息缺失（—）'
    : `${formatConfirmWindow(gb.lawyer_confirm_by)}（超时自动拒绝）`;
}

/** 待响应卡人数行（大厅面 joined=已支付参与者数真值；null=形态漂移显 '—'） */
function joinedLine(gb: GroupBuyView): string {
  const joined = gb.joined === null ? '—' : String(gb.joined);
  return `子范围 ${gb.sub_min}-${gb.sub_max} 人 · 已加入 ${joined} 人（成团线 ${gb.sub_min}）`;
}

/** 大厅卡截止行（公开列表 joined 恒 null 桩——不展示已加入数，只展示成团目标/截止） */
function hallDeadlineLine(gb: GroupBuyView): string {
  return `目标 ${gb.sub_min}-${gb.sub_max} 人成团 · 截止 ${formatDateTime(gb.deadline, {
    weekday: false,
  })}`;
}

/** 通用信息块（两张卡共用：开场/上下文行/标签/价格；meta 由调用方组行） */
function GbInfoBlock({ gb, meta }: { readonly gb: GroupBuyView; readonly meta: string }) {
  const p = splitMoney(gb.share_price);
  return (
    <>
      <Text style={styles.headline}>{`${formatDateTime(gb.slot_start)} 开场`}</Text>
      <Text style={styles.meta}>{meta}</Text>
      {gb.question_tags.length > 0 ? (
        <Text style={styles.tags} numberOfLines={1}>
          {`问题标签：${gb.question_tags.join(' · ')}`}
        </Text>
      ) : null}
      <View style={styles.priceRow}>
        <Text style={styles.priceSymbol}>{p.symbol}</Text>
        <Text style={styles.priceInt}>{p.int}</Text>
        <Text style={styles.priceDec}>{p.decWithDot}</Text>
        <Text style={styles.priceSuffix}>/人 分摊 · 收入=分摊×实际人数</Text>
      </View>
    </>
  );
}

/** 待响应卡（focal=首卡红点缀焦点卡一组仅 1 张；确认=主按钮、婉拒=危险描边小钮；
 *  动作错误走屏顶横幅——评审 I-2，卡内不再挂错误行） */
function PendingCard({
  gb,
  focal,
  busy,
  onConfirm,
  onReject,
}: {
  readonly gb: GroupBuyView;
  readonly focal: boolean;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onReject: () => void;
}) {
  return (
    <GlassCard style={[styles.card, focal && styles.focalCard]}>
      <View style={styles.tagRow}>
        <View style={styles.tagGroup}>
          <Text style={styles.tagPrimary}>{`${specialtyCopy(gb.specialty)} · C2B 指定你接单`}</Text>
          <Text style={styles.tag}>{gb.city}</Text>
        </View>
        <TradeBadge copy={lawyerGroupBuyStatusCopy(gb.status)} />
      </View>
      <GbInfoBlock gb={gb} meta={joinedLine(gb)} />
      <Text style={styles.windowLine}>{confirmWindowLine(gb)}</Text>
      <View style={styles.actionRow}>
        <Button label="确认接单" busy={busy} onPress={onConfirm} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`婉拒拼团 ${gb.id}`}
          onPress={onReject}
          disabled={busy}
          style={({ pressed }) => [styles.rejectBtn, (pressed || busy) && styles.rejectPressed]}
        >
          <Text style={styles.rejectText}>婉拒</Text>
        </Pressable>
      </View>
    </GlassCard>
  );
}

/** 大厅卡（PUBLISHED 团；convertible=指定给我→转化钮，非本人→「已指定律师」标注——评审 I-1；
 *  认领转化=次按钮——主按钮位留给待响应确认） */
function HallCard({
  gb,
  convertible,
  busy,
  onConvert,
}: {
  readonly gb: GroupBuyView;
  readonly convertible: boolean;
  readonly busy: boolean;
  readonly onConvert: () => void;
}) {
  return (
    <GlassCard style={styles.card}>
      <View style={styles.tagRow}>
        <View style={styles.tagGroup}>
          <Text style={styles.tagPrimary}>{`${specialtyCopy(gb.specialty)} · C2B 拼团`}</Text>
          <Text style={styles.tag}>{gb.city}</Text>
        </View>
        <TradeBadge copy={lawyerGroupBuyStatusCopy(gb.status)} />
      </View>
      <GbInfoBlock gb={gb} meta={hallDeadlineLine(gb)} />
      {convertible ? (
        <Button label="认领转化为 B2C 场次" variant="secondary" busy={busy} onPress={onConvert} />
      ) : (
        <Text style={styles.designatedNote}>已指定律师 · 仅展示</Text>
      )}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  screenWrap: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  list: { gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.sm },
  /** 首张待响应焦点卡（点缀卡底 rgba(194,94,94,.15)——一组仅 1 张，原型 l-hall acc 卡对应物） */
  focalCard: { backgroundColor: colors.accentCard },
  missingTitle: { color: colors.ink, fontSize: fontSize.xl, fontWeight: fontWeight.semibold },
  /** 动作失败横幅（评审 I-2）：危险态红深阶文字+危险描边（小面积点缀位） */
  errorBanner: {
    padding: spacing.lg,
    gap: spacing.xs,
    borderColor: colors.dangerLine,
  },
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
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  tagGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  tagPrimary: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  tag: { color: colors.ink2, fontSize: fontSize.sm },
  headline: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  meta: { color: colors.ink2, fontSize: fontSize.sm },
  tags: { color: colors.ink2, fontSize: fontSize.sm },
  /** 12h 确认窗行（紧迫信号=红深阶小字，点缀小面积位） */
  windowLine: { color: colors.accentDk, fontSize: fontSize.sm },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end' },
  priceSymbol: { color: colors.accent, fontSize: fontSize.md, marginBottom: 1 },
  priceInt: { color: colors.accent, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  priceDec: { color: colors.accent, fontSize: fontSize.base, marginBottom: 1 },
  priceSuffix: { color: colors.ink2, fontSize: fontSize.sm, marginBottom: 2, marginLeft: 2 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  /** 婉拒=危险描边小钮（红细边+红字=危险态点缀；非实心红——主按钮位留给确认接单） */
  rejectBtn: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.dangerLine,
    paddingVertical: 7,
    paddingHorizontal: 16,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectPressed: { opacity: 0.7 },
  rejectText: { color: colors.accentDk, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  /** 非本人团标注（评审 I-1：已指定律师——灰档中性，非危险态） */
  designatedNote: { color: colors.ink2, fontSize: fontSize.sm },
  /** 确认面板覆盖层（T2 I-4 形态：米白绿半透遮罩+居中面板） */
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
  panelCard: { padding: spacing.lg, gap: spacing.sm, width: '100%', maxWidth: 330 },
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
