/**
 * 发起拼团（M3-W1 T3，发团 tab 接管占位）：E3 问题树引导 → C2 发团表单 → POST /group-buys。
 *
 * - 问题树：GET /specialty/question-tree?key=labor_arbitration（公开只读）；404/未配置/空树
 *   → 空态引导（fail-visible，不造默认树）；可用时按树结构嵌套渲染多选（C2 §2 消费口径：
 *   节点 label 即 question_tags 词汇）+ 补充标签输入。
 * - 表单：lawyer_id 取自报名中场次（GET /sessions，V1 无公开律师列表面——T2 triage-2 缺口的
 *   保守取数口径）；slot_start/deadline 上海墙钟 → ISO；sub_min/sub_max（2..50，min≤max）。
 * - 成功页：{group_buy, share_price, payment_order}——分摊额大字红点缀、状态徽标、发起人支付单
 *   + dev 支付模拟器（EXPO_PUBLIC_DEV_PAY_SIM=1 才出现；C2 出参无 channel，按主通道缺省）。
 * 金额走 money 单一出口；状态/错误文案走映射表（trade-copy/error-messages）。
 */
import { useMemo, useState, type ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { isAppApiError } from '../api/client';
import { isDevPaySimEnabled, simulatePaySuccess } from '../api/dev-pay-sim';
import {
  GROUP_BUY_SUB_MAX,
  GROUP_BUY_SUB_MIN,
  publishGroupBuy,
  validatePublishInput,
  type PublishGroupBuyResult,
} from '../api/group-buys';
import { formatMoney } from '../api/money';
import { fetchSessions } from '../api/sessions';
import { specialtyCopy } from '../api/session-copy';
import {
  SPECIALTY_KEY_LABOR,
  fetchQuestionTree,
  isEmptyTree,
  treeNodeIndex,
} from '../api/specialty';
import { groupBuyStatusCopy, payOrderStatusCopy } from '../api/trade-copy';
import { useResource } from '../api/useResource';
import { ErrorPanel, LoadingHint } from '../components/state-views';
import { Button, ErrorText, Field, GlassCard, MutedText, ScreenTitle } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTimeFull } from '../utils/date';
import { isFutureInstant, toShanghaiIso } from '../utils/slot-input';

type Phase = 'guide' | 'form' | 'done';

export function PublishScreen() {
  const nav = useNavigation();
  const treeRes = useResource(() => fetchQuestionTree(SPECIALTY_KEY_LABOR), []);
  const sessionsRes = useResource(() => fetchSessions(), []);
  const [phase, setPhase] = useState<Phase>('guide');

  // 问题树多选（label 即 question_tags 词汇）+ 补充标签
  const [selectedLabels, setSelectedLabels] = useState<readonly string[]>([]);
  const [customTags, setCustomTags] = useState('');

  // 表单
  const [lawyerId, setLawyerId] = useState<number | null>(null);
  const [slotDate, setSlotDate] = useState('');
  const [slotTime, setSlotTime] = useState('');
  const [subMin, setSubMin] = useState('2');
  const [subMax, setSubMax] = useState('4');
  const [deadlineDate, setDeadlineDate] = useState('');
  const [deadlineTime, setDeadlineTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<PublishGroupBuyResult | null>(null);

  // 发起人支付（dev 模拟）
  const devSim = isDevPaySimEnabled();
  const [paying, setPaying] = useState(false);
  const [paidNote, setPaidNote] = useState<string | null>(null);

  const lawyers = useMemo(() => {
    if (sessionsRes.state.phase !== 'ready') return [] as readonly { id: number; city: string }[];
    const seen = new Map<number, string>();
    for (const s of sessionsRes.state.data) {
      if (!seen.has(s.lawyer_id)) seen.set(s.lawyer_id, s.city);
    }
    return [...seen].map(([id, city]) => ({ id, city }));
  }, [sessionsRes.state]);

  function toggleLabel(label: string): void {
    setSelectedLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  }

  async function handlePublish(): Promise<void> {
    setError(null);
    setErrorCode(null);
    const custom = customTags
      .split(/[,，、\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const slotStart = toShanghaiIso(slotDate.trim(), slotTime.trim());
    if (slotStart === null) {
      setError('咨询时间格式有误：日期须为 YYYY-MM-DD，时间须为 HH:mm（24 小时制）');
      return;
    }
    if (!isFutureInstant(slotStart)) {
      setError('咨询开始时间须晚于当前时刻');
      return;
    }
    if (lawyerId === null) {
      setError('请先选择目标律师（从报名中场次的执业律师中选择）');
      return;
    }
    let deadline: string | undefined;
    if (deadlineDate.trim() !== '' || deadlineTime.trim() !== '') {
      const parsed = toShanghaiIso(deadlineDate.trim(), deadlineTime.trim());
      if (parsed === null) {
        setError('截止时间格式有误：日期与时间须同时填写（YYYY-MM-DD + HH:mm）');
        return;
      }
      if (!isFutureInstant(parsed)) {
        setError('成团截止时间须晚于当前时刻（缺省为开始前 24 小时）');
        return;
      }
      deadline = parsed;
    }
    const input = {
      lawyer_id: lawyerId,
      specialty: SPECIALTY_KEY_LABOR,
      slot_start: slotStart,
      sub_min: Number(subMin),
      sub_max: Number(subMax),
      question_tags: [...selectedLabels, ...custom],
      deadline,
    };
    try {
      validatePublishInput(input); // 本地前置（core 值域镜像），坏输入不发请求
    } catch (e) {
      if (isAppApiError(e)) {
        setError(e.message);
        return;
      }
      throw e;
    }
    setSubmitting(true);
    try {
      const r = await publishGroupBuy(input);
      setResult(r);
      setPhase('done');
    } catch (e) {
      if (isAppApiError(e)) {
        setError(e.message);
        setErrorCode(e.code);
        return;
      }
      setError('操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSimPay(): Promise<void> {
    if (!result || !devSim) return;
    setPaying(true);
    try {
      const r = await simulatePaySuccess(result.payment_order.id);
      setPaidNote(
        r.inboxed
          ? '支付回调已受理（通道侧=支付成功）。发起人订单的成团推进以平台侧为准，可在「我的拼团」查看最新状态。'
          : '该订单支付回调已受理过（重复回调去重，语义=已受理）。',
      );
    } catch (e) {
      setPaidNote(null);
      setError(e instanceof Error ? e.message : '模拟支付失败');
    } finally {
      setPaying(false);
    }
  }

  // ----- 问题树引导 -----
  if (phase === 'guide') {
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel="发起拼团引导页"
      >
        <ScreenTitle>发起拼团 · {specialtyCopy(SPECIALTY_KEY_LABOR)}</ScreenTitle>
        <MutedText>
          先选择你遇到的问题（可多选，来自专项问题树引导），再填写拼团信息——拼团达到最低人数
          即由律师确认成团。
        </MutedText>

        {treeRes.state.phase === 'loading' ? <LoadingHint label="问题树加载中…" /> : null}
        {treeRes.state.phase === 'error' ? (
          // 评审 I1：加载失败/404 不做死端——与空树分支同口径给「跳过引导」出口
          // （404 E_NOT_FOUND=专项未配置，语义即空树档；其余错误同样可跳过，引导非发团必经）
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>问题树引导暂不可用</Text>
            <ErrorPanel error={treeRes.state.error} onRetry={treeRes.reload} />
            <MutedText>可先跳过引导直接手动填写拼团信息，稍后再回来使用引导。</MutedText>
            <Button label="跳过引导，手动填写" onPress={() => setPhase('form')} />
          </GlassCard>
        ) : null}
        {treeRes.state.phase === 'ready' ? (
          isEmptyTree(treeRes.state.data.questionTree) ? (
            <GlassCard style={styles.card}>
              <Text style={styles.cardTitle}>专项问题引导未配置</Text>
              <MutedText>
                该专项的问题树尚未配置（空树）。你可以跳过引导直接手动填写拼团信息，或稍后再来。
              </MutedText>
              <Button label="跳过引导，手动填写" onPress={() => setPhase('form')} />
            </GlassCard>
          ) : (
            <GlassCard style={styles.card}>
              <Text style={styles.cardTitle}>问题树引导 · 多选</Text>
              <TreeSelector
                tree={treeRes.state.data.questionTree}
                selected={selectedLabels}
                onToggle={toggleLabel}
              />
              <MutedText>
                已选 {selectedLabels.length}{' '}
                项（问题标签将随拼团发布给律师；也可在下一步补充自定义标签）
              </MutedText>
              <Button label="下一步 · 填写拼团信息" onPress={() => setPhase('form')} />
            </GlassCard>
          )
        ) : null}
      </ScrollView>
    );
  }

  // ----- 成功页 -----
  if (phase === 'done' && result) {
    const gb = result.group_buy;
    const statusCopy = groupBuyStatusCopy(gb.status);
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel="发起拼团成功页"
      >
        <GlassCard style={styles.successCard}>
          <View style={styles.statusRow}>
            <Text style={styles.successTitle}>拼团已发布</Text>
            <Text style={[styles.pill, styles.pillGrouped]}>{statusCopy.label}</Text>
          </View>
          <View style={styles.shareBlock}>
            <MutedText>每人分摊（发布时固化）</MutedText>
            <Text style={styles.sharePrice}>{formatMoney(result.share_price)}</Text>
          </View>
          <View style={styles.divider} />
          <MetaRow label="咨询时间" value={formatDateTimeFull(gb.slot_start)} />
          <MetaRow label="成团截止" value={formatDateTimeFull(gb.deadline)} />
          <MetaRow
            label="拼团人数"
            value={`${gb.sub_min}-${gb.sub_max} 人（${gb.sub_min} 人成团）`}
          />
          <MetaRow label="城市 · 专项" value={`${gb.city} · ${specialtyCopy(gb.specialty)}`} />
          <MetaRow
            label="问题标签"
            value={gb.question_tags.length > 0 ? gb.question_tags.join(' / ') : '未填写'}
          />
        </GlassCard>

        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>发起人支付单</Text>
          <MetaRow label="订单号" value={`#${result.payment_order.id}`} />
          <MetaRow label="应付" value={formatMoney(result.payment_order.cash_amount)} />
          <MetaRow label="订单状态" value={payOrderStatusCopy(result.payment_order.status).label} />
          {devSim ? (
            <Button
              label="模拟支付发起人订单（dev）"
              busy={paying}
              onPress={() => void handleSimPay()}
            />
          ) : (
            /* 评审 S7：用户可见文案中性化（env 配方在任务报告 §五，不进 UI 文案） */
            <MutedText>支付通道即将开放：发起人支付单已创建并保留，开放后将可完成支付。</MutedText>
          )}
          {paidNote ? <MutedText>{paidNote}</MutedText> : null}
          <ErrorText>{error}</ErrorText>
        </GlassCard>

        <Button
          label="查看我的拼团（我的 tab）"
          variant="ghost"
          small
          onPress={() => nav.setTab('me')}
        />
        <Button
          label="再发起一个拼团"
          variant="ghost"
          onPress={() => {
            setResult(null);
            setPaidNote(null);
            setError(null);
            setErrorCode(null);
            setSelectedLabels([]);
            setCustomTags('');
            setLawyerId(null);
            setSlotDate('');
            setSlotTime('');
            setSubMin('2');
            setSubMax('4');
            setDeadlineDate('');
            setDeadlineTime('');
            setPhase('guide');
          }}
        />
      </ScrollView>
    );
  }

  // ----- 表单 -----
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="发起拼团表单页"
    >
      <ScreenTitle>发起拼团 · 填写信息</ScreenTitle>

      <GlassCard style={styles.card}>
        <Text style={styles.cardTitle}>目标律师（报名中场次的执业律师）</Text>
        {sessionsRes.state.phase === 'loading' ? <LoadingHint /> : null}
        {sessionsRes.state.phase === 'error' ? (
          <ErrorPanel error={sessionsRes.state.error} onRetry={sessionsRes.reload} />
        ) : null}
        {sessionsRes.state.phase === 'ready' ? (
          lawyers.length === 0 ? (
            <MutedText>暂无报名中的场次可取律师（供给开通中），稍后再试。</MutedText>
          ) : (
            <View style={styles.chipWrap}>
              {lawyers.map((l) => (
                <Pressable
                  key={l.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: lawyerId === l.id }}
                  onPress={() => setLawyerId(l.id)}
                  style={[styles.chip, lawyerId === l.id && styles.chipOn]}
                >
                  <Text style={[styles.chipText, lawyerId === l.id && styles.chipTextOn]}>
                    律师 #{l.id} · {l.city}
                  </Text>
                </Pressable>
              ))}
            </View>
          )
        ) : null}
        <MutedText>分摊额=该律师默认场次总价 ÷ 最低人数（发布时固化，律师改价不影响）。</MutedText>
      </GlassCard>

      <GlassCard style={styles.card}>
        <Text style={styles.cardTitle}>咨询时间（上海时间）</Text>
        <View style={styles.duoRow}>
          <Field
            value={slotDate}
            onChangeText={(t) => setSlotDate(t.slice(0, 10))}
            placeholder="YYYY-MM-DD"
            accessibilityLabel="咨询日期输入框"
            style={styles.duoField}
          />
          <Field
            value={slotTime}
            onChangeText={(t) => setSlotTime(t.slice(0, 5))}
            placeholder="HH:mm"
            accessibilityLabel="咨询时间输入框"
            style={styles.duoField}
          />
        </View>
        <Text style={styles.cardTitle}>成团截止（可选，缺省=开始前 24 小时）</Text>
        <View style={styles.duoRow}>
          <Field
            value={deadlineDate}
            onChangeText={(t) => setDeadlineDate(t.slice(0, 10))}
            placeholder="YYYY-MM-DD"
            accessibilityLabel="截止日期输入框"
            style={styles.duoField}
          />
          <Field
            value={deadlineTime}
            onChangeText={(t) => setDeadlineTime(t.slice(0, 5))}
            placeholder="HH:mm"
            accessibilityLabel="截止时间输入框"
            style={styles.duoField}
          />
        </View>
      </GlassCard>

      <GlassCard style={styles.card}>
        <Text style={styles.cardTitle}>拼团人数（成团最低-最高）</Text>
        <View style={styles.duoRow}>
          <Field
            value={subMin}
            onChangeText={(t) => setSubMin(t.replace(/[^\d]/g, '').slice(0, 2))}
            keyboardType="number-pad"
            accessibilityLabel="最低人数输入框"
            style={styles.duoField}
          />
          <Field
            value={subMax}
            onChangeText={(t) => setSubMax(t.replace(/[^\d]/g, '').slice(0, 2))}
            keyboardType="number-pad"
            accessibilityLabel="最高人数输入框"
            style={styles.duoField}
          />
        </View>
        <MutedText>
          人数域 {GROUP_BUY_SUB_MIN}-{GROUP_BUY_SUB_MAX}，且须在律师接受的拼团范围内；人数发布后
          不可修改，只能取消后重新发起。
        </MutedText>
      </GlassCard>

      <GlassCard style={styles.card}>
        <Text style={styles.cardTitle}>问题标签（问题树已选 {selectedLabels.length} 项）</Text>
        {selectedLabels.length > 0 ? (
          <View style={styles.chipWrap}>
            {selectedLabels.map((label) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                onPress={() => toggleLabel(label)}
                style={[styles.chip, styles.chipOn]}
              >
                <Text style={[styles.chipText, styles.chipTextOn]}>{label} ×</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <MutedText>未从问题树选择（可返回上一步选择，或在下方补充）。</MutedText>
        )}
        <Field
          value={customTags}
          onChangeText={setCustomTags}
          placeholder="补充问题标签（逗号/顿号分隔）"
          accessibilityLabel="补充标签输入框"
        />
      </GlassCard>

      <ErrorText>{error}</ErrorText>
      {errorCode ? <MutedText>code={errorCode}</MutedText> : null}
      <Button
        label={submitting ? '发布中…' : '发布拼团'}
        busy={submitting}
        onPress={() => void handlePublish()}
      />
      <Button label="返回问题引导" variant="ghost" small onPress={() => setPhase('guide')} />
    </ScrollView>
  );
}

/** 问题树递归选择器（root 为引导题干不选；其余节点多选，children 缩进嵌套展示） */
/** 递归渲染防环兜底（评审 S5）：夹具直插可绕过 core 连通性/无环校验，带环数据会栈溢出白屏 */
const TREE_RENDER_MAX_DEPTH = 16;

function TreeSelector({
  tree,
  selected,
  onToggle,
}: {
  readonly tree: {
    readonly root: string;
    readonly nodes: readonly { id: string; label: string; children: readonly string[] }[];
  };
  readonly selected: readonly string[];
  readonly onToggle: (label: string) => void;
}) {
  const index = useMemo(() => treeNodeIndex(tree), [tree]);
  const renderNode = (
    id: string,
    depth: number,
    path: ReadonlySet<string>,
  ): ReactElement | null => {
    const node = index.get(id);
    if (!node) return null;
    // 深度上限 + 路径 visited（按分支复制集合：兄弟分支互不误判）——环数据截断渲染不炸栈
    if (depth >= TREE_RENDER_MAX_DEPTH || path.has(id)) return null;
    const isOn = selected.includes(node.label);
    const childPath = new Set(path);
    childPath.add(id);
    return (
      <View key={node.id} style={[styles.treeNode, { marginLeft: depth * spacing.lg }]}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isOn }}
          onPress={() => onToggle(node.label)}
          style={[styles.chip, isOn && styles.chipOn]}
        >
          <Text style={[styles.chipText, isOn && styles.chipTextOn]}>{node.label}</Text>
        </Pressable>
        {node.children.map((child) => renderNode(child, depth + 1, childPath))}
      </View>
    );
  };
  const root = index.get(tree.root);
  return (
    <View style={styles.treeWrap}>
      {root ? <Text style={styles.treeRootLabel}>{root.label}</Text> : null}
      {root ? root.children.map((child) => renderNode(child, 0, new Set([tree.root]))) : null}
    </View>
  );
}

function MetaRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.md },
  cardTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  successCard: {
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.accentCard, // 红点缀焦点卡（一组仅 1 张）
    borderColor: colors.dangerLine,
  },
  successTitle: { color: colors.accentDk, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  shareBlock: { gap: 2 },
  sharePrice: { color: colors.accentDk, fontSize: fontSize.xxxl, fontWeight: fontWeight.bold },
  divider: { height: 1, backgroundColor: colors.line },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  metaLabel: { color: colors.ink2, fontSize: fontSize.base },
  metaValue: {
    color: colors.ink,
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
    flexShrink: 1,
    textAlign: 'right',
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primary2A15,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primary2A15 },
  chipText: { color: colors.ink, fontSize: fontSize.md },
  chipTextOn: { color: colors.primary, fontWeight: fontWeight.semibold },
  duoRow: { flexDirection: 'row', gap: spacing.md },
  duoField: { flex: 1 },
  treeWrap: { gap: spacing.xs },
  treeRootLabel: { color: colors.ink2, fontSize: fontSize.md, marginBottom: spacing.xs },
  treeNode: { gap: spacing.xs },
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.pill,
    fontSize: fontSize.sm,
    overflow: 'hidden',
  },
  pillGrouped: { color: colors.primary, backgroundColor: colors.primary2A15 },
});
